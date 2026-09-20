/**
 * packages/cli/src/decision/questions.ts — question builders.
 *
 * Each use case gets a pure builder: harness data in (already computed),
 * minimal state + typed questions out. Atomic questions only — one judgment
 * per question, composition happens in the policy, not in the prompt.
 */

import type { DecisionQuestion } from "./provider";

/** UC#1 — bash gray-zone state (already past the deterministic gate). */
export interface BashGrayZoneContext {
  command: string;
  cwd: string;
  writableRoots: string[];
  networkAllowed: boolean;
}

export function buildBashGrayZone(ctx: BashGrayZoneContext): {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
} {
  return {
    state: {
      kind: "bash-command",
      command: ctx.command,
      cwd: ctx.cwd,
      writableRoots: ctx.writableRoots,
      networkAllowed: ctx.networkAllowed,
    },
    questions: {
      destructive: {
        type: "noul",
        instructions:
          "Would running this shell command destroy data, make a hard-to-reverse change, or exfiltrate information?",
      },
      risk: {
        type: "score",
        instructions: "How risky is it to run this shell command without human approval?",
        levels: ["low", "medium", "high", "critical"],
      },
    },
  };
}

/** UC#2 — fresh critic triage state. */
export interface CriticTriageContext {
  taskGoal: string;
  acceptanceCriteria: string[];
  artifacts: string[];
  summary: string;
}

export function buildCriticTriage(ctx: CriticTriageContext): {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
} {
  return {
    state: {
      kind: "critic-triage",
      task: ctx.taskGoal,
      acceptanceCriteria: ctx.acceptanceCriteria,
      artifacts: ctx.artifacts,
      builderSummary: ctx.summary,
    },
    questions: {
      obvious_pass: {
        type: "noul",
        instructions:
          "Based only on this summary, is it obvious the work satisfies the acceptance criteria (a deeper review would certainly agree)?",
      },
      review_worthiness: {
        type: "score",
        instructions: "How much does this attempt deserve an independent generative review?",
        levels: ["skip", "light", "full", "deep"],
      },
    },
  };
}

/** UC#3 — E8 evidence strength (semantic layer over deterministic facts). */
export interface EvidenceStrengthContext {
  claimedBehavior: string;
  beforeExitCode: number | null;
  afterExitCode: number;
  targeted: boolean;
  newTestAdded: boolean;
  changedFiles: string[];
}

export function buildEvidenceStrength(ctx: EvidenceStrengthContext): {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
} {
  return {
    state: {
      kind: "evidence-strength",
      claimedBehavior: ctx.claimedBehavior,
      deterministicFacts: {
        beforeExitCode: ctx.beforeExitCode,
        afterExitCode: ctx.afterExitCode,
        targeted: ctx.targeted,
        newTestAdded: ctx.newTestAdded,
        changedFiles: ctx.changedFiles,
      },
    },
    questions: {
      establishes_claim: {
        type: "noul",
        instructions:
          "Given the deterministic facts, does this evidence actually establish that the claimed behavior is fixed?",
      },
      strength: {
        type: "score",
        instructions: "How strong is this evidence for the claimed fix?",
        levels: ["weak", "moderate", "strong", "very_strong"],
      },
    },
  };
}

/** UC#4 — E4 semantic risk refinement. */
export interface RiskRefinementContext {
  taskSummary: string;
  changedFiles: string[];
  dependents: number;
  testsAffected: number;
  criticalPath: boolean;
  deterministicLevel: "low" | "medium" | "high";
  ownershipEnforced: boolean;
}

export function buildRiskRefinement(ctx: RiskRefinementContext): {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
} {
  return {
    state: {
      kind: "risk-refinement",
      task: ctx.taskSummary,
      changedFiles: ctx.changedFiles,
      impact: {
        dependents: ctx.dependents,
        testsAffected: ctx.testsAffected,
        criticalPath: ctx.criticalPath,
      },
      deterministicRisk: ctx.deterministicLevel,
      ownershipEnforced: ctx.ownershipEnforced,
    },
    questions: {
      risk_level: {
        type: "score",
        instructions: "What is the real risk of this change?",
        levels: ["low", "medium", "high", "critical"],
      },
      security_sensitive: {
        type: "noul",
        instructions:
          "Does this change touch security-sensitive logic (auth, secrets, network, crypto)?",
      },
      requires_review: {
        type: "noul",
        instructions: "Should an independent review be required before accepting this change?",
      },
    },
  };
}

/** UC#5 — E5 UNKNOWN failure cause (Choice over the EXISTING taxonomy only). */
export const FAILURE_CAUSE_LEVELS = [
  "TEST_FAILURE",
  "BUILD_FAILURE",
  "TYPE_ERROR",
  "MISSING_DEPENDENCY",
  "SCOPE_VIOLATION",
  "TOOL_FAILURE",
  "ENVIRONMENT_FAILURE",
  "ASSERTION_WEAKNESS",
  "UNKNOWN",
] as const;

export function buildFailureCause(failureOutput: string): {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
} {
  return {
    state: {
      kind: "failure-cause",
      failureOutput,
    },
    questions: {
      cause: {
        type: "choice",
        instructions: "What is the most likely root cause of this failure?",
        criteria: Object.fromEntries(
          FAILURE_CAUSE_LEVELS.map((cause) => [
            cause,
            cause === "UNKNOWN"
              ? "Not enough information to classify"
              : `The ${cause.replace(/_/g, " ").toLowerCase()} category applies`,
          ]),
        ),
      },
    },
  };
}
