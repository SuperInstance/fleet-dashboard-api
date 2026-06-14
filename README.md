# Fleet Dashboard API

Cloudflare Worker providing live telemetry for the Fleet Dashboard.

## Conservation Law

The fleet operates under the information-theoretic constraint:

```
γ + η = C    where C = log₂(3) ≈ 1.585 bits/agent
```

- **γ** (gamma) — mutual information I(X;G), the structured signal
- **η** (eta) — conditional entropy H(X|G), the residual noise
- **C** — channel capacity of a ternary signal {-1, 0, +1}

The simulation uses an Ornstein-Uhlenbeck process on a `coherence` parameter that mean-reverts to 0.5, causing γ to oscillate around C/2 (the balanced operating point).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fleet/status` | Aggregate fleet state (γ, η, C, σ, tick, uptime) |
| GET | `/api/fleet/agents` | Per-agent ternary signals (100 agents) |
| GET | `/api/fleet/history` | γ/η time series (last 100 ticks) |
| GET | `/api/benchmark` | 12-language polyglot throughput benchmark |
| POST | `/api/fleet/config` | Update fleet parameters (agent count, bias) |

## Setup

```bash
# 1. Create D1 database
npx wrangler d1 create fleet-telemetry
# → paste the database_id into wrangler.toml

# 2. Apply schema
npx wrangler d1 execute fleet-telemetry --remote --file=schema.sql

# 3. Deploy
npx wrangler deploy

# 4. Local dev
npx wrangler dev
```

## Configuration

Update fleet parameters at runtime:

```bash
curl -X POST https://fleet-dashboard-api.<account>.workers.dev/api/fleet/config \
  -H 'Content-Type: application/json' \
  -d '{"agentCount": 200, "bias": 0.7}'
```

- `agentCount` — number of agents (1–10000)
- `bias` — coherence parameter (0=random, 1=locked, 0.5=balanced)

## Tech

- Zero external dependencies (native Request/Response, no router library)
- In-memory ring buffer for history (D1 optional for persistence)
- TypeScript, ~300 lines
