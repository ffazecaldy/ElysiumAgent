/**
 * packages/cli/src/decision/index.ts — public surface of the Decision Layer.
 *
 * DETERMINISTIC RULES → [Jev gray-zone judgment] → DECISION POLICY → ACTION.
 * Optional, feature-flagged, off by default; the harness is byte-identical
 * without it (no key, no network, no behavior change).
 */

export {
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionAnswers,
  type DecisionEvaluation,
  type DecisionProvider,
  type DecisionQuestion,
  type NoulQuestion,
  NullDecisionProvider,
  type ScoreQuestion,
} from "./provider";
export {
  parseSystemOneAnswers,
  questionToWire,
  TypeSafeDecisionProvider,
  type TypeSafeProviderOptions,
} from "./typesafe";
export { minimizeState, stateHash } from "./sanitize";
export {
  buildBashGrayZone,
  buildCriticTriage,
  buildEvidenceStrength,
  buildFailureCause,
  buildRiskRefinement,
  CriticTriageContext,
  EvidenceStrengthContext,
  FAILURE_CAUSE_LEVELS,
  type RiskRefinementContext,
} from "./questions";
export {
  combineDecision,
  type DecisionMode,
  type DecisionOutcome,
  type DecisionPolicyConfig,
  type DecisionVerdict,
  DEFAULT_DECISION_POLICY,
} from "./policy";
export {
  buildDecisionRecord,
  decisionEvent,
  type DecisionRecord,
  fullDecisionId,
  makeDecisionId,
  resetDecisionIds,
} from "./fingerprint";
