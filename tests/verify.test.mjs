import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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

test('disabled certificate verification fails before any request or CLI probe', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-disabled-tls-'));
  try {
    const executable = join(temp, 'guarani');
    const marker = join(temp, 'called');
    await writeFile(executable, '#!/bin/sh\ntouch "$PROBE_MARKER"\nexit 0\n');
    await chmod(executable, 0o755);
    let contacted = false;
    await server((req, res) => { contacted = true; res.end(); }, async (url) => {
      const result = await run({ INPUT_API_URL: url, NODE_TLS_REJECT_UNAUTHORIZED: '0', PROBE_MARKER: marker }, temp);
      assert.equal(result.exit, 1);
      assert.equal(result.output, '');
      assert.equal(contacted, false);
      assert.match(result.stderr, /TLS certificate verification must not be disabled/);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('both CLI invocations receive the TLS policy and preserve unrelated quoted Node options', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-cli-tls-'));
  try {
    const executable = join(temp, 'guarani');
    const log = join(temp, 'env.jsonl');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const tls = require('node:tls');
fs.appendFileSync(process.env.CLI_ENV_LOG, JSON.stringify({
  args: process.argv.slice(2), options: process.env.NODE_OPTIONS,
  reject: process.env.NODE_TLS_REJECT_UNAUTHORIZED, title: process.title,
  min: tls.DEFAULT_MIN_VERSION, ciphers: tls.DEFAULT_CIPHERS
}) + '\\n');
if (process.argv[2] !== '--help') console.log('${JSON.stringify({ id: fixtureId, verdict: 'CLEARED', findings: [] })}');
`);
    await chmod(executable, 0o755);
    const result = await run({ CLI_ENV_LOG: log,
      NODE_OPTIONS: '--trace-warnings --title="guarani quoted title" --tls-min-v1.0 --tls-max-v1.2 --tls-cipher-list "DEFAULT@SECLEVEL=0"' }, temp);
    assert.equal(result.exit, 0, result.stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['--help']);
    assert.equal(calls[1].args[0], 'verify');
    for (const call of calls) {
      assert.equal(call.reject, '1');
      assert.equal(call.min, 'TLSv1.2');
      assert.equal(call.ciphers, 'DEFAULT@SECLEVEL=2');
      assert.match(call.options, /--tls-min-v1\.2/);
      assert.match(call.options, /--tls-cipher-list=DEFAULT@SECLEVEL=2/);
      assert.doesNotMatch(call.options, /tls-max|tls-min-v1\.0|SECLEVEL=0/);
      assert.match(call.options, /trace-warnings/);
      assert.equal(call.title, 'guarani quoted title');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('HTTPS verifies trust, hostname, minimum protocol and key size before sending credentials', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'guarani-real-tls-'));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: temp, stdio: 'pipe' });
  try {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Guarani test CA');
    for (const [name, bits, san] of [['strong', 2048, 'IP:127.0.0.1'], ['weak', 1024, 'IP:127.0.0.1'], ['wrong-host', 2048, 'DNS:wrong.invalid']]) {
      openssl('req', '-new', '-newkey', `rsa:${bits}`, '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=Guarani test server');
      await writeFile(join(temp, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
      openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
    }
    const cases = [
      { name: 'strong', trust: true, version: 'TLSv1.2', ok: true },
      { name: 'strong', trust: true, version: 'TLSv1.3', ok: true },
      { name: 'strong', trust: false, version: 'TLSv1.2', ok: false },
      { name: 'weak', trust: true, version: 'TLSv1.2', ok: false },
      { name: 'wrong-host', trust: true, version: 'TLSv1.2', ok: false },
      { name: 'strong', trust: true, version: 'TLSv1.1', ok: false },
    ];
    for (const c of cases) {
      let contacted = 0;
      const s = createHttpsServer({
        key: await readFile(join(temp, `${c.name}.key`)), cert: await readFile(join(temp, `${c.name}.pem`)),
        // Deliberately weak test server. The client must enforce its own policy.
        minVersion: c.version, maxVersion: c.version, ciphers: 'DEFAULT@SECLEVEL=0',
      }, (req, res) => {
        contacted++;
        assert.equal(req.headers.authorization, 'Bearer synthetic-token');
        res.end(JSON.stringify(req.method === 'POST' ? { id: fixtureId } : { id: fixtureId, status: 'completed', verdict: 'CLEARED', findings: [] }));
      });
      await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
      try {
        const result = await run({ INPUT_API_URL: `https://127.0.0.1:${s.address().port}/v1`,
          NODE_EXTRA_CA_CERTS: c.trust ? join(temp, 'ca.pem') : '',
          NODE_OPTIONS: '--tls-min-v1.0 --tls-cipher-list=DEFAULT@SECLEVEL=0' });
        assert.equal(result.exit, c.ok ? 0 : 1, JSON.stringify(c) + result.stderr);
        assert.equal(contacted, c.ok ? 2 : 0, JSON.stringify(c));
        if (!c.ok) assert.equal(result.output, '');
      } finally { await new Promise((resolve) => s.close(resolve)); }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('REST rejects oversized bodies and does not retry non-transient status codes', async () => {
  await server((req, res) => res.end('x'.repeat(8 * 1024 * 1024 + 1)), async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 1); assert.equal(result.output, '');
    assert.match(result.stderr, /API response is too large/);
  });
  let requests = 0;
  await server((req, res) => { requests++; res.statusCode = 401; res.end(); }, async (url) => {
    const result = await run({ INPUT_API_URL: url });
    assert.equal(result.exit, 1); assert.equal(result.output, '');
    assert.equal(requests, 1);
    assert.match(result.stderr, /HTTP 401/);
  });
});
