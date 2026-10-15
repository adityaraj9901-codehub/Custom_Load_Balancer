import http from 'node:http';
import https from 'node:https';

// Active health checking: periodically probes each upstream's health path and
// flips it in/out of rotation using consecutive-success / consecutive-failure
// thresholds (so a single blip does not flap the pool).
export class HealthChecker {
  constructor(pool, config, log) {
    this.pool = pool;
    this.cfg = config.healthCheck;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.cfg.enabled) return;
    const interval = Math.max(100, this.cfg.intervalMs);
    this.timer = setInterval(() => this.sweep(), interval);
    if (this.timer.unref) this.timer.unref();
    this.sweep();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep() {
    if (this.running) return; // skip overlapping sweeps on slow upstreams
    this.running = true;
    const probes = this.pool.upstreams.map((u) => this.probe(u));
    Promise.allSettled(probes).finally(() => {
      this.running = false;
    });
  }

  probe(upstream) {
    return new Promise((resolve) => {
      const { origin } = upstream;
      const isHttps = origin.protocol === 'https:';
      const transport = isHttps ? https : http;
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const req = transport.request(
        {
          protocol: origin.protocol,
          hostname: origin.hostname,
          port: origin.port || (isHttps ? 443 : 80),
          method: this.cfg.method || 'GET',
          path: upstream.healthPath || this.cfg.path,
          timeout: this.cfg.timeoutMs,
          headers: { 'user-agent': 'zen-lb-healthcheck', connection: 'close' },
        },
        (res) => {
          res.resume(); // drain
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          this.apply(upstream, ok, `status=${res.statusCode}`);
          done();
        },
      );

      req.on('timeout', () => req.destroy(new Error('health check timeout')));
      req.on('error', (err) => {
        this.apply(upstream, false, err.code || err.message);
        done();
      });
      req.end();
    });
  }

  apply(upstream, ok, detail) {
    if (ok) {
      upstream.consecutiveFailures = 0;
      upstream.consecutiveSuccesses += 1;
      if (!upstream.healthy && upstream.consecutiveSuccesses >= this.cfg.healthyThreshold) {
        upstream.healthy = true;
        upstream.ejectedUntil = 0;
        this.log.info('upstream healthy', { upstream: upstream.url });
      } else if (upstream.ejectedUntil && Date.now() >= upstream.ejectedUntil) {
        upstream.ejectedUntil = 0; // passive cooldown elapsed
      }
      return;
    }

    upstream.consecutiveSuccesses = 0;
    upstream.consecutiveFailures += 1;
    if (upstream.healthy && upstream.consecutiveFailures >= this.cfg.unhealthyThreshold) {
      upstream.healthy = false;
      this.log.warn('upstream unhealthy', { upstream: upstream.url, detail });
    }
  }
}
