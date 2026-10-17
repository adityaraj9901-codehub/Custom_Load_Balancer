import process from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  algorithm: 'round-robin',
  upstreams: [],
  logLevel: 'info',
  gracefulShutdownMs: 10000,
  healthCheck: {
    enabled: true,
    path: '/health',
    method: 'GET',
    intervalMs: 5000,
    timeoutMs: 2000,
    unhealthyThreshold: 2,
    healthyThreshold: 2,
  },
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10000,
  },
  proxy: {
    timeoutMs: 30000,
    socketTimeoutMs: 0,
    retries: 2,
    passHostHeader: false,
    trustProxy: false,
  },
  keepAlive: {
    enabled: true,
    maxSockets: 256,
    maxFreeSockets: 64,
    timeoutMs: 30000,
  },
  server: {
    keepAliveTimeoutMs: 65000,
    headersTimeoutMs: 66000,
  },
  admin: {
    enabled: true,
    path: '/__lb',
    token: null,
  },
};

export const ALGORITHMS = [
  'round-robin',
  'weighted-round-robin',
  'least-connections',
  'least-response-time',
  'ip-hash',
  'random',
];

const ALGORITHM_SET = new Set(ALGORITHMS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key])
        ? deepMerge(base[key], value)
        : value;
  }
  return out;
}

export function validate(cfg) {
  if (!ALGORITHM_SET.has(cfg.algorithm)) {
    throw new Error(
      `Unknown algorithm "${cfg.algorithm}". Valid options: ${ALGORITHMS.join(', ')}`,
    );
  }
  if (!Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) {
    throw new Error('At least one upstream is required in config.upstreams');
  }
  for (const up of cfg.upstreams) {
    if (!up || typeof up.url !== 'string') {
      throw new Error('Each upstream entry needs a "url" string');
    }
    let parsed;
    try {
      parsed = new URL(up.url);
    } catch {
      throw new Error(`Invalid upstream url: ${up.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Upstream must use http or https: ${up.url}`);
    }
    if (up.weight !== undefined && (!Number.isFinite(up.weight) || up.weight <= 0)) {
      throw new Error(`Upstream weight must be a positive number: ${up.url}`);
    }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new Error(`Invalid port: ${cfg.port}`);
  }
  if (!cfg.admin.path.startsWith('/')) {
    throw new Error('config.admin.path must start with "/"');
  }
  return cfg;
}

// Merge user overrides onto defaults, apply env overrides, then validate.
export function finalize(raw) {
  const cfg = deepMerge(DEFAULTS, raw || {});
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.LB_ALGORITHM) cfg.algorithm = process.env.LB_ALGORITHM;
  return validate(cfg);
}

export function loadConfig(file) {
  const path = file || process.env.LB_CONFIG || resolve(process.cwd(), 'config.json');
  let parsed = {};
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // A missing default config.json is fine (defaults apply); an explicitly
    // requested file that cannot be read is a hard error.
    if (process.env.LB_CONFIG || file) {
      throw new Error(`Cannot read config file ${path}: ${err.message}`);
    }
  }
  return finalize(parsed);
}
