/** GAP 9 — decision-bench: minimal fixture suite for the Decision Layer.
 *
 * Verifies POLICY + WIRING quality with mocked Jev responses (offline).
 * NOT a performance benchmark and NOT real-Jev quality measurement.
 * Each case: input state → mocked answer → expected final decision.
 */
import { describe, expect, it } from "vitest";
import {
  buildBashGrayZone,
  buildCriticTriage,
  buildEvidenceStrength,
  buildFailureCause,
  buildRiskRefinement,
} from "../src/decision/questions";
import {
  combineDecision,
  DEFAULT_DECISION_POLICY,
  type DecisionMode,
} from "../src/decision/policy";
import { minimizeState } from "../src/decision/sanitize";
import { triageCritic } from "../src/decision/swarm-hooks";
import type {
  DecisionAnswers,
  DecisionEvaluation,
  DecisionProvider,
  DecisionQuestion,
} from "../src/decision/provider";

interface BenchCase {
  name: string;
  useCase:
    | "bash-gray-zone"
    | "critic-triage"
    | "evidence-strength"
    | "risk-refinement"
    | "failure-cause";
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  mockedAnswers: DecisionAnswers;
  /** deterministic verdict entering the policy (where applicable) */
  deterministic: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
  mode: DecisionMode;
  expectedFinal: "ALLOW" | "REQUIRE_APPROVAL" | "DENY";
}

const CASES: BenchCase[] = [
  // ── bash gray zone ──
  {
    name: "bash: destructive command (rm -rf /) — deterministic DENY beats mock-Jev 'allow'",
    useCase: "bash-gray-zone",
    state: minimizeState(
      buildBashGrayZone({
        command: "rm -rf /",
        cwd: "/",
        writableRoots: ["/"],
        networkAllowed: false,
      }).state,
    ),
    questions: buildBashGrayZone({
      command: "rm -rf /",
      cwd: "/",
      writableRoots: ["/"],
      networkAllowed: false,
    }).questions,
    mockedAnswers: {
      destructive: { kind: "noul", probability: 0.01 },
      risk: { kind: "score", score: "low", probabilities: { low: 0.95 }, confidence: 0.97 },
    },
    deterministic: "DENY",
    mode: "enforce",
    expectedFinal: "DENY",
  },
  {
    name: "bash: ambiguous migration — Jev high risk escalates ALLOW to approval (enforce)",
    useCase: "bash-gray-zone",
    state: minimizeState(
      buildBashGrayZone({
        command: "python migrate.py",
        cwd: "/repo",
        writableRoots: ["/repo"],
        networkAllowed: false,
      }).state,
    ),
    questions: buildBashGrayZone({
      command: "python migrate.py",
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    }).questions,
    mockedAnswers: {
      destructive: { kind: "noul", probability: 0.82 },
      risk: { kind: "score", score: "high", probabilities: { high: 0.8 }, confidence: 0.85 },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "REQUIRE_APPROVAL",
  },
  {
    name: "bash: same ambiguous command in shadow → historical ALLOW, semantic recorded",
    useCase: "bash-gray-zone",
    state: minimizeState(
      buildBashGrayZone({
        command: "python migrate.py",
        cwd: "/repo",
        writableRoots: ["/repo"],
        networkAllowed: false,
      }).state,
    ),
    questions: buildBashGrayZone({
      command: "python migrate.py",
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    }).questions,
    mockedAnswers: {
      destructive: { kind: "noul", probability: 0.82 },
      risk: { kind: "score", score: "high", probabilities: { high: 0.8 }, confidence: 0.85 },
    },
    deterministic: "ALLOW",
    mode: "shadow",
    expectedFinal: "ALLOW",
  },
  {
    name: "bash: npm test — safe deterministic + Jev safe → ALLOW",
    useCase: "bash-gray-zone",
    state: minimizeState(
      buildBashGrayZone({
        command: "npm test",
        cwd: "/repo",
        writableRoots: ["/repo"],
        networkAllowed: false,
      }).state,
    ),
    questions: buildBashGrayZone({
      command: "npm test",
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    }).questions,
    mockedAnswers: {
      destructive: { kind: "noul", probability: 0.01 },
      risk: { kind: "score", score: "low", probabilities: { low: 0.92 }, confidence: 0.9 },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
  // ── critic triage ──
  {
    name: "critic: obvious pass high confidence → skip in enforce",
    useCase: "critic-triage",
    state: minimizeState(
      buildCriticTriage({
        taskGoal: "typo fix",
        acceptanceCriteria: ["typo gone"],
        artifacts: ["README.md"],
        summary: "removed typo",
      }).state,
    ),
    questions: buildCriticTriage({
      taskGoal: "typo fix",
      acceptanceCriteria: ["typo gone"],
      artifacts: ["README.md"],
      summary: "removed typo",
    }).questions,
    mockedAnswers: {
      obvious_pass: { kind: "noul", probability: 0.97 },
      review_worthiness: {
        kind: "score",
        score: "skip",
        probabilities: { skip: 0.94 },
        confidence: 0.92,
      },
    },
    deterministic: "REQUIRE_APPROVAL",
    mode: "enforce",
    expectedFinal: "ALLOW", // historical baseline was review; policy allows the skip
  },
  {
    name: "critic: uncertain → keep the critic (conservative)",
    useCase: "critic-triage",
    state: minimizeState(
      buildCriticTriage({
        taskGoal: "refactor auth",
        acceptanceCriteria: ["tests pass"],
        artifacts: ["a.ts"],
        summary: "not sure",
      }).state,
    ),
    questions: buildCriticTriage({
      taskGoal: "refactor auth",
      acceptanceCriteria: ["tests pass"],
      artifacts: ["a.ts"],
      summary: "not sure",
    }).questions,
    mockedAnswers: {
      obvious_pass: { kind: "noul", probability: 0.55 },
      review_worthiness: {
        kind: "score",
        score: "light",
        probabilities: { light: 0.5 },
        confidence: 0.45,
      },
    },
    deterministic: "REQUIRE_APPROVAL",
    mode: "enforce",
    expectedFinal: "REQUIRE_APPROVAL",
  },
  {
    name: "critic: deep review request → escalate",
    useCase: "critic-triage",
    state: minimizeState(
      buildCriticTriage({
        taskGoal: "auth change",
        acceptanceCriteria: ["a"],
        artifacts: ["token.ts"],
        summary: "changed token validation",
      }).state,
    ),
    questions: buildCriticTriage({
      taskGoal: "auth change",
      acceptanceCriteria: ["a"],
      artifacts: ["token.ts"],
      summary: "changed token validation",
    }).questions,
    mockedAnswers: {
      obvious_pass: { kind: "noul", probability: 0.4 },
      review_worthiness: {
        kind: "score",
        score: "deep",
        probabilities: { deep: 0.8 },
        confidence: 0.85,
      },
    },
    deterministic: "REQUIRE_APPROVAL",
    mode: "enforce",
    expectedFinal: "REQUIRE_APPROVAL",
  },
  // ── E8 evidence strength ──
  {
    name: "evidence: strong deterministic facts + Jev strong → strong (enforce refines)",
    useCase: "evidence-strength",
    state: minimizeState(
      buildEvidenceStrength({
        claimedBehavior: "login rejects bad password",
        beforeExitCode: 1,
        afterExitCode: 0,
        targeted: true,
        newTestAdded: true,
        changedFiles: ["login.ts"],
      }).state,
    ),
    questions: buildEvidenceStrength({
      claimedBehavior: "login rejects bad password",
      beforeExitCode: 1,
      afterExitCode: 0,
      targeted: true,
      newTestAdded: true,
      changedFiles: ["login.ts"],
    }).questions,
    mockedAnswers: {
      establishes_claim: { kind: "noul", probability: 0.93 },
      strength: { kind: "score", score: "strong", probabilities: { strong: 0.8 }, confidence: 0.9 },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
  {
    name: "evidence: low confidence → UNKNOWN (insufficient)",
    useCase: "evidence-strength",
    state: minimizeState(
      buildEvidenceStrength({
        claimedBehavior: "cache invalidates",
        beforeExitCode: 0,
        afterExitCode: 0,
        targeted: false,
        newTestAdded: false,
        changedFiles: [],
      }).state,
    ),
    questions: buildEvidenceStrength({
      claimedBehavior: "cache invalidates",
      beforeExitCode: 0,
      afterExitCode: 0,
      targeted: false,
      newTestAdded: false,
      changedFiles: [],
    }).questions,
    mockedAnswers: {
      establishes_claim: { kind: "noul", probability: 0.4 },
      strength: {
        kind: "score",
        score: "moderate",
        probabilities: { moderate: 0.4 },
        confidence: 0.3,
      },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
  // ── E4 risk ──
  {
    name: "risk: semantic medium ≤ deterministic medium → stays medium (no step-down)",
    useCase: "risk-refinement",
    state: minimizeState(
      buildRiskRefinement({
        taskSummary: "auth tweak",
        changedFiles: ["token.ts"],
        dependents: 3,
        testsAffected: 2,
        criticalPath: false,
        deterministicLevel: "medium",
        ownershipEnforced: true,
      }).state,
    ),
    questions: buildRiskRefinement({
      taskSummary: "auth tweak",
      changedFiles: ["token.ts"],
      dependents: 3,
      testsAffected: 2,
      criticalPath: false,
      deterministicLevel: "medium",
      ownershipEnforced: true,
    }).questions,
    mockedAnswers: {
      risk_level: { kind: "score", score: "low", probabilities: { low: 0.8 }, confidence: 0.9 },
      security_sensitive: { kind: "noul", probability: 0.2 },
      requires_review: { kind: "noul", probability: 0.2 },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
  // ── E5 failure cause ──
  {
    name: "failure: Jev TYPE_ERROR with confidence → accepted taxonomy value",
    useCase: "failure-cause",
    state: minimizeState(buildFailureCause("TS2345: argument type mismatch").state),
    questions: buildFailureCause("TS2345: argument type mismatch").questions,
    mockedAnswers: {
      cause: {
        kind: "choice",
        choice: "TYPE_ERROR",
        probabilities: { TYPE_ERROR: 0.88, UNKNOWN: 0.05 },
        confidence: 0.88,
      },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
  {
    name: "failure: Jev low confidence → stays UNKNOWN",
    useCase: "failure-cause",
    state: minimizeState(buildFailureCause("weird stack").state),
    questions: buildFailureCause("weird stack").questions,
    mockedAnswers: {
      cause: {
        kind: "choice",
        choice: "TOOL_FAILURE",
        probabilities: { TOOL_FAILURE: 0.4 },
        confidence: 0.35,
      },
    },
    deterministic: "ALLOW",
    mode: "enforce",
    expectedFinal: "ALLOW",
  },
];

async function runCase(c: BenchCase): Promise<{ final: string; semantic: string | null }> {
  // The critic-triage case models the REAL path through triageCritic (the
  // obvious-pass skip is a documented triage exception, not a generic relax).
  if (c.useCase === "critic-triage") {
    const events: Array<Record<string, unknown>> = [];
    const provider: DecisionProvider = {
      id: "mock-jev",
      available: () => true,
      async evaluate(_state, questions) {
        const answers: DecisionAnswers = {};
        for (const id of Object.keys(questions)) {
          const mocked = c.mockedAnswers[id];
          if (mocked !== undefined) answers[id] = mocked;
        }
        return { ok: true, answers, latencyMs: 25 };
      },
    };
    return triageCritic(
      {
        evaluator: provider,
        mode: c.mode,
        runId: "bench",
        taskId: null,
        record: (input) => {
          events.push({ useCase: input.useCase });
        },
      },
      {
        taskGoal: String(c.state.task ?? ""),
        acceptanceCriteria: [],
        artifacts: [],
        summary: String(c.state.builderSummary ?? ""),
      },
    ).then((r) => ({ final: r.skipCritic ? "ALLOW" : "REQUIRE_APPROVAL", semantic: null }));
  }
  const evaluation: DecisionEvaluation = {
    ok: true,
    answers: c.mockedAnswers,
    latencyMs: 25,
    status: 200,
  };
  const combined = combineDecision(c.deterministic, evaluation, c.mode, DEFAULT_DECISION_POLICY);
  return { final: combined.outcome.verdict, semantic: combined.shadowSemantic?.verdict ?? null };
}

describe("decision-bench (policy+wiring fixtures, mocked Jev, offline)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const result = await runCase(c);
      expect(result.final).toBe(c.expectedFinal);
    });
  }

  it("all questions are well-formed for the TypeSafe wire format", () => {
    for (const c of CASES) {
      for (const q of Object.values(c.questions)) {
        if (q.type === "choice") {
          const count = Object.keys(q.criteria).length;
          expect(count).toBeGreaterThanOrEqual(1);
          expect(count).toBeLessThanOrEqual(255);
        }
        if (q.type === "score") {
          expect(q.levels.length).toBeGreaterThanOrEqual(2);
          expect(q.levels.length).toBeLessThanOrEqual(10);
        }
      }
    }
  });
});
