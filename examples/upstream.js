import process from 'node:process';
// Tiny backend servers to exercise the load balancer locally.
// Usage: node examples/upstream.js [port ...]   (defaults: 9001 9002 9003)
import http from 'node:http';

const args = process.argv.slice(2).map(Number).filter(Boolean);
const ports = args.length ? args : [9001, 9002, 9003];

for (const port of ports) {
  const name = `upstream-${port}`;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Simulate work: send `x-delay: <ms>` to slow a specific response.
    const delay = Number(req.headers['x-delay']) || 0;

    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          servedBy: name,
          method: req.method,
          path: req.url,
          forwardedFor: req.headers['x-forwarded-for'] || null,
          requestId: req.headers['x-request-id'] || null,
        }),
      );
    }, delay);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`${name} listening on http://127.0.0.1:${port}`);
  });
}
