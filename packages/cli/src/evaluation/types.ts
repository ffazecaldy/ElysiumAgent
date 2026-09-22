/**
 * packages/cli/src/evaluation/types.ts — Native Evidence/Evaluation Layer types.
 *
 * / Modulo Native Evidence/Evaluation Layer — tipi nativi.
 *
 * OBSERVE-ONLY: the layer accumulates evidence facts and evaluates them into
 * a verdict — it never blocks, never mutates run state, never throws. The
 * five core shapes live here so `evidence.ts`, `evaluate.ts` and `runtime.ts`
 * share one vocabulary.
 */

/** What kind of fact this evidence item carries. */
export type EvidenceKind =
  | "critic_verdict"
  | "repair_attempt"
  | "git_state"
  | "tool_outcome"
  | "postcondition_check"
  | "exit_code"
  | "claim"
  | "security_event"
  | "task_outcome";

/** Which subsystem produced the item. */
export type EvidenceSource = "critic" | "repair" | "git" | "tool" | "report" | "policy";

/** One observed fact, bounded and cycle-safe (see evidence.ts bounds). */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  /** ISO timestamp. */
  at: string;
  source: EvidenceSource;
  /** Bounded facts payload — cyclic refs dropped, strings capped. */
  facts: Record<string, unknown>;
  /** Optional free-text claim, e.g. "rollback success". */
  claim?: string;
}

/**
 * A checkable expectation with its observation. `ok === null` means the
 * check could not be performed (missing data) — never false.
 */
export interface Postcondition {
  name: string;
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  /** null = not verifiable (insufficient data), never silently false. */
  ok: boolean | null;
}

/** Deterministic verdicts, facts-only — no model in the loop. FALSE_FAILURE
 * (F-02/F-04) = the agent claimed failure while every verifiable fact passed:
 * a claim/outcome mismatch with a verified-good task, unified with the
 * learning layer's claimVsOutcome vocabulary. */
export type EvalVerdict = "PASS" | "FAIL" | "INSUFFICIENT" | "FALSE_SUCCESS" | "FALSE_FAILURE";

/** The immutable output of one evaluation pass. */
export interface EvaluationRecord {
  /** `EV-<runId>-<n>`, monotonic per process (like makeDecisionId). */
  id: string;
  runId: string;
  taskId: string | null;
  verdict: EvalVerdict;
  /** Fraction of verified postconditions that passed, 0..1. */
  score: number;
  /** Min observed fact confidence when >= 2 evidence items, else null. */
  confidence: number | null;
  postconditions: Postcondition[];
  evidence: EvidenceItem[];
  /** ISO timestamp. */
  createdAt: string;
  /** Non-null when evaluation had to degrade (bounds, empty input). */
  fallbackReason: string | null;
}

/** Observation entry accepted by the runtime (facts arrive raw, bounded inside). */
export interface ObserveEntry {
  kind: EvidenceKind;
  source: EvidenceSource;
  facts: Record<string, unknown>;
  claim?: string;
}

/** Pure re-computation of the verdict matrix from facts (for tests). */
export interface EvidenceEvaluation {
  verdict: EvalVerdict;
  score: number;
  confidence: number | null;
}
