/**
 * packages/cli/src/learning/types.ts — Native Agent Learning Layer types.
 *
 * / Tipi del Native Agent Learning Layer: memoria dell'esperienza.
 *
 * OBSERVE-ONLY like the Evaluation Layer: the learning pipeline turns
 * EvaluationRecords into a persistent, bounded performance memory. Facts and
 * inferences are SEPARATE vocabularies — a derived pattern is historical
 * statistics, never a runtime fact and never an authorization.
 */

/** Schema version of the persisted store (bump on breaking shape changes). */
export const LEARNING_STORE_VERSION = 1;

/** Outcome class of one evaluated run (mirrors the Evaluation verdicts). */
export type RunOutcome = "PASS" | "FAIL" | "INSUFFICIENT" | "FALSE_SUCCESS";

/** One evaluated run as the learning pipeline ingests it. */
export interface RunRecord {
  /** Unique run id (the swarm run id). */
  runId: string;
  /** ISO timestamp of ingestion. */
  at: string;
  /** Goal text (bounded, used for lightweight task-pattern keys). */
  goal: string;
  outcome: RunOutcome;
  /** Evaluation score 0..1 (verified postconditions fraction). */
  score: number;
  /** Evaluation confidence 0..1 or null. */
  confidence: number | null;
  /** Number of repair/retry rounds observed (informative). */
  retryCount: number;
  /** Bounded task class key (first goal word group, lowercase). */
  taskClass: string;
  /** Tool names seen in evidence (bounded list, max 8). */
  tools: string[];
  /** Postcondition names that failed (bounded list, max 8). */
  failedPostconditions: string[];
  /** Evidence count backing the evaluation. */
  evidenceCount: number;
}

/**
 * A derived historical pattern. STATISTICS, not facts: consumers must treat
 * this as "what happened in past runs", never as a runtime assertion.
 */
export interface LearnedPattern {
  /** Deterministic key, e.g. `task-class:create`, `failure:postcondition:exit-code-zero`. */
  key: string;
  /** Human-readable one-liner (bounded). */
  summary: string;
  sampleCount: number;
  /** 0..1 share within its bucket. */
  rate: number;
  /** ISO timestamp of the last contributing run. */
  lastSeenAt: string;
}

/** Separated metric block — informative only, never a safety decision. */
export interface PerformanceMetrics {
  verifiedSuccessRate: number;
  falseSuccessRate: number;
  falseFailureRate: number;
  postconditionSuccessRate: number;
  averageScore: number;
  averageConfidence: number | null;
  /** Confidence of runs whose verdict said PASS vs their verified outcome. */
  confidenceCalibration: number | null;
  retryRate: number;
  /** Fraction of runs with at least one verifiable postcondition. */
  evidenceCompleteness: number;
}

/** Aggregate performance profile derived deterministically from the store. */
export interface AgentPerformanceProfile {
  /** `perf-v1` — bumps with the store schema. */
  version: string;
  generatedAt: string;
  sampleCount: number;
  metrics: PerformanceMetrics;
  /** Top task-class patterns (bounded, sorted by sampleCount desc). */
  taskPatterns: LearnedPattern[];
  /** Top failure patterns (bounded, sorted by sampleCount desc). */
  failurePatterns: LearnedPattern[];
  /** true when sampleCount >= MIN_SAMPLES_FOR_PROFILE. */
  dataSufficient: boolean;
  /** Non-null reason when the profile could not be computed fully. */
  fallbackReason: string | null;
}

/** Shape of the persisted JSON store. */
export interface LearningStoreShape {
  version: number;
  runs: RunRecord[];
  /** Rolling counters that survive pruning (per task class). */
  taskClassCounts: Record<string, number>;
}

/** Minimum samples before a profile claims dataSufficient. */
export const MIN_SAMPLES_FOR_PROFILE = 5;
/** Hard cap on stored runs (oldest dropped — newest history wins). */
export const MAX_STORED_RUNS = 500;
