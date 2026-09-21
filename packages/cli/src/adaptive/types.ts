/**
 * packages/cli/src/adaptive/types.ts — Adaptive Strategy Layer types.
 *
 * / Tipi dell'Adaptive Strategy Layer: strategia, gate, decisione.
 *
 * PIPELINE (no shortcuts): Learning Memory → Derived Pattern → Reliability
 * Gate → Approved Strategy → Strategy Application → future execution. A
 * strategy can NEVER allow/bypass anything: the action vocabulary is a
 * closed union of verification-adding moves, enforced at validation time.
 */

/** Runtime mode. Default is `disabled` — the layer never acts by default. */
export type AdaptiveMode = "disabled" | "observe" | "suggest" | "apply";

/**
 * Closed action vocabulary. SECURITY INVARIANT: nothing in this union can
 * allow a command, bypass DENY/ownership/network, disable verification or
 * skip a gate. Validation REJECTS any strategy carrying another action.
 */
export type StrategyActionKind =
  | "ADD_POSTCONDITION_VERIFICATION"
  | "SUGGEST_EXTRA_CHECK"
  | "REQUIRE_EVIDENCE";

/** What condition triggers the strategy (deterministic pattern reference). */
export interface StrategyCondition {
  /** Pattern key from the learning layer, e.g. `failure:exit-code-zero`. */
  pattern: string;
  /** Optional task-class scope. */
  taskClass?: string;
  /** Optional tool scope. */
  tool?: string;
}

/** What the strategy does when applied (verification-adding only). */
export interface StrategyAction {
  kind: StrategyActionKind;
  /** For ADD_POSTCONDITION_VERIFICATION: the extra check name. */
  postcondition?: string;
  /** Bounded human note. */
  note?: string;
}

/** Deterministic reliability snapshot at approval time. */
export interface StrategyReliability {
  /** 0..1 deterministic blend of pattern rate and evidence completeness. */
  score: number;
  sampleCount: number;
  patternRate: number;
  conflictRate: number;
  evidenceCompleteness: number;
  policyVersion: number;
}

/** Lifecycle status — strategies are never silently eternal. */
export type StrategyStatus = "enabled" | "disabled" | "stale" | "invalidated";

/** A bounded, versioned, explicitly-sourced adaptive strategy. */
export interface Strategy {
  id: string;
  version: 1;
  condition: StrategyCondition;
  action: StrategyAction;
  /** Learning pattern key this strategy was derived from. */
  sourcePattern: string;
  sampleCount: number;
  reliability: StrategyReliability;
  createdAt: string;
  lastValidatedAt: string;
  status: StrategyStatus;
}

/** Explicit record of one adaptive decision — full audit trail entry. */
export interface StrategyDecision {
  strategyId: string;
  triggerPattern: string;
  reliability: number;
  mode: AdaptiveMode;
  action: StrategyAction;
  applied: boolean;
  reason: string;
  evidence: { sampleCount: number; patternRate: number };
  at: string;
}

/**
 * Deterministic, revisionable reliability policy. NOT hidden in the engine:
 * callers may inspect and override every threshold.
 */
export interface StrategyReliabilityPolicy {
  version: number;
  /** Pattern bucket must hold at least this many runs. */
  minimumSamples: number;
  /** Pattern share within its bucket must be at least this. */
  minimumPatternRate: number;
  /** Mean evidence confidence must be at least this. */
  minimumConfidence: number;
  /** Runs with evidence ≥ this share. */
  minimumEvidenceCompleteness: number;
  /** Conflicting (passing) share within a failure pattern must not exceed this. */
  maximumConflictRate: number;
  /** A strategy not re-validated within this age becomes stale. */
  maxAgeMs: number;
}

export const DEFAULT_RELIABILITY_POLICY: StrategyReliabilityPolicy = {
  version: 1,
  minimumSamples: 5,
  minimumPatternRate: 0.15,
  minimumConfidence: 0.5,
  minimumEvidenceCompleteness: 0.6,
  maximumConflictRate: 0.2,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

/** Shape of the persisted strategy store (separate from learning-store). */
export interface StrategyStoreShape {
  version: number;
  mode: AdaptiveMode;
  strategies: Strategy[];
}

/** A candidate pattern measured from the learning history (pre-gate). */
export interface PatternCandidate {
  pattern: string;
  sampleCount: number;
  patternRate: number;
  conflictRate: number;
  evidenceCompleteness: number;
  meanConfidence: number | null;
  taskClass?: string;
  tool?: string;
}
