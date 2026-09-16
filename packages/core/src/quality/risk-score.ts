/**
 * Adaptive verification: deterministic risk scoring for quality gating.
 *
 * The score is a pure function of its input — no clocks, no randomness, no
 * I/O — so the same inputs always yield the same verdict and, downstream,
 * the same gate threshold.
 */

/** Inputs driving the adaptive risk score. */
export interface RiskInput {
  /** Number of acceptance criteria attached to the gated task. */
  criteriaCount: number;
  /** Number of files/artifacts the subtask produced or touched. */
  filesTouched: number;
  /** True when the task sits on the critical path of the plan. */
  hasCriticalPath?: boolean;
}

/** Risk verdict: a 0-10 score plus the discrete level the gate derives from. */
export interface RiskScore {
  score: number;
  level: "low" | "medium" | "high";
}

/** Flat bonus added when the task lies on the plan's critical path. */
const CRITICAL_PATH_BONUS = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Deterministic risk score for a gated subtask:
 * `score = clamp(0-10, criteriaCount * 1 + filesTouched * 0.5 + (hasCriticalPath ? 3 : 0))`.
 *
 * Discrete level: `score <= 3` → low, `score <= 6` → medium, otherwise high.
 * Callers (e.g. the swarm quality gate) map the level onto a pass threshold
 * instead of applying a fixed one-size-fits-all strictness.
 */
export function riskScore(input: RiskInput): RiskScore {
  const raw =
    input.criteriaCount +
    input.filesTouched * 0.5 +
    (input.hasCriticalPath === true ? CRITICAL_PATH_BONUS : 0);
  const score = clamp(raw, 0, 10);
  const level: RiskScore["level"] = score <= 3 ? "low" : score <= 6 ? "medium" : "high";
  return { score, level };
}
