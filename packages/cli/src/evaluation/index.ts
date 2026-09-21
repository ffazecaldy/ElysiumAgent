/**
 * packages/cli/src/evaluation/index.ts — public surface of the Evaluation Layer.
 *
 * / Superficie pubblica del modulo Native Evidence/Evaluation Layer.
 *
 * OBSERVE-ONLY: accumulates facts, folds them into deterministic verdicts,
 * never blocks and never throws. No default export; named exports only.
 */

export {
  boundEvidence,
  boundEvidenceList,
  boundFacts,
  capString,
  makeEvaluationId,
  MAX_EVIDENCE,
  MAX_STRING,
  projectFacts,
  resetEvaluationIds,
} from "./evidence";
export {
  buildCriticPostcondition,
  buildExitCodePostcondition,
  buildRollbackPostcondition,
  evaluateEvidence,
} from "./evaluate";
export {
  createEvaluationRuntime,
  type EvaluationRuntime,
  type EvaluationRuntimeOptions,
  type EvaluationSink,
} from "./runtime";
export type {
  EvaluationRecord,
  EvidenceEvaluation,
  EvidenceItem,
  EvidenceKind,
  EvidenceSource,
  EvalVerdict,
  ObserveEntry,
  Postcondition,
} from "./types";
