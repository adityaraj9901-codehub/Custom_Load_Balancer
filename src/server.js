import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Pool } from './pool.js';
import { HealthChecker } from './health.js';
import { createProxyHandler, createUpgradeHandler } from './proxy.js';

// Admin / observability endpoints (served under config.admin.path).
function createAdminHandler(pool, config) {
  const base = config.admin.path;

  return function admin(req, res) {
    if (config.admin.token && req.headers['x-admin-token'] !== config.admin.token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const path = new URL(req.url, 'http://internal').pathname;

    if (path === `${base}/health`) {
      const healthy = pool.healthyCount;
      const ok = healthy > 0;
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: ok ? 'ok' : 'degraded',
          healthyUpstreams: healthy,
          totalUpstreams: pool.size,
          uptimeSeconds: Math.round(process.uptime()),
        }),
      );
      return;
    }

    // Default: full stats snapshot.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          algorithm: pool.algorithm,
          healthyUpstreams: pool.healthyCount,
          totalUpstreams: pool.size,
          uptimeSeconds: Math.round(process.uptime()),
          upstreams: pool.snapshot(),
        },
        null,
        2,
      ),
    );
  };
}

export function createLoadBalancer(config) {
  const log = createLogger(config.logLevel, { service: 'zen-lb' });
  const pool = new Pool(config.upstreams, config.algorithm, config.circuitBreaker);
  const health = new HealthChecker(pool, config, log);
  const admin = config.admin.enabled ? createAdminHandler(pool, config) : null;
  const handleRequest = createProxyHandler({ pool, config, log });
  const handleUpgrade = createUpgradeHandler({ pool, config, log });

  const server = http.createServer((req, res) => {
    if (admin && req.url.startsWith(config.admin.path)) {
      admin(req, res);
      return;
    }
    handleRequest(req, res);
  });

  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

  // Track sockets so shutdown can drain or force-close them.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (config.proxy.socketTimeoutMs > 0) {
      socket.setTimeout(config.proxy.socketTimeoutMs, () => socket.destroy());
    }
  });

  server.keepAliveTimeout = config.server.keepAliveTimeoutMs;
  server.headersTimeout = config.server.headersTimeoutMs;

  let started = false;
  let shuttingDown = false;

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', onError);
        started = true;
        health.start();
        log.info('load balancer listening', {
          host: config.host,
          port: server.address().port,
          algorithm: config.algorithm,
          upstreams: pool.size,
        });
        resolve(server.address());
      });
    });
  }

  function stop() {
    if (!started || shuttingDown) return Promise.resolve();
    shuttingDown = true;
    health.stop();
    log.info('shutting down', { graceMs: config.gracefulShutdownMs });
    return new Promise((resolve) => {
      server.close(() => {
        started = false;
        resolve();
      });
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        started = false;
        resolve();
      }, config.gracefulShutdownMs);
      if (timer.unref) timer.unref();
    });
  }

  return {
    server,
    pool,
    log,
    start,
    stop,
    get address() {
      return server.address();
    },
  };
}

// --- Entry point (only when run directly, not when imported by tests) --------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = loadConfig();
  const lb = createLoadBalancer(config);

  lb.start().catch((err) => {
    lb.log.error('failed to start', { error: err.message });
    process.exit(1);
  });

  const shutdown = async (signal) => {
    lb.log.info('signal received', { signal });
    await lb.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => lb.log.error('unhandledRejection', { error: String(err) }));
  process.on('uncaughtException', (err) => {
    lb.log.error('uncaughtException', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
