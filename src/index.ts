/**
 * Fleet Dashboard API — Cloudflare Worker
 *
 * Simulated ternary fleet telemetry governed by the conservation law:
 *   γ + η = C,  where C = log₂(3) ≈ 1.585 bits per agent.
 *
 * Endpoints:
 *   GET  /api/fleet/status   — aggregate fleet state
 *   GET  /api/fleet/agents   — per-agent ternary signals
 *   GET  /api/fleet/history  — γ / η time series (last 100 ticks)
 *   GET  /api/benchmark      — 12-language polyglot throughput benchmark
 *   POST /api/fleet/config   — update agent count / coherence bias
 *   POST /api/fleet/history  — ingest external telemetry push
 */

// ============================================================
// Types
// ============================================================

interface Env {
  DB: D1Database;
}

interface FleetStatus {
  agentCount: number;
  gamma: number;
  eta: number;
  c: number;
  sigma: number;
  delta: number;
  tick: number;
  uptime: number;
}

interface AgentSignal {
  id: number;
  signal: number;
}

interface HistoryPoint {
  tick: number;
  gamma: number;
  eta: number;
}

interface FleetConfigUpdate {
  agentCount?: number;
  bias?: number; // maps to coherence ∈ [0, 1]
}

interface IngestHistoryPoint {
  tick: number;
  gamma: number;
  eta: number;
}

// ============================================================
// Constants
// ============================================================

const C = Math.log2(3); // ≈ 1.585 bits — ternary channel capacity
const HISTORY_SIZE = 100;
const TICK_INTERVAL_MS = 1000; // advance sim at most once per second
const BIAS_SCALE = 3.6; // coherence [0,1] → effective bias [0, 3.6]

const BENCHMARK = [
  { rank: 1, name: 'C (asm)', sigPerSec: 1.20e10, paradigm: 'systems', note: 'Hand-tuned assembly-inlined C.' },
  { rank: 2, name: 'C++', sigPerSec: 1.15e10, paradigm: 'systems', note: 'Template-heavy zero-overhead C++.' },
  { rank: 3, name: 'Rust', sigPerSec: 9.20e9, paradigm: 'systems', note: 'Safe systems language. Zero-cost abstractions.' },
  { rank: 4, name: 'Julia', sigPerSec: 4.80e9, paradigm: 'scientific', note: 'JIT-compiled scientific computing.' },
  { rank: 5, name: 'C', sigPerSec: 3.20e9, paradigm: 'systems', note: 'Hand-tuned C with -O3.' },
  { rank: 6, name: 'C (LTO)', sigPerSec: 3.00e9, paradigm: 'systems', note: 'Link-time optimization variant.' },
  { rank: 7, name: 'Julia (rand)', sigPerSec: 2.50e9, paradigm: 'scientific', note: 'Random number generation path.' },
  { rank: 8, name: 'Julia (alloc)', sigPerSec: 1.10e9, paradigm: 'scientific', note: 'Allocator-optimized variant.' },
  { rank: 9, name: 'Fortran', sigPerSec: 1.00e8, paradigm: 'scientific', note: 'Classical HPC language.' },
  { rank: 10, name: 'Octave', sigPerSec: 9.77e7, paradigm: 'scientific', note: 'MATLAB-compatible. Interpreted.' },
  { rank: 11, name: 'D', sigPerSec: 5.00e7, paradigm: 'systems', note: 'Systems language with GC option.' },
  { rank: 12, name: 'COBOL', sigPerSec: 5.00e6, paradigm: 'legacy', note: 'Running production mainframes since 1959.' },
];

// ============================================================
// State — persists across requests within an isolate
// ============================================================

const sim = {
  tick: 0,
  startTime: Date.now(),
  agentCount: 100,
  coherence: 0.5, // OU parameter ∈ [0,1]; reverts to 0.5 → γ ≈ C/2
  direction: 1, // favored ternary value: +1 or -1
  flipCooldown: 0,
  gamma: C / 2, // last computed γ (empirical entropy)
  eta: C / 2, // last computed η = C − γ
  sigma: 0, // last |Σ|/n convergence metric
  agents: [] as number[],
  gammaHist: [] as number[],
  etaHist: [] as number[],
  lastTickMs: 0,
};

// Module-level refs for optional D1 persistence
let _env: Env | null = null;
let _ctx: ExecutionContext | null = null;

// ============================================================
// Simulation core
// ============================================================

/** Box-Muller Gaussian random. */
function gauss(): number {
  const u1 = Math.random() || 1e-10;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Shannon entropy (base-2) for a 3-outcome distribution. */
function entropy3(p1: number, p2: number, p3: number): number {
  let h = 0;
  if (p1 > 0) h -= p1 * Math.log2(p1);
  if (p2 > 0) h -= p2 * Math.log2(p2);
  if (p3 > 0) h -= p3 * Math.log2(p3);
  return h;
}

/**
 * Advance the simulation by one tick.
 *
 * Dynamics: Ornstein-Uhlenbeck mean-reversion on `coherence` around 0.5,
 * which maps (via a Boltzmann distribution over {-1, 0, +1}) to γ oscillating
 * around C/2.  Direction flips occasionally for visual variety.
 */
function advance(): void {
  sim.tick++;

  // --- OU mean-reversion: coherence → 0.5 ---
  const reversion = 0.08;
  const noise = 0.12;
  sim.coherence += reversion * (0.5 - sim.coherence) + noise * gauss();
  sim.coherence = Math.max(0.02, Math.min(0.98, sim.coherence));

  // --- Occasionally flip the dominant direction ---
  if (++sim.flipCooldown > 15 && Math.random() < 0.04) {
    sim.direction *= -1;
    sim.flipCooldown = 0;
  }

  // --- Boltzmann distribution over {-1, 0, +1} ---
  const b = sim.coherence * BIAS_SCALE * sim.direction;
  const z = Math.exp(-b) + 1 + Math.exp(b);
  const pNeg = Math.exp(-b) / z;
  const pZero = 1 / z;
  // pPos = 1 - pNeg - pZero

  // --- Generate agent signals from the distribution ---
  let sum = 0;
  const agents = new Array<number>(sim.agentCount);
  for (let i = 0; i < sim.agentCount; i++) {
    const r = Math.random();
    if (r < pNeg) {
      agents[i] = -1;
      sum--;
    } else if (r < pNeg + pZero) {
      agents[i] = 0;
    } else {
      agents[i] = 1;
      sum++;
    }
  }

  // --- Empirical distribution → actual entropy ---
  let cNeg = 0, cZero = 0, cPos = 0;
  for (const a of agents) {
    if (a === -1) cNeg++;
    else if (a === 0) cZero++;
    else cPos++;
  }
  const n = sim.agentCount;
  const gamma = entropy3(cNeg / n, cZero / n, cPos / n);
  const eta = C - gamma;

  // --- Persist to state ---
  sim.gamma = gamma;
  sim.eta = eta;
  sim.sigma = Math.abs(sum) / n;
  sim.agents = agents;

  // --- Ring buffer history ---
  sim.gammaHist.push(gamma);
  sim.etaHist.push(eta);
  if (sim.gammaHist.length > HISTORY_SIZE) sim.gammaHist.shift();
  if (sim.etaHist.length > HISTORY_SIZE) sim.etaHist.shift();

  sim.lastTickMs = Date.now();

  // --- Optional D1 persistence (fire-and-forget) ---
  if (_env?.DB && _ctx) {
    _ctx.waitUntil(
      _env.DB.prepare(
        `INSERT INTO telemetry_ticks (tick, gamma, eta, c_capacity, sigma, agent_count, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(sim.tick, gamma, eta, C, sim.sigma, sim.agentCount)
        .run()
        .catch(() => {}),
    );
  }
}

/** Advance the simulation if enough wall-clock time has elapsed. */
function maybeAdvance(): void {
  if (Date.now() - sim.lastTickMs >= TICK_INTERVAL_MS) {
    advance();
  }
}

// ============================================================
// HTTP helpers
// ============================================================

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ============================================================
// Endpoint handlers
// ============================================================

function getStatus(): Response {
  maybeAdvance();
  const status: FleetStatus = {
    agentCount: sim.agentCount,
    gamma: sim.gamma,
    eta: sim.eta,
    c: C,
    sigma: sim.sigma,
    delta: sim.gamma / C,
    tick: sim.tick,
    uptime: Math.floor((Date.now() - sim.startTime) / 1000),
  };
  return json(status);
}

function getAgents(): Response {
  maybeAdvance();
  const signals: AgentSignal[] = sim.agents.map((signal, id) => ({ id, signal }));
  return json(signals);
}

function getHistory(): Response {
  maybeAdvance();
  const history: HistoryPoint[] = [];
  const baseTick = sim.tick - sim.gammaHist.length + 1;
  for (let i = 0; i < sim.gammaHist.length; i++) {
    history.push({
      tick: baseTick + i,
      gamma: sim.gammaHist[i],
      eta: sim.etaHist[i],
    });
  }
  return json(history);
}

function getBenchmark(): Response {
  return json({
    unit: 'signals/sec',
    generated: new Date().toISOString(),
    languages: BENCHMARK,
  });
}

async function updateConfig(request: Request): Promise<Response> {
  let body: FleetConfigUpdate;
  try {
    body = (await request.json()) as FleetConfigUpdate;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (body.agentCount !== undefined) {
    if (typeof body.agentCount !== 'number' || body.agentCount < 1 || body.agentCount > 10000) {
      return json({ error: 'agentCount must be an integer in [1, 10000]' }, 400);
    }
    sim.agentCount = Math.floor(body.agentCount);
  }

  if (body.bias !== undefined) {
    if (typeof body.bias !== 'number' || body.bias < 0 || body.bias > 1) {
      return json({ error: 'bias must be a number in [0, 1]' }, 400);
    }
    sim.coherence = body.bias;
  }

  // Persist config to D1 if available
  if (_env?.DB && _ctx) {
    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      _env.DB.prepare('INSERT OR REPLACE INTO fleet_config (key, value) VALUES (?, ?)').bind(
        'agent_count',
        String(sim.agentCount),
      ),
    );
    stmts.push(
      _env.DB.prepare('INSERT OR REPLACE INTO fleet_config (key, value) VALUES (?, ?)').bind(
        'coherence',
        String(sim.coherence),
      ),
    );
    _ctx.waitUntil(Promise.all(stmts.map((s) => s.run().catch(() => {}))));
  }

  return json({
    ok: true,
    config: { agentCount: sim.agentCount, bias: sim.coherence },
  });
}

/**
 * POST /api/fleet/history — accept external telemetry pushes.
 *
 * Writes the incoming γ/η point to the in-memory ring buffer and optionally
 * persists to D1.  This lets the construct stack feed real data into the
 * Worker's time-series without relying solely on the internal simulation.
 */
async function ingestHistory(request: Request): Promise<Response> {
  let body: IngestHistoryPoint;
  try {
    body = (await request.json()) as IngestHistoryPoint;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.gamma !== 'number' || typeof body.eta !== 'number') {
    return json({ error: 'gamma and eta required' }, 400);
  }

  const gamma = body.gamma;
  const eta = body.eta;
  const tick = typeof body.tick === 'number' ? body.tick : sim.tick++;

  // Update live state
  sim.tick = tick;
  sim.gamma = gamma;
  sim.eta = eta;

  // Push into ring buffer
  sim.gammaHist.push(gamma);
  sim.etaHist.push(eta);
  if (sim.gammaHist.length > HISTORY_SIZE) sim.gammaHist.shift();
  if (sim.etaHist.length > HISTORY_SIZE) sim.etaHist.shift();

  sim.lastTickMs = Date.now();

  // Optional D1 persistence
  if (_env?.DB && _ctx) {
    _ctx.waitUntil(
      _env.DB.prepare(
        `INSERT OR IGNORE INTO telemetry_ticks (tick, gamma, eta, c_capacity, sigma, agent_count, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(tick, gamma, eta, C, sim.sigma, sim.agentCount)
        .run()
        .catch(() => {}),
    );
  }

  return json({ ok: true, tick, gamma, eta, c: C });
}

// ============================================================
// Router
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    _env = env;
    _ctx = ctx;

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // --- Routes ---
    if (method === 'GET' && pathname === '/api/fleet/status') return getStatus();
    if (method === 'GET' && pathname === '/api/fleet/agents') return getAgents();
    if (method === 'GET' && pathname === '/api/fleet/history') return getHistory();
    if (method === 'GET' && pathname === '/api/benchmark') return getBenchmark();
    if (method === 'POST' && pathname === '/api/fleet/config') return updateConfig(request);
    if (method === 'POST' && pathname === '/api/fleet/history') return ingestHistory(request);

    // --- Root info ---
    if (method === 'GET' && (pathname === '/' || pathname === '')) {
      return json({
        name: 'fleet-dashboard-api',
        version: '1.0.0',
        endpoints: [
          'GET  /api/fleet/status',
          'GET  /api/fleet/agents',
          'GET  /api/fleet/history',
          'GET  /api/benchmark',
          'POST /api/fleet/config',
          'POST /api/fleet/history',
        ],
        conservation: 'γ + η = C, C = log₂(3) ≈ 1.585',
      });
    }

    return json({ error: 'Not found', path: pathname }, 404);
  },
};
