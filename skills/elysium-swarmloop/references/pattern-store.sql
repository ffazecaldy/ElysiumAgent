-- ============================================================================
-- pattern-store.sql — Elysium Swarmloop Pattern Store Schema
--
-- SQLite-compatible schema for storing execution patterns, decomposition
-- templates, pitfalls, and calibration history — the self-learning memory
-- of the autonomous orchestration engine.
--
-- Compatible with sqlite MCP tools available in Hermes Agent.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. EXECUTIONS — record of every swarmloop run
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS executions (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    goal                    TEXT    NOT NULL,
    goal_type               TEXT    NOT NULL DEFAULT '',
    tier                    INTEGER NOT NULL DEFAULT 1,
    total_tasks             INTEGER NOT NULL DEFAULT 0,
    first_pass_rate         REAL    NOT NULL DEFAULT 0.0,
    avg_quality             REAL    NOT NULL DEFAULT 0.0,
    convergence_iterations  INTEGER NOT NULL DEFAULT 0,
    decomposition_pattern   TEXT    NOT NULL DEFAULT '',
    start_time              TEXT    NOT NULL DEFAULT '',
    duration_seconds        INTEGER NOT NULL DEFAULT 0,
    lessons                 TEXT    NOT NULL DEFAULT '[]',
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_executions_goal_type
    ON executions(goal_type);

CREATE INDEX IF NOT EXISTS idx_executions_decomp_pattern
    ON executions(decomposition_pattern);

CREATE INDEX IF NOT EXISTS idx_executions_tier_created
    ON executions(tier, created_at);

-- --------------------------------------------------------------------------
-- 2. DECOMPOSITION PATTERNS — reusable task-splitting templates
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decomposition_patterns (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL UNIQUE,
    description         TEXT    NOT NULL DEFAULT '',
    granularity         TEXT    NOT NULL DEFAULT 'medium',
    subagent_range_min  INTEGER NOT NULL DEFAULT 1,
    subagent_range_max  INTEGER NOT NULL DEFAULT 100,
    success_rate        REAL    NOT NULL DEFAULT 0.0,
    use_count           INTEGER NOT NULL DEFAULT 0,
    last_used           TEXT,
    sql_template        TEXT    NOT NULL DEFAULT '',
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decomp_patterns_success
    ON decomposition_patterns(success_rate DESC);

CREATE INDEX IF NOT EXISTS idx_decomp_patterns_last_used
    ON decomposition_patterns(last_used);

-- --------------------------------------------------------------------------
-- 3. PITFALLS — discovered anti-patterns and failure modes
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pitfalls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category        TEXT    NOT NULL DEFAULT 'general',
    description     TEXT    NOT NULL,
    severity        TEXT    NOT NULL DEFAULT 'medium',
    discovered_date TEXT    NOT NULL DEFAULT (date('now')),
    occurrences     INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pitfalls_category
    ON pitfalls(category);

CREATE INDEX IF NOT EXISTS idx_pitfalls_severity
    ON pitfalls(severity);

-- --------------------------------------------------------------------------
-- 4. CALIBRATIONS — adaptive parameter tuning history
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calibrations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id         INTEGER NOT NULL,
    granularity          TEXT    NOT NULL DEFAULT 'balanced',
    threshold_adjustment REAL    NOT NULL DEFAULT 0.0,
    subagent_multiplier  REAL    NOT NULL DEFAULT 1.0,
    rationale            TEXT    NOT NULL DEFAULT '',
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_calibrations_execution
    ON calibrations(execution_id);

CREATE INDEX IF NOT EXISTS idx_calibrations_created
    ON calibrations(created_at);

-- --------------------------------------------------------------------------
-- 5. REJECTED PATTERNS — patterns that failed held-out validation (SkillOpt gate)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rejected_patterns (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_type           TEXT    NOT NULL DEFAULT '',
    context             TEXT    NOT NULL DEFAULT '',
    pattern_data        TEXT    NOT NULL DEFAULT '{}',
    reason              TEXT    NOT NULL DEFAULT '',
    held_out_score_delta REAL   NOT NULL DEFAULT 0.0,
    baseline_score      REAL    NOT NULL DEFAULT 0.0,
    candidate_score     REAL    NOT NULL DEFAULT 0.0,
    held_out_tasks      INTEGER NOT NULL DEFAULT 0,
    rejected_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rejected_patterns_goal_type
    ON rejected_patterns(goal_type);

CREATE INDEX IF NOT EXISTS idx_rejected_patterns_rejected_at
    ON rejected_patterns(rejected_at);

-- --------------------------------------------------------------------------
-- 6. PATTERN CANDIDATES — patterns under held-out validation (not yet promoted)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pattern_candidates (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_type           TEXT    NOT NULL DEFAULT '',
    context             TEXT    NOT NULL DEFAULT '',
    pattern_data        TEXT    NOT NULL DEFAULT '{}',
    source_execution_id INTEGER,
    held_out_tasks      INTEGER NOT NULL DEFAULT 0,
    status              TEXT    NOT NULL DEFAULT 'pending',  -- pending/accepted/rejected
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_execution_id) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_candidates_goal_type
    ON pattern_candidates(goal_type);

CREATE INDEX IF NOT EXISTS idx_candidates_status
    ON pattern_candidates(status);

-- ==========================================================================
-- INSERT TEMPLATES
-- ==========================================================================

-- INSERT a new execution record
-- INSERT INTO executions (goal, goal_type, tier, total_tasks, first_pass_rate, avg_quality, convergence_iterations, decomposition_pattern, start_time, duration_seconds, lessons)
-- VALUES ('Build REST API for restaurant booking', 'api_creation', 3, 40, 0.84, 8.6, 3, 'per_endpoint', '2025-07-09T10:00:00Z', 300,
--         '["Task type X needs finer decomposition", "Retry feedback is most effective with concrete line references"]');

-- INSERT a decomposition pattern
-- INSERT INTO decomposition_patterns (name, description, granularity, subagent_range_min, subagent_range_max, success_rate, use_count, last_used, sql_template)
-- VALUES ('per_endpoint', 'One subagent per API endpoint + shared models', 'medium', 10, 40, 0.84, 5, '2025-07-09T10:00:00Z',
--         'SELECT * FROM tasks WHERE file = :endpoint OR tags LIKE "%model%"');

-- INSERT a pitfall
-- INSERT INTO pitfalls (category, description, severity)
-- VALUES ('quality_gate', 'Accepting 5/10 because "it works" defeats the loop. If threshold is too high, calibrate — do not ignore.', 'high');

-- INSERT a calibration entry
-- INSERT INTO calibrations (execution_id, granularity, threshold_adjustment, subagent_multiplier, rationale)
-- VALUES (1, 'fine', -0.5, 0.7, 'First-pass rate < 60% across last 3 runs — switching to finer granularity with reduced threshold');

-- ==========================================================================
-- USEFUL QUERIES
-- ==========================================================================

-- Top 3 most successful decomposition patterns
SELECT name, description, success_rate, use_count, last_used
FROM decomposition_patterns
ORDER BY success_rate DESC, use_count DESC
LIMIT 3;

-- Recent executions with quality metrics
SELECT goal, goal_type, tier, first_pass_rate, avg_quality, convergence_iterations, duration_seconds
FROM executions
ORDER BY created_at DESC
LIMIT 10;

-- Patterns that degraded over the last 5 uses
SELECT name, success_rate, use_count, last_used
FROM decomposition_patterns
WHERE use_count >= 5
  AND last_used IS NOT NULL
ORDER BY last_used DESC;

-- Most common pitfalls by category
SELECT category, COUNT(*) AS pitfall_count, ROUND(AVG(CASE severity
    WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END), 1) AS avg_severity
FROM pitfalls
GROUP BY category
ORDER BY pitfall_count DESC;

-- Calibration history for a specific execution
SELECT c.id, c.granularity, c.threshold_adjustment, c.subagent_multiplier, c.rationale, c.created_at
FROM calibrations c
WHERE c.execution_id = ?
ORDER BY c.created_at;

-- Calibration trend (last 10 calibrations)
SELECT c.created_at, e.goal, e.tier, c.granularity, c.threshold_adjustment, c.subagent_multiplier
FROM calibrations c
JOIN executions e ON e.id = c.execution_id
ORDER BY c.created_at DESC
LIMIT 10;
