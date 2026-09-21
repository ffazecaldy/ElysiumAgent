/**
 * packages/cli/src/adaptive/index.ts — public surface of the Adaptive Layer.
 *
 * / Superficie pubblica dell'Adaptive Strategy Layer (default: disabled).
 *
 * The pipeline is explicit: Learning Memory → Derived Pattern → Reliability
 * Gate (deterministic, revisionable policy) → Approved Strategy → explicit
 * StrategyDecision. The action vocabulary is closed to verification-adding
 * moves — bypassing security policy is not expressible. Default mode:
 * disabled; `apply` must be set explicitly by the operator.
 */

export {
  createAdaptiveEngine,
  detectCandidates,
  isValidStrategyShape,
  ADAPTIVE_STORE_VERSION,
} from "./engine";
export { evaluateReliability, type ReliabilityVerdict } from "./policy";
export {
  emptyStrategyStore,
  loadStrategyStore,
  MAX_STRATEGIES,
  saveStrategyStore,
  STRATEGY_STORE_VERSION,
  upsertStrategy,
} from "./store";
export {
  DEFAULT_RELIABILITY_POLICY,
  type AdaptiveMode,
  type PatternCandidate,
  type Strategy,
  type StrategyAction,
  type StrategyActionKind,
  type StrategyCondition,
  type StrategyDecision,
  type StrategyReliability,
  type StrategyReliabilityPolicy,
  type StrategyStatus,
  type StrategyStoreShape,
} from "./types";
