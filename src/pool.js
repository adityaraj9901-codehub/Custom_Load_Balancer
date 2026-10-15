import { createHash } from 'node:crypto';

// A single backend behind the balancer, with its own health + load state.
export class Upstream {
  constructor({ url, weight = 1, healthPath } = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported upstream protocol: ${url}`);
    }
    this.url = url.replace(/\/+$/, '');
    this.origin = parsed;
    this.weight = Math.max(1, Number(weight) || 1);
    this.healthPath = healthPath;

    this.healthy = true; // active health-check verdict
    this.ejectedUntil = 0; // passive circuit-breaker cooldown
    this.active = 0; // in-flight requests
    this.total = 0; // lifetime requests
    this.failures = 0; // lifetime failures
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.avgLatency = 0; // EWMA of response time (ms)
    this.currentWeight = 0; // scratch space for smooth weighted round-robin
  }

  // Eligible to receive traffic right now.
  get available() {
    return this.healthy && Date.now() >= this.ejectedUntil;
  }

  recordLatency(ms) {
    const alpha = 0.2;
    this.avgLatency = this.avgLatency === 0 ? ms : this.avgLatency * (1 - alpha) + ms * alpha;
  }

  snapshot() {
    return {
      url: this.url,
      weight: this.weight,
      healthy: this.healthy,
      available: this.available,
      ejectedUntil: this.ejectedUntil || null,
      activeConnections: this.active,
      totalRequests: this.total,
      failures: this.failures,
      avgLatencyMs: Math.round(this.avgLatency * 100) / 100,
    };
  }
}

// --- Selection algorithms -------------------------------------------------
// Each receives the candidate list (already filtered to available upstreams)
// and a context object, and returns the chosen upstream.

const ALGORITHMS = {
  'round-robin': (candidates, ctx) => candidates[ctx.counter % candidates.length],

  // Nginx-style smooth weighted round robin: weights are honoured *and* spread
  // out rather than bursting (e.g. 3:1 becomes A A B A, not A A A B).
  'weighted-round-robin': (candidates) => {
    let total = 0;
    let best = null;
    for (const u of candidates) {
      u.currentWeight += u.weight;
      total += u.weight;
      if (!best || u.currentWeight > best.currentWeight) best = u;
    }
    if (best) best.currentWeight -= total;
    return best;
  },

  'least-connections': (candidates) => {
    let best = candidates[0];
    let bestScore = best.active / best.weight;
    for (const u of candidates.slice(1)) {
      const score = u.active / u.weight;
      if (score < bestScore) {
        best = u;
        bestScore = score;
      }
    }
    return best;
  },

  'least-response-time': (candidates) => {
    let best = candidates[0];
    let bestScore = (best.avgLatency || 1) * (1 + best.active);
    for (const u of candidates.slice(1)) {
      const score = (u.avgLatency || 1) * (1 + u.active);
      if (score < bestScore) {
        best = u;
        bestScore = score;
      }
    }
    return best;
  },

  random: (candidates) => candidates[Math.floor(Math.random() * candidates.length)],

  // Deterministic mapping so a given client stays on the same backend
  // (useful for cache affinity / soft sessions).
  'ip-hash': (candidates, ctx) => {
    const digest = createHash('sha1').update(String(ctx.clientIp || '')).digest();
    return candidates[digest.readUInt32BE(0) % candidates.length];
  },
};

export class Pool {
  constructor(upstreams, algorithm = 'round-robin', circuitBreaker = {}) {
    this.upstreams = upstreams.map((u) => (u instanceof Upstream ? u : new Upstream(u)));
    if (this.upstreams.length === 0) throw new Error('Pool requires at least one upstream');
    this.algorithm = ALGORITHMS[algorithm] ? algorithm : 'round-robin';
    this.counter = 0;
    this.breaker = {
      failureThreshold: circuitBreaker.failureThreshold ?? 5,
      cooldownMs: circuitBreaker.cooldownMs ?? 10000,
    };
  }

  get size() {
    return this.upstreams.length;
  }

  get healthyCount() {
    return this.upstreams.filter((u) => u.available).length;
  }

  // Pick the next upstream. `exclude` lets a retry loop avoid backends it has
  // already tried for the current request.
  pick(clientIp = '', exclude = new Set()) {
    let candidates = this.upstreams.filter((u) => u.available && !exclude.has(u.url));
    if (candidates.length === 0) {
      // Last resort: ignore the exclusion so a request can still be served.
      candidates = this.upstreams.filter((u) => u.available);
    }
    if (candidates.length === 0) return null;

    const ctx = { counter: this.counter++, clientIp };
    return ALGORITHMS[this.algorithm](candidates, ctx);
  }

  recordSuccess(upstream) {
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses += 1;
    if (!upstream.healthy) upstream.healthy = true;
    if (upstream.ejectedUntil && Date.now() >= upstream.ejectedUntil) upstream.ejectedUntil = 0;
  }

  // Returns true when this failure tripped the breaker (ejected the upstream).
  recordFailure(upstream) {
    upstream.failures += 1;
    upstream.consecutiveFailures += 1;
    upstream.consecutiveSuccesses = 0;
    if (upstream.consecutiveFailures >= this.breaker.failureThreshold) {
      upstream.ejectedUntil = Date.now() + this.breaker.cooldownMs;
      upstream.consecutiveFailures = 0;
      return true;
    }
    return false;
  }

  snapshot() {
    return this.upstreams.map((u) => u.snapshot());
  }
}
