import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url)));
const fixtureId = 'ver_01JB7Q4M2XK8';
const input = { repo: 'example/repo', ref: 'refs/pull/3/head', profile: 'pull-request' };

async function run(extra = {}, binDir) {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-test-'));
  const output = join(temp, 'output');
  await writeFile(output, '');
  const env = { ...process.env, PATH: `${binDir ? `${binDir}:` : ''}/usr/bin:/bin`, GUARANI_TOKEN: 'synthetic-token',
    INPUT_REPO: input.repo, INPUT_REF: input.ref, INPUT_PROFILE: input.profile, INPUT_REPORT: 'github', INPUT_API_URL: 'http://127.0.0.1:1/v1',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_OUTPUT: output, ...extra };
  try {
    const child = spawn(process.execPath, [script], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { exit, stdout, stderr, output: await readFile(output, 'utf8') };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function server(handler, callback) {
  const s = createServer(handler);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  try { return await callback(`http://127.0.0.1:${s.address().port}/v1`); }
  finally { await new Promise((resolve) => s.close(resolve)); }
}

test('REST submits the expected payload and emits escaped annotations and HOLD outputs', async () => {
  const requests = [];
  const finding = { id: 'fnd_123456', severity: 'blocking', message: 'bad\n::notice::fake', location: { path: 'src/a,b.ts', start_line: 2, end_line: 3 }, rule: { id: 'rule:1' } };
  await server(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { id: fixtureId } : { id: fixtureId, status: 'completed', verdict: 'HOLD', decided_by: ['fnd_123456'], findings: [finding], ...input }));
  }, async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 1);
    assert.equal(result.output, `id=${fixtureId}\nverdict=HOLD\nfindings_count=1\n`);
    assert.match(result.stdout, /file=src\/a%2Cb.ts,line=2,endLine=3,title=rule%3A1::bad%0A::notice::fake/);
    assert.doesNotMatch(result.stdout, /\n::notice::fake/);
    assert.equal(requests[0].headers['idempotency-key'], '123-2-pull-request');
    assert.equal(requests[0].headers.authorization, 'Bearer synthetic-token');
    assert.deepEqual(JSON.parse(requests[0].body), input);
    assert.equal(requests[1].url, `/v1/verifications/${fixtureId}`);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-token/);
  });
});

test('REST CLEARED produces zero exit and outputs', async () => {
  await server((req, res) => res.end(JSON.stringify(req.method === 'POST' ? { id: fixtureId } : { id: fixtureId, status: 'completed', verdict: 'CLEARED', findings: [] })), async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 0);
    assert.equal(result.output, `id=${fixtureId}\nverdict=CLEARED\nfindings_count=0\n`);
  });
});

test('REST invalid verdict and redirected credentials fail closed', async () => {
  await server((req, res) => res.end(JSON.stringify(req.method === 'POST' ? { id: fixtureId } : { id: fixtureId, status: 'completed', verdict: 'passed', findings: [] })), async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 1); assert.equal(result.output, '');
  });
  let contacted = false;
  await server((req, res) => { contacted = true; res.end(); }, async (target) => {
    await server((req, res) => { res.statusCode = 302; res.setHeader('location', target); res.end(); }, async (url) => {
      const result = await run({ INPUT_API_URL: url });
      assert.equal(result.exit, 1); assert.equal(result.output, ''); assert.equal(contacted, false);
    });
  });
});

test('CLI receives the selected ref and base URL, and its exit must match its verdict', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-bin-'));
  const argsFile = join(temp, 'args');
  const executable = join(temp, 'guarani');
  try {
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--help" ]; then exit 0; fi\nprintf '%s\\n' "$@" > "$ARGS_FILE"\n[ "$GUARANI_BASE_URL" = "http://127.0.0.1:1/v1" ] || exit 9\nprintf '%s\\n' '{"id":"${fixtureId}","verdict":"CLEARED","findings":[]}'\nexit 0\n`);
    await chmod(executable, 0o755);
    const result = await run({ ARGS_FILE: argsFile }, temp);
    assert.equal(result.exit, 0); assert.match(result.output, /verdict=CLEARED/);
    assert.deepEqual((await readFile(argsFile, 'utf8')).trim().split('\n'), ['verify', '--repo', input.repo, '--ref', input.ref, '--profile', input.profile, '--json']);
    await writeFile(executable, `#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nprintf '%s\\n' '{"id":"${fixtureId}","verdict":"CLEARED","findings":[]}'\nexit 1\n`);
    const mismatch = await run({}, temp);
    assert.equal(mismatch.exit, 1); assert.equal(mismatch.output, '');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('REST retries a transient POST with the same idempotency key', async () => {
  const keys = [];
  await server((req, res) => {
    if (req.method === 'POST') {
      keys.push(req.headers['idempotency-key']);
      if (keys.length === 1) { res.statusCode = 503; res.setHeader('retry-after', '0'); return res.end(); }
      return res.end(JSON.stringify({ id: fixtureId }));
    }
    res.end(JSON.stringify({ id: fixtureId, status: 'completed', verdict: 'CLEARED', findings: [] }));
  }, async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 0);
    assert.deepEqual(keys, ['123-2-pull-request', '123-2-pull-request']);
  });
});

test('CLI JSON accepts the reference format without status and rejects unfinished or failed status', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-bin-'));
  const executable = join(temp, 'guarani');
  try {
    for (const status of [undefined, 'completed', 'running', 'failed']) {
      const json = JSON.stringify({ id: fixtureId, verdict: 'CLEARED', findings: [], ...(status === undefined ? {} : { status }) });
      await writeFile(executable, `#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nprintf '%s\n' '${json}'\n`);
      await chmod(executable, 0o755);
      const result = await run({}, temp);
      assert.equal(result.exit, status === undefined || status === 'completed' ? 0 : 1, String(status));
      if (status === 'running' || status === 'failed') assert.equal(result.output, '');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('invalid non-ASCII token is rejected before any network request', async () => {
  let contacted = false;
  await server((req, res) => { contacted = true; res.end(); }, async (url) => {
    const result = await run({ INPUT_API_URL: url, GUARANI_TOKEN: 'tokené' });
    assert.equal(result.exit, 1); assert.equal(contacted, false); assert.equal(result.output, '');
  });
});
