# zen-lb — a production-grade L7 load balancer for Node.js

A zero-dependency HTTP/HTTPS reverse proxy and load balancer built on Node's
core `http`/`https`/`net` modules. It fronts a pool of backends, distributes
traffic with a choice of algorithms, health-checks them, retries failed
requests, and exposes live stats — all in a few hundred lines you can read
end to end.

## Features

- **Six algorithms** — round-robin, smooth weighted round-robin,
  least-connections, least-response-time, IP-hash (affinity), random.
- **Active health checks** — periodic probes with configurable up/down
  thresholds so a single blip does not flap the pool.
- **Passive circuit breaker** — an upstream that keeps failing is ejected for a
  cooldown window, then re-admitted automatically.
- **Retries with failover** — a failed in-flight request is retried against a
  *different* healthy backend, without duplicating it on a backend that already
  responded.
- **Connection reuse** — shared keep-alive agents per protocol for throughput.
- **WebSocket / upgrade tunneling** — raw socket pipe, incl. `wss` upstreams.
- **Observability** — JSON logs plus admin `/health` and `/stats` endpoints.
- **Graceful shutdown** — drains in-flight requests on `SIGTERM`/`SIGINT`,
  force-closes after a grace period.
- **Zero dependencies** — nothing to audit but Node itself.

## Quick start

```bash
# 1. Terminal A — start three sample backends on 9001-9003
node examples/upstream.js

# 2. Terminal B — start the balancer on 8080 (reads ./config.json)
node src/server.js

# 3. Send traffic through it
curl http://localhost:8080/hello
curl http://localhost:8080/__lb/stats
```

Point `config.json` at your real backends and run `npm start`. Run the test
suite with `npm test`.

## Configuration

Config is a JSON file (`config.json` by default, override with `LB_CONFIG` or
`PORT` / `LB_ALGORITHM` env vars). Every key is optional and merged onto
sensible defaults.

| Key | Default | Meaning |
|---|---|---|
| `host` / `port` | `0.0.0.0` / `8080` | Listener address. |
| `algorithm` | `round-robin` | Selection strategy (see below). |
| `upstreams[]` | `[]` | `{ url, weight?, healthPath? }` backends. |
| `healthCheck.intervalMs` | `5000` | Probe cadence per upstream. |
| `healthCheck.unhealthyThreshold` | `2` | Consecutive failures before removal. |
| `healthCheck.healthyThreshold` | `2` | Consecutive successes before re-admission. |
| `circuitBreaker.failureThreshold` | `5` | Passive failures before ejection. |
| `circuitBreaker.cooldownMs` | `10000` | Ejection window. |
| `proxy.timeoutMs` | `30000` | Per-request upstream timeout. |
| `proxy.retries` | `2` | Failover attempts on another backend. |
| `proxy.passHostHeader` | `false` | Forward the original `Host` header. |
| `proxy.trustProxy` | `false` | Trust `X-Forwarded-For` for client IP (IP-hash). |
| `admin.enabled` / `admin.path` | `true` / `/__lb` | Observability endpoints. |
| `admin.token` | `null` | If set, require the `x-admin-token` header. |
| `gracefulShutdownMs` | `10000` | Drain window on shutdown. |

## Algorithms

| Name | Best for |
|---|---|
| `round-robin` | Homogeneous backends, simplest fair split. |
| `weighted-round-robin` | Mixed-capacity backends; smooth (non-bursting) weighting. |
| `least-connections` | Long-lived / variable-latency requests. |
| `least-response-time` | Latency-sensitive workloads (EWMA + load aware). |
| `ip-hash` | Cache affinity / soft session stickiness. |
| `random` | Many homogeneous backends, minimal coordination. |

## Health checks & circuit breaker

Two independent mechanisms keep bad backends out of rotation:

1. **Active health checks** probe `GET <upstream>/health` every
   `intervalMs`. An upstream is marked unhealthy after
   `unhealthyThreshold` consecutive failures and healthy again after
   `healthyThreshold` consecutive successes — so transient errors don't flap
   the pool.
2. **Passive circuit breaker** watches real request outcomes. After
   `failureThreshold` consecutive request failures, the upstream is ejected
   for `cooldownMs`, then allowed back to be re-validated.

A backend serves traffic only when it is *both* actively healthy and not inside
an ejection window.

## Observability

- **Logs** — one JSON object per line (`ts`, `level`, `msg`, plus context) to
  stdout/stderr, ready for any log shipper.
- **`GET /__lb/health`** — `200` with `{status:"ok", healthyUpstreams, ...}`,
  or `503` `{status:"degraded"}` when no upstream is usable. Use it as your
  container/load-balancer health probe.
- **`GET /__lb/stats`** — per-upstream `activeConnections`, `totalRequests`,
  `failures`, `avgLatencyMs`, health and ejection state.

## Deployment

The repo ships a `Dockerfile`:

```bash
docker build -t zen-lb .
docker run -p 8080:8080 -v "$PWD/config.json:/app/config.json:ro" zen-lb
```

A systemd unit (adjust paths):

```ini
[Unit]
Description=zen-lb load balancer
After=network.target

[Service]
WorkingDirectory=/opt/zen-lb
ExecStart=/usr/bin/node src/server.js
Environment=NODE_ENV=production
Restart=always
RestartSec=2
User=zen

[Install]
WantedBy=multi-user.target
```

Or with pm2: `pm2 start src/server.js --name zen-lb` (run one process per CPU
core and front them with a TCP balancer, or set `reusePort` at the OS level).

## Production notes

- **TLS** — term TLS in front (cloud LB, nginx, or `https.createServer` with
  your certs) rather than in this process, so certificate rotation stays out of
  the forwarding path.
- **Scale out** — this balancer is stateless; run several behind a DNS
  round-robin or an L4 load balancer. IP-hash affinity only holds *within* one
  instance, so for strict stickiness front a single instance or use consistent
  hashing at the edge.
- **Tune** — raise `keepAlive.maxSockets` for high concurrency; lower
  `proxy.timeoutMs` and `circuitBreaker` thresholds for fast failure on
  flaky backends; keep `server.headersTimeoutMs > server.keepAliveTimeoutMs`
  (the defaults already do).
- **Failure modes** — when the pool is empty the balancer returns `503`; when
  retries are exhausted it returns `502`. Both are logged with the reason.
- **Backpressure** — request and response streams are piped, so large bodies
  stream through without buffering in memory.

## Project layout

```
load-balancer/
├── Dockerfile
├── config.json
├── package.json
├── README.md
├── src/
│   ├── config.js     # config load + validation + defaults
│   ├── logger.js     # zero-dep structured JSON logger
│   ├── pool.js       # Upstream, algorithms, Pool, circuit breaker
│   ├── health.js     # active health checker
│   ├── proxy.js      # forwarding, retries, WS tunneling
│   └── server.js     # HTTP server, admin endpoints, shutdown
├── examples/
│   └── upstream.js   # sample backends for local testing
└── test/
    └── smoke.test.js # end-to-end test (no framework)
```
