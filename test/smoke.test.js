// End-to-end smoke test — no test framework required: `node test/smoke.test.js`.
import http from 'node:http';
import assert from 'node:assert/strict';
import { createLoadBalancer } from '../src/server.js';
import { finalize } from '../src/config.js';

const served = new Map();

function startUpstream(name) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      served.set(name, (served.get(name) || 0) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ servedBy: name }));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, name });
    });
  });
}

function get(port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

function stopUpstream(u) {
  return new Promise((resolve) => {
    u.server.close(() => resolve());
    if (u.server.closeAllConnections) u.server.closeAllConnections();
  });
}

async function main() {
  const a = await startUpstream('a');
  const b = await startUpstream('b');
  const c = await startUpstream('c');

  const config = finalize({
    port: 0,
    logLevel: 'error',
    algorithm: 'round-robin',
    gracefulShutdownMs: 300,
    upstreams: [
      { url: `http://127.0.0.1:${a.port}` },
      { url: `http://127.0.0.1:${b.port}` },
      { url: `http://127.0.0.1:${c.port}` },
    ],
    healthCheck: { enabled: true, intervalMs: 150, timeoutMs: 500, unhealthyThreshold: 2, healthyThreshold: 1 },
  });

  const lb = createLoadBalancer(config);
  await lb.start();
  const port = lb.address.port;

  // 1) Round-robin spreads load evenly.
  for (let i = 0; i < 30; i++) {
    const res = await get(port, `/r/${i}`);
    assert.equal(res.status, 200, `request ${i} should succeed`);
  }
  assert.equal(served.get('a'), 10, 'upstream a');
  assert.equal(served.get('b'), 10, 'upstream b');
  assert.equal(served.get('c'), 10, 'upstream c');
  console.log('PASS  round-robin distributed 30 requests evenly (10/10/10)');

  // 2) Admin stats endpoint.
  const stats = JSON.parse((await get(port, '/__lb/stats')).body);
  assert.equal(stats.upstreams.length, 3);
  assert.equal(stats.healthyUpstreams, 3);
  console.log('PASS  admin /__lb/stats reports 3 healthy upstreams');

  // 3) A dead upstream is ejected by active health checks.
  await stopUpstream(a);
  await new Promise((r) => setTimeout(r, 900));
  const health = JSON.parse((await get(port, '/__lb/health')).body);
  assert.ok(health.healthyUpstreams <= 2, 'dead upstream should be out of rotation');

  for (let i = 0; i < 12; i++) {
    const res = await get(port, `/after/${i}`);
    assert.equal(res.status, 200, `request after failure ${i} should still succeed`);
  }
  assert.equal(served.get('a'), 10, 'no new traffic should reach the dead upstream');
  console.log('PASS  unhealthy upstream removed from rotation, traffic rerouted');

  await lb.stop();
  await stopUpstream(b);
  await stopUpstream(c);
  console.log('\nAll smoke tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
