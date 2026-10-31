// Sample data server used only to exercise the composite action in CI.
import { createServer } from 'node:http';
const id = 'ver_01JB7Q4M2XK8';
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer synthetic-test-token') {
    res.writeHead(401).end('{}');
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/verifications') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('{}'); return; }
    if (!payload.repo || !payload.ref || payload.profile !== 'pull-request' || !req.headers['idempotency-key']) {
      res.writeHead(400).end('{}');
      return;
    }
    res.writeHead(202).end(JSON.stringify({ id, status: 'queued' }));
    return;
  }
  if (req.method === 'GET' && req.url === `/v1/verifications/${id}`) {
    res.end(JSON.stringify({ id, status: 'completed', verdict: 'CLEARED', findings: [] }));
    return;
  }
  res.writeHead(404).end('{}');
});
server.listen(18781, '127.0.0.1');
