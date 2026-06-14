-- ============================================================
-- Fleet Telemetry D1 Schema
-- ============================================================

-- One row per simulation tick
CREATE TABLE IF NOT EXISTS telemetry_ticks (
  tick        INTEGER PRIMARY KEY,
  gamma       REAL NOT NULL,       -- I(X;G) mutual information
  eta         REAL NOT NULL,       -- H(X|G) conditional entropy
  c_capacity  REAL NOT NULL,       -- C = log₂(3) ≈ 1.585
  sigma       REAL NOT NULL,       -- |Σ|/n convergence metric
  agent_count INTEGER NOT NULL,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key-value store for fleet configuration
CREATE TABLE IF NOT EXISTS fleet_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed defaults
INSERT OR IGNORE INTO fleet_config (key, value) VALUES ('agent_count', '100');
INSERT OR IGNORE INTO fleet_config (key, value) VALUES ('coherence', '0.5');

-- Range query index for history endpoint
CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp
  ON telemetry_ticks (timestamp);
