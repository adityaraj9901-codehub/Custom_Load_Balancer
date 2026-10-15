import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

// Headers that describe a single hop and must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// One shared keep-alive agent per protocol so upstream connections are reused.
const agents = new Map();

function getAgent(isHttps, config) {
  const key = isHttps ? 'https' : 'http';
  if (!agents.has(key)) {
    const options = {
      keepAlive: true,
      maxSockets: config.keepAlive.maxSockets,
      maxFreeSockets: config.keepAlive.maxFreeSockets,
      timeout: config.keepAlive.timeoutMs,
    };
    agents.set(key, isHttps ? new https.Agent(options) : new http.Agent(options));
  }
  return agents.get(key);
}

export function getClientIp(req, config) {
  if (config.proxy.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function buildForwardHeaders(req, target, config, { websocket = false } = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!websocket && HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = value;
  }

  const remote = req.socket.remoteAddress || '';
  const prior = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = prior ? `${prior}, ${remote}` : remote;
  headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
  headers['x-forwarded-host'] = req.headers.host || target.host;
  headers['x-request-id'] = req.headers['x-request-id'] || randomUUID();

  if (websocket) {
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade || 'websocket';
  }
  if (!config.proxy.passHostHeader) headers.host = target.host;
  return headers;
}

function relayHeaders(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function sendError(res, statusCode, message, requestId) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: message, requestId });
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Forward a single client request to one upstream. On a pre-response failure it
// calls onError so the handler can retry against another backend.
function forward(clientReq, clientRes, upstream, ctx, onError) {
  const { config, log, pool } = ctx;
  const target = upstream.origin;
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;
  const startedAt = Date.now();

  upstream.total += 1;
  upstream.active += 1;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    upstream.active = Math.max(0, upstream.active - 1);
    upstream.recordLatency(Date.now() - startedAt);
  };
  clientRes.on('close', release);

  const proxyReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: clientReq.method,
    path: clientReq.url,
    headers: buildForwardHeaders(clientReq, target, config),
    agent: config.keepAlive.enabled ? getAgent(isHttps, config) : undefined,
  });

  let responded = false;

  proxyReq.on('response', (proxyRes) => {
    responded = true;
    pool.recordSuccess(upstream);

    if (config.proxy.timeoutMs > 0) {
      proxyRes.setTimeout(config.proxy.timeoutMs, () =>
        proxyRes.destroy(new Error('upstream response timeout')),
      );
    }

    const headers = relayHeaders(proxyRes.headers);
    if (proxyRes.statusMessage) {
      clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.statusMessage, headers);
    } else {
      clientRes.writeHead(proxyRes.statusCode || 502, headers);
    }
    proxyRes.pipe(clientRes);
    proxyRes.on('error', (err) => {
      log.warn('upstream stream error', { upstream: upstream.url, error: err.message });
      clientRes.destroy(err);
    });
  });

  proxyReq.on('error', (err) => {
    release();
    if (responded || clientRes.headersSent) {
      clientRes.destroy(err);
      return;
    }
    const ejected = pool.recordFailure(upstream);
    log.warn('upstream request failed', {
      upstream: upstream.url,
      error: err.code || err.message,
      breakerOpen: ejected || undefined,
    });
    onError(err);
  });

  if (config.proxy.timeoutMs > 0) {
    proxyReq.setTimeout(config.proxy.timeoutMs, () => {
      const err = new Error('upstream request timeout');
      err.code = 'ETIMEDOUT';
      proxyReq.destroy(err);
    });
  }

  clientReq.on('aborted', () => {
    release();
    proxyReq.destroy(new Error('client aborted'));
  });

  clientReq.pipe(proxyReq);
}

// Request handler factory: pick an upstream, forward, retry the next one on
// pre-response failure, and 502/503 when nothing can serve it.
export function createProxyHandler({ pool, config, log }) {
  const maxAttempts = Math.max(1, (config.proxy.retries ?? 0) + 1);

  return function handle(req, res) {
    const clientIp = getClientIp(req, config);
    const attempted = new Set();
    let attempt = 0;
    let lastError = null;

    const next = (error) => {
      if (res.headersSent || res.writableEnded) return;
      if (error) lastError = error;

      if (attempt >= maxAttempts) {
        log.warn('all attempts exhausted', { path: req.url, error: lastError?.message });
        return sendError(res, 502, 'Bad Gateway', req.headers['x-request-id']);
      }

      const upstream = pool.pick(clientIp, attempted);
      if (!upstream) {
        return sendError(res, 503, 'Service Unavailable', req.headers['x-request-id']);
      }

      attempt += 1;
      attempted.add(upstream.url);
      forward(req, res, upstream, { config, log, pool }, next);
    };

    next();
  };
}

// WebSocket / HTTP-upgrade tunneling: raw socket pipe to a chosen upstream.
export function createUpgradeHandler({ pool, config, log }) {
  return function handleUpgrade(req, socket, head) {
    const clientIp = getClientIp(req, config);
    const upstream = pool.pick(clientIp, new Set());
    if (!upstream) {
      socket.destroy();
      return;
    }

    const target = upstream.origin;
    const isHttps = target.protocol === 'https:';
    const port = target.port || (isHttps ? 443 : 80);
    const headers = buildForwardHeaders(req, target, config, { websocket: true });

    const requestLine = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) requestLine.push(`${key}: ${item}`);
      } else {
        requestLine.push(`${key}: ${value}`);
      }
    }
    const payload = Buffer.from(`${requestLine.join('\r\n')}\r\n\r\n`);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      socket.destroy();
      conn.destroy();
    };

    const onConnect = () => {
      conn.write(payload);
      if (head && head.length) conn.write(head);
      socket.pipe(conn);
      conn.pipe(socket);
    };

    const conn = isHttps
      ? tls.connect({ host: target.hostname, port, servername: target.hostname }, onConnect)
      : net.connect({ host: target.hostname, port }, onConnect);

    conn.on('error', (err) => {
      log.warn('upgrade tunnel error', { upstream: upstream.url, error: err.code || err.message });
      cleanup();
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    conn.on('close', cleanup);
  };
}
