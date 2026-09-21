/**
 * packages/cli/src/learning/index.ts — public surface of the Learning Layer.
 *
 * / Superficie pubblica del Native Agent Learning Layer.
 *
 * OBSERVE-ONLY: turns EvaluationRecords into a persistent, bounded
 * performance memory and derives deterministic profiles. Facts (RunRecord)
 * and inferences (LearnedPattern) are separate vocabularies. No adaptive
 * behavior, no prompt changes, no policy feedback — by construction.
 */

export { buildProfile, computeMetrics, taskClassOf } from "./engine";
export { revalidateStrategy, type RevalidationVerdict } from "./runtime";
export { appendRun, emptyStore, loadStore, saveStore } from "./store";
export {
  createLearningEngine,
  LEARNING_DIR,
  type LearningEngine,
} from "./runtime";
export {
  LEARNING_STORE_VERSION,
  MAX_STORED_RUNS,
  MIN_SAMPLES_FOR_PROFILE,
} from "./types";
export type {
  AgentPerformanceProfile,
  LearnedPattern,
  LearningStoreShape,
  PerformanceMetrics,
  RunRecord,
  RunOutcome,
} from "./types";
