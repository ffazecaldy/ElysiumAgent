/**
 * packages/cli/src/decision/swarm-hooks.ts — swarm-side decision adapters.
 *
 * Pure bridges between the swarm loop's data and the Decision Layer.
 * NOTHING here calls the provider directly: callers pass an evaluator (or
 * null) and every function degrades to the deterministic/historical result
 * when the evaluator is null, unavailable, or fails. Shadow mode never
 * changes the returned value — the decision record is emitted either way.
 *
 * Swarm approval mapping (GAP 5): the swarm has NO interactive approver, so
 * REQUIRE_APPROVAL resolves to the swarm's own review surface (fresh critic /
 * master escalation) via `approvalToSwarmAction`, never to ALLOW.
 */

import { type DecisionRecord, buildDecisionRecord } from "./fingerprint";
import {
  DEFAULT_DECISION_POLICY,
  type DecisionMode,
  type DecisionOutcome,
  type DecisionPolicyConfig,
  type DecisionVerdict,
  combineDecision,
} from "./policy";
import type { DecisionEvaluation, DecisionProvider } from "./provider";
import {
  buildCriticTriage,
  buildEvidenceStrength,
  buildFailureCause,
  buildRiskRefinement,
} from "./questions";
import { minimizeState } from "./sanitize";

/** Swarm-side resolution of an approval requirement (GAP 5). */
export type SwarmAction = "proceed" | "review" | "escalate" | "block";

/** REPL asks the operator; the swarm has no operator — approval maps to its
 * review surface (fresh critic / master escalation), never to ALLOW. */
export function approvalToSwarmAction(verdict: DecisionVerdict): SwarmAction {
  if (verdict === "DENY") return "block";
  if (verdict === "REQUIRE_APPROVAL") return "review";
  return "proceed";
}

/** Everything the hooks need. `evaluator: null` = Decision Layer off. */
export interface HookContext {
  evaluator: DecisionProvider | null;
  mode: DecisionMode;
  runId: string;
  taskId: string | null;
  record: (input: {
    useCase: DecisionRecord["useCase"];
    providerId: string;
    mode: DecisionMode;
    outcome: DecisionOutcome;
    semantic: DecisionOutcome | null;
    evaluation: DecisionEvaluation | null;
    state: Record<string, unknown>;
  }) => void;
  extraSecrets?: string[];
  policy?: DecisionPolicyConfig;
}

const FALLBACK = (reason: string): DecisionOutcome => ({
  verdict: "ALLOW",
  source: "fallback",
  reason,
});

function emit(
  ctx: HookContext,
  useCase: DecisionRecord["useCase"],
  state: Record<string, unknown>,
  evaluation: DecisionEvaluation | null,
  combined: { outcome: DecisionOutcome; shadowSemantic: DecisionOutcome | null },
): DecisionRecord {
  const record = buildDecisionRecord({
    runId: ctx.runId,
    taskId: ctx.taskId,
    useCase,
    providerId: ctx.evaluator?.id ?? "none",
    mode: ctx.mode,
    outcome: combined.outcome,
    semantic: combined.shadowSemantic,
    evaluation,
    state,
  });
  ctx.record({
    useCase,
    providerId: ctx.evaluator?.id ?? "none",
    mode: ctx.mode,
    outcome: combined.outcome,
    semantic: combined.shadowSemantic,
    evaluation,
    state,
  });
  return record;
}

/** GAP 1 — E4 semantic risk refinement. May only ESCALATE the deterministic level. */
export async function refineRisk(
  ctx: HookContext,
  input: {
    taskSummary: string;
    changedFiles: string[];
    dependents: number;
    testsAffected: number;
    criticalPath: boolean;
    deterministicLevel: "low" | "medium" | "high";
    ownershipEnforced: boolean;
  },
): Promise<{
  level: "low" | "medium" | "high";
  securitySensitive: boolean | null;
  requiresReview: boolean | null;
  record: DecisionRecord | null;
}> {
  if (ctx.evaluator === null || ctx.mode === "off") {
    return {
      level: input.deterministicLevel,
      securitySensitive: null,
      requiresReview: null,
      record: null,
    };
  }
  try {
    const question = buildRiskRefinement(input);
    const evaluation = await ctx.evaluator.evaluate(
      minimizeState(question.state, ctx.extraSecrets ?? []),
      question.questions,
    );
    const policy = ctx.policy ?? DEFAULT_DECISION_POLICY;
    const riskAnswer = evaluation.ok ? evaluation.answers.risk_level : undefined;
    const security = evaluation.ok ? evaluation.answers.security_sensitive : undefined;
    const review = evaluation.ok ? evaluation.answers.requires_review : undefined;
    const order: ReadonlyArray<"low" | "medium" | "high"> = ["low", "medium", "high"];
    const detIdx = order.indexOf(input.deterministicLevel);
    let level = input.deterministicLevel;
    let semantic: DecisionOutcome = FALLBACK(
      evaluation.fallbackReason ?? "risk refinement unavailable",
    );
    if (
      evaluation.ok &&
      riskAnswer !== undefined &&
      riskAnswer.kind === "score" &&
      riskAnswer.confidence >= policy.uncertainBelow
    ) {
      const semIdx = order.indexOf(riskAnswer.score as "low" | "medium" | "high");
      if (semIdx > detIdx) {
        level = order[detIdx + 1] ?? "high";
        semantic = {
          verdict: "REQUIRE_APPROVAL",
          source: "semantic",
          reason: `semantic risk ${riskAnswer.score} > deterministic ${input.deterministicLevel}`,
        };
      } else {
        semantic = {
          verdict: "ALLOW",
          source: "semantic",
          reason: `semantic risk ${riskAnswer.score} ≤ deterministic ${input.deterministicLevel}`,
        };
      }
    }
    let securitySensitive: boolean | null = null;
    let requiresReview: boolean | null = null;
    if (evaluation.ok && security !== undefined && security.kind === "noul") {
      securitySensitive = security.probability >= 0.5;
    }
    if (evaluation.ok && review !== undefined && review.kind === "noul") {
      requiresReview = review.probability >= 0.5;
    }
    const combined = combineDecision("ALLOW", evaluation, ctx.mode, policy);
    const applied = ctx.mode === "enforce";
    return {
      level: applied ? level : input.deterministicLevel,
      securitySensitive,
      requiresReview,
      record: emit(ctx, "risk-refinement", question.state, evaluation, combined),
    };
  } catch {
    return {
      level: input.deterministicLevel,
      securitySensitive: null,
      requiresReview: null,
      record: null,
    };
  }
}

/** GAP 2 — E8 semantic evidence strength over already-computed deterministic facts. */
export async function judgeEvidenceStrength(
  ctx: HookContext,
  input: {
    claimedBehavior: string;
    beforeExitCode: number | null;
    afterExitCode: number;
    targeted: boolean;
    newTestAdded: boolean;
    changedFiles: string[];
  },
): Promise<{ strength: "WEAK" | "MEDIUM" | "STRONG" | "UNKNOWN"; record: DecisionRecord | null }> {
  if (ctx.evaluator === null || ctx.mode === "off") {
    return { strength: "UNKNOWN", record: null };
  }
  try {
    const question = buildEvidenceStrength(input);
    const evaluation = await ctx.evaluator.evaluate(
      minimizeState(question.state, ctx.extraSecrets ?? []),
      question.questions,
    );
    const establishes = evaluation.ok ? evaluation.answers.establishes_claim : undefined;
    const strengthAnswer = evaluation.ok ? evaluation.answers.strength : undefined;
    let strength: "WEAK" | "MEDIUM" | "STRONG" | "UNKNOWN" = "UNKNOWN";
    let semantic: DecisionOutcome = FALLBACK(
      evaluation.fallbackReason ?? "evidence judgment unavailable",
    );
    const p =
      establishes !== undefined && establishes.kind === "noul" ? establishes.probability : null;
    if (evaluation.ok && strengthAnswer !== undefined && strengthAnswer.kind === "score") {
      if (strengthAnswer.confidence < 0.5 || p === null || p < 0.5) {
        // low confidence → insufficient/unknown (never invents facts)
        strength = "UNKNOWN";
        semantic = {
          verdict: "ALLOW",
          source: "semantic",
          reason: "evidence judgment low confidence → UNKNOWN",
        };
      } else {
        strength =
          strengthAnswer.score === "strong" || strengthAnswer.score === "very_strong"
            ? "STRONG"
            : strengthAnswer.score === "moderate"
              ? "MEDIUM"
              : "WEAK";
        semantic = {
          verdict: "ALLOW",
          source: "semantic",
          reason: `evidence ${strength} @ confidence ${strengthAnswer.confidence}`,
        };
      }
    }
    const combined = combineDecision("ALLOW", evaluation, ctx.mode);
    return {
      strength: ctx.mode === "enforce" ? strength : "UNKNOWN",
      record: emit(ctx, "evidence-strength", question.state, evaluation, combined),
    };
  } catch {
    return { strength: "UNKNOWN", record: null };
  }
}

/** GAP 3 — E5 UNKNOWN failure-cause fallback. `cause` is null unless enforce. */
export async function refineFailureCause(
  ctx: HookContext,
  failureOutput: string,
  deterministicCauses: string[],
): Promise<{ cause: string | null; record: DecisionRecord | null }> {
  if (ctx.evaluator === null || ctx.mode === "off") {
    return { cause: null, record: null };
  }
  // deterministic known cause → Jev not needed at all
  const known = deterministicCauses.filter((c) => c !== "UNKNOWN");
  if (known.length > 0) {
    return { cause: null, record: null };
  }
  try {
    const question = buildFailureCause(failureOutput);
    const evaluation = await ctx.evaluator.evaluate(
      minimizeState(question.state, ctx.extraSecrets ?? []),
      question.questions,
    );
    const answer = evaluation.ok ? evaluation.answers.cause : undefined;
    let cause: string | null = null;
    let semantic: DecisionOutcome = FALLBACK(
      evaluation.fallbackReason ?? "failure-cause unavailable",
    );
    if (
      evaluation.ok &&
      answer !== undefined &&
      answer.kind === "choice" &&
      answer.choice !== "UNKNOWN" && // Jev cannot invent categories / must not answer UNKNOWN
      answer.confidence >= 0.7 // insufficient confidence → stays UNKNOWN
    ) {
      cause = answer.choice; // one of the EXISTING taxonomy values (from the builder criteria)
      semantic = {
        verdict: "ALLOW",
        source: "semantic",
        reason: `cause ${answer.choice} @ ${answer.confidence}`,
      };
    } else if (evaluation.ok) {
      semantic = { verdict: "ALLOW", source: "semantic", reason: "low confidence → stays UNKNOWN" };
    }
    const combined = combineDecision("ALLOW", evaluation, ctx.mode);
    return {
      cause: ctx.mode === "enforce" ? cause : null,
      record: emit(ctx, "failure-cause", question.state, evaluation, combined),
    };
  } catch {
    return { cause: null, record: null };
  }
}

/** GAP 4 — critic triage. `skipCritic` is true ONLY in enforce mode with a
 * high-confidence obvious pass; shadow records what WOULD have happened. */
export async function triageCritic(
  ctx: HookContext,
  input: { taskGoal: string; acceptanceCriteria: string[]; artifacts: string[]; summary: string },
): Promise<{
  skipCritic: boolean;
  triage: "skip" | "critic" | "escalate";
  record: DecisionRecord | null;
}> {
  if (ctx.evaluator === null || ctx.mode === "off") {
    return { skipCritic: false, triage: "critic", record: null };
  }
  try {
    const question = buildCriticTriage(input);
    const evaluation = await ctx.evaluator.evaluate(
      minimizeState(question.state, ctx.extraSecrets ?? []),
      question.questions,
    );
    const policy = ctx.policy ?? DEFAULT_DECISION_POLICY;
    const pass = evaluation.ok ? evaluation.answers.obvious_pass : undefined;
    const worth = evaluation.ok ? evaluation.answers.review_worthiness : undefined;
    const passP = pass !== undefined && pass.kind === "noul" ? pass.probability : null;
    const worthLevel = worth !== undefined && worth.kind === "score" ? worth.score : null;
    const worthConf = worth !== undefined && worth.kind === "score" ? worth.confidence : 0;
    const obvious =
      evaluation.ok &&
      passP !== null &&
      passP >= policy.skipCriticObviousPass &&
      worthLevel === "skip" &&
      worthConf >= policy.skipCriticConfidence;
    let semantic: DecisionOutcome;
    if (evaluation.ok && worthLevel === "deep") {
      semantic = {
        verdict: "REQUIRE_APPROVAL",
        source: "semantic",
        reason: "triage requests deep review",
      };
    } else if (obvious) {
      semantic = { verdict: "ALLOW", source: "semantic", reason: `obvious pass ${passP}` };
    } else {
      semantic = {
        verdict: "REQUIRE_APPROVAL",
        source: "semantic",
        reason: "triage uncertain → critic",
      };
    }
    // Triage-specific combination: the historical baseline for every attempt
    // is "run the critic" (REQUIRE_APPROVAL). The ONLY permitted relaxation is
    // enforce + obvious-pass + high confidence (documented GAP 4 exception);
    // everything else goes through the standard combine (escalation-only).
    let combined;
    if (ctx.mode === "enforce" && obvious) {
      combined = {
        outcome: {
          verdict: "ALLOW" as const,
          source: "semantic" as const,
          reason: `obvious pass ${passP} ≥ ${policy.skipCriticObviousPass} → critic may be skipped`,
        },
        shadowSemantic: semantic,
      };
    } else {
      combined = combineDecision("REQUIRE_APPROVAL", evaluation, ctx.mode, policy);
    }
    // Swarm mapping (GAP 5): the historical baseline here is "run the critic"
    // (= review). Only enforce + explicit obvious-pass may skip it.
    const action = approvalToSwarmAction(combined.outcome.verdict);
    const skipCritic = ctx.mode === "enforce" && action === "proceed";
    return {
      skipCritic,
      triage: skipCritic
        ? "skip"
        : action === "escalate" || worthLevel === "deep"
          ? "escalate"
          : "critic",
      record: emit(ctx, "critic-triage", question.state, evaluation, combined),
    };
  } catch {
    return { skipCritic: false, triage: "critic", record: null };
  }
}
