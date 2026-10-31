import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_RESPONSE = 8 * 1024 * 1024;
const POLL_TIMEOUT = 10 * 60 * 1000;
const env = process.env;
const fail = (message) => { throw new Error(message); };
const required = (name) => {
  const value = env[name];
  if (!value || /[\r\n\0]/.test(value)) fail(`Invalid or missing ${name}.`);
  return value;
};
const messageEscape = (s) => String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const propertyEscape = (s) => messageEscape(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function apiBase(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('Invalid API URL.'); }
  if (url.username || url.password || url.search || url.hash) fail('API URL must not contain credentials, a query or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('API URL must use HTTPS, except for a local reference server.');
  return url.toString().replace(/\/+$/, '');
}

function validateInputs() {
  const token = (env.GUARANI_TOKEN ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!token || !/^[\x21-\x7E]+$/.test(token)) fail('Invalid or missing workspace token.');
  const repo = required('INPUT_REPO');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail('Repository must be in owner/name format.');
  const ref = required('INPUT_REF');
  const profile = required('INPUT_PROFILE');
  const report = required('INPUT_REPORT');
  if (!['github', 'gitlab', 'markdown'].includes(report)) fail('Report must be github, gitlab or markdown.');
  const url = apiBase(required('INPUT_API_URL'));
  return { token, repo, ref, profile, report, url };
}

function validateResult(result, input, id) {
  if (!isRecord(result) || typeof result.id !== 'string' || !/^ver_[0-9A-Z]{12}$/.test(result.id)) fail('Verification response has an invalid run ID.');
  if (id && result.id !== id) fail('Verification response has a mismatched run ID.');
  for (const key of ['repo', 'ref', 'profile']) {
    if (result[key] !== undefined && result[key] !== input[key]) fail(`Verification response has a mismatched ${key}.`);
  }
  if (!['CLEARED', 'HOLD'].includes(result.verdict) || !Array.isArray(result.findings)) fail('Completed verification is missing a valid verdict or findings.');
  if (result.findings.some((f) => !isRecord(f))) fail('Verification contains invalid findings.');
  return result;
}

function cliAvailable() {
  const probe = spawnSync('guarani', ['--help'], { stdio: 'ignore', timeout: 10_000, windowsHide: true });
  return !probe.error || probe.error.code !== 'ENOENT';
}

function runCli(input) {
  // The reference CLI prioritizes --report over --json, so --report would hide
  // the full result, including its id and findings. Request JSON once instead.
  const p = spawnSync('guarani', ['verify', '--repo', input.repo, '--ref', input.ref, '--profile', input.profile, '--json'], {
    encoding: 'utf8', maxBuffer: MAX_RESPONSE, timeout: POLL_TIMEOUT + 30_000, windowsHide: true,
    env: { ...env, GUARANI_TOKEN: input.token, GUARANI_BASE_URL: input.url },
  });
  if (p.error || ![0, 1].includes(p.status)) fail('Guarani CLI failed to complete the verification.');
  let result;
  try { result = JSON.parse(p.stdout); } catch { fail('Guarani CLI did not return a valid JSON verification.'); }
  validateResult(result, input);
  // The reference CLI JSON has no status, but a status supplied by another CLI
  // must represent a completed verification.
  if (result.status !== undefined && result.status !== 'completed') fail('Guarani CLI returned a verification that is not completed.');
  if (p.status !== (result.verdict === 'CLEARED' ? 0 : 1)) fail('Guarani CLI exit code does not match its verdict.');
  return result;
}

async function responseJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE) fail('API response is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('API returned invalid JSON.'); }
}

async function request(input, path, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(`${input.url}${path}`, {
        ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${input.token}`, accept: 'application/json', ...options.headers },
      });
    } catch {
      if (attempt === 2) fail('Verification API network request failed.');
      await delay(Math.floor(Math.random() * (250 * 2 ** attempt)));
      continue;
    }
    if (response.ok) return responseJson(response);
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2) fail(`Verification API returned HTTP ${response.status}.`);
    const retryAfter = response.headers.get('retry-after');
    let wait = Math.floor(Math.random() * (250 * 2 ** attempt));
    if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) wait = Math.min(Number(retryAfter) * 1000, 60_000);
    else if (retryAfter && !Number.isNaN(Date.parse(retryAfter))) wait = Math.min(Math.max(Date.parse(retryAfter) - Date.now(), 0), 60_000);
    await response.body?.cancel();
    await delay(wait);
  }
  fail('Verification API network request failed.');
}

async function runRest(input) {
  const run = required('GITHUB_RUN_ID');
  const attempt = required('GITHUB_RUN_ATTEMPT');
  const key = `${run}-${attempt}-${input.profile}`;
  if (!/^[\x20-\x7e]{1,255}$/.test(key)) fail('Invalid idempotency key.');
  const created = await request(input, '/verifications', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ repo: input.repo, ref: input.ref, profile: input.profile }),
  });
  if (!isRecord(created) || typeof created.id !== 'string' || !/^ver_[0-9A-Z]{12}$/.test(created.id)) fail('API returned an invalid run ID.');
  for (const key of ['repo', 'ref', 'profile']) if (created[key] !== undefined && created[key] !== input[key]) fail(`Created verification has a mismatched ${key}.`);
  const deadline = performance.now() + POLL_TIMEOUT;
  let wait = 1000;
  while (performance.now() < deadline) {
    const result = await request(input, `/verifications/${created.id}`);
    if (!isRecord(result) || result.id !== created.id) fail('API returned a mismatched run ID.');
    for (const key of ['repo', 'ref', 'profile']) if (result[key] !== undefined && result[key] !== input[key]) fail(`Verification response has a mismatched ${key}.`);
    if (result.status === 'completed') return validateResult(result, input, created.id);
    if (result.status === 'failed') fail('Verification run failed without a verdict.');
    if (!['queued', 'running'].includes(result.status)) fail('Verification API returned an unknown run status.');
    if (performance.now() + wait >= deadline) break;
    await delay(wait);
    wait = Math.min(wait * 2, 10_000);
  }
  fail('Timed out waiting for the verification verdict.');
}

function annotate(result) {
  const deciding = new Set(Array.isArray(result.decided_by) ? result.decided_by : []);
  for (const f of result.findings) {
    const level = deciding.has(f.id) && result.verdict === 'HOLD' ? 'error' : ['blocking', 'warning'].includes(f.severity) ? 'warning' : 'notice';
    const properties = [];
    if (isRecord(f.location) && typeof f.location.path === 'string' && f.location.path) {
      properties.push(`file=${propertyEscape(f.location.path)}`);
      if (Number.isSafeInteger(f.location.start_line) && f.location.start_line > 0) properties.push(`line=${f.location.start_line}`);
      if (Number.isSafeInteger(f.location.end_line) && f.location.end_line >= f.location.start_line) properties.push(`endLine=${f.location.end_line}`);
    }
    if (isRecord(f.rule) && typeof f.rule.id === 'string') properties.push(`title=${propertyEscape(f.rule.id)}`);
    const message = typeof f.message === 'string' ? f.message : 'Guarani Verify finding';
    console.log(`::${level}${properties.length ? ' ' + properties.join(',') : ''}::${messageEscape(message)}`);
  }
}

async function main() {
  const input = validateInputs();
  const result = cliAvailable() ? runCli(input) : await runRest(input);
  annotate(result);
  appendFileSync(required('GITHUB_OUTPUT'), `id=${result.id}\nverdict=${result.verdict}\nfindings_count=${result.findings.length}\n`, 'utf8');
  console.log(`Guarani Verify: ${result.verdict}; findings: ${result.findings.length}`);
  process.exitCode = result.verdict === 'HOLD' ? 1 : 0;
}

main().catch((error) => {
  // Never print response bodies, tokens, or arbitrary child-process diagnostics.
  console.error(`::error::${messageEscape(error instanceof Error ? error.message : 'Verification failed.')}`);
  process.exitCode = 1;
});
