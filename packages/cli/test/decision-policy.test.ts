/** Decision Layer tests — policy combination, sanitize minimization,
 * question builders, decision records. All pure. */
import { describe, expect, it } from "vitest";
import { buildDecisionRecord, decisionEvent, resetDecisionIds } from "../src/decision/fingerprint";
import {
  DEFAULT_DECISION_POLICY,
  type DecisionMode,
  combineDecision,
} from "../src/decision/policy";
import type { DecisionEvaluation } from "../src/decision/provider";
import {
  FAILURE_CAUSE_LEVELS,
  buildBashGrayZone,
  buildCriticTriage,
  buildEvidenceStrength,
  buildFailureCause,
  buildRiskRefinement,
} from "../src/decision/questions";
import { minimizeState, stateHash } from "../src/decision/sanitize";

function evaluation(answers: DecisionEvaluation["answers"], ok = true): DecisionEvaluation {
  return { ok, answers, latencyMs: 42 };
}

describe("combineDecision — the authority boundary", () => {
  it("deterministic DENY wins in every mode, Jev is not even consulted for the verdict", () => {
    const risky = evaluation({
      destructive: { kind: "noul", probability: 0.01 },
      risk: { kind: "score", score: "low", probabilities: {}, confidence: 0.99 },
    });
    for (const mode of ["off", "shadow", "enforce"] as DecisionMode[]) {
      const combined = combineDecision("DENY", risky, mode);
      expect(combined.outcome.verdict).toBe("DENY");
      expect(combined.outcome.source).toBe("deterministic");
    }
  });

  it("deterministic ALLOW + low semantic risk → ALLOW (enforce)", () => {
    const safe = evaluation({
      destructive: { kind: "noul", probability: 0.02 },
      risk: { kind: "score", score: "low", probabilities: {}, confidence: 0.9 },
    });
    const combined = combineDecision("ALLOW", safe, "enforce");
    expect(combined.outcome.verdict).toBe("ALLOW");
    expect(combined.outcome.source).toBe("semantic");
  });

  it("deterministic ALLOW + high semantic risk → REQUIRE_APPROVAL (escalation only)", () => {
    const risky = evaluation({
      destructive: { kind: "noul", probability: 0.93 },
      risk: { kind: "score", score: "high", probabilities: {}, confidence: 0.88 },
    });
    const combined = combineDecision("ALLOW", risky, "enforce");
    expect(combined.outcome.verdict).toBe("REQUIRE_APPROVAL");
  });

  it("uncertain confidence → conservative (REQUIRE_APPROVAL)", () => {
    const uncertain = evaluation({
      destructive: { kind: "noul", probability: 0.5 },
      risk: { kind: "score", score: "medium", probabilities: {}, confidence: 0.3 },
    });
    const combined = combineDecision("ALLOW", uncertain, "enforce", {
      ...DEFAULT_DECISION_POLICY,
      uncertainBelow: 0.5,
    });
    expect(combined.outcome.verdict).toBe("REQUIRE_APPROVAL");
    expect(combined.outcome.reason).toContain("uncertain");
  });

  it("semantic can never relax a deterministic REQUIRE_APPROVAL", () => {
    const safe = evaluation({
      destructive: { kind: "noul", probability: 0.01 },
      risk: { kind: "score", score: "low", probabilities: {}, confidence: 0.95 },
    });
    const combined = combineDecision("REQUIRE_APPROVAL", safe, "enforce");
    expect(combined.outcome.verdict).toBe("REQUIRE_APPROVAL");
  });

  it("provider unavailable → historical fallback", () => {
    const failed = evaluation({}, false);
    failed.errorClass = "timeout";
    failed.fallbackReason = "typesafe timeout";
    const combined = combineDecision("ALLOW", failed, "enforce");
    expect(combined.outcome.verdict).toBe("ALLOW");
    expect(combined.outcome.source).toBe("fallback");
    const off = combineDecision("ALLOW", evaluation({}), "off");
    expect(off.outcome.verdict).toBe("ALLOW");
    const none = combineDecision("ALLOW", null, "enforce");
    expect(none.outcome.verdict).toBe("ALLOW");
  });

  it("shadow mode: verdict stays deterministic, semantic rides along", () => {
    const risky = evaluation({
      destructive: { kind: "noul", probability: 0.93 },
      risk: { kind: "score", score: "high", probabilities: {}, confidence: 0.9 },
    });
    const combined = combineDecision("ALLOW", risky, "shadow");
    expect(combined.outcome.verdict).toBe("ALLOW");
    expect(combined.outcome.source).toBe("deterministic");
    expect(combined.shadowSemantic?.verdict).toBe("REQUIRE_APPROVAL");
  });
});

describe("minimizeState — the state boundary", () => {
  it("drops forbidden keys (env, raw output, transcript, full diff)", () => {
    const state = minimizeState({
      command: "npm test",
      env: { OPENAI_API_KEY: "sk-abc123" },
      rawOutput: "secret payload",
      transcript: "everything the agent said",
      diff: "full diff text",
      stdout: "tool output",
    });
    expect(Object.keys(state)).toEqual(["command"]);
  });

  it("redacts builtin secret patterns inside kept strings", () => {
    const state = minimizeState({ summary: `deploy with ghp_${"x".repeat(30)}` });
    expect(JSON.stringify(state)).not.toContain("x".repeat(30));
    expect(JSON.stringify(state)).toContain("***REDACTED:github_token***");
  });

  it("redacts exact secret values and caps long strings deterministically", () => {
    const secret = "hunter2hunter2";
    const state = minimizeState({ note: `the password is ${secret}`, long: "a".repeat(2000) }, [
      secret,
    ]);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect((state.note as string).length).toBeLessThan(100);
    expect(stateHash(state)).toBe(
      stateHash(
        minimizeState({ note: `the password is ${secret}`, long: "a".repeat(2000) }, [secret]),
      ),
    );
    expect(stateHash(state)).not.toBe(stateHash(minimizeState({ note: "different" })));
  });

  it("truncates long lists", () => {
    const files = Array.from({ length: 100 }, (_, i) => `file-${i}.ts`);
    const state = minimizeState({ changedFiles: files });
    expect((state.changedFiles as string[]).length).toBe(24);
  });
});

describe("question builders", () => {
  it("bash gray-zone asks atomic destructive + risk questions with minimal state", () => {
    const q = buildBashGrayZone({
      command: "python migrate.py",
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    });
    expect(q.state).toEqual({
      kind: "bash-command",
      command: "python migrate.py",
      cwd: "/repo",
      writableRoots: ["/repo"],
      networkAllowed: false,
    });
    expect(q.questions.destructive?.type).toBe("noul");
    expect(q.questions.risk?.type).toBe("score");
  });

  it("critic triage, evidence strength, risk refinement, failure cause build minimal states", () => {
    expect(
      buildCriticTriage({
        taskGoal: "g",
        acceptanceCriteria: ["a"],
        artifacts: ["f"],
        summary: "s",
      }).state.kind,
    ).toBe("critic-triage");
    const ev = buildEvidenceStrength({
      claimedBehavior: "login rejects bad password",
      beforeExitCode: 1,
      afterExitCode: 0,
      targeted: true,
      newTestAdded: true,
      changedFiles: ["src/login.ts"],
    });
    expect(ev.state.kind).toBe("evidence-strength");
    expect(ev.questions.strength?.type).toBe("score");
    const risk = buildRiskRefinement({
      taskSummary: "refactor auth",
      changedFiles: ["src/auth/token.ts"],
      dependents: 14,
      testsAffected: 8,
      criticalPath: true,
      deterministicLevel: "high",
      ownershipEnforced: true,
    });
    expect(risk.questions.security_sensitive?.type).toBe("noul");
    const cause = buildFailureCause("TypeError: cannot read property x of undefined");
    const causeQuestion = cause.questions.cause;
    expect(causeQuestion?.type).toBe("choice");
    const criteria = causeQuestion?.type === "choice" ? causeQuestion.criteria : {};
    expect(Object.keys(criteria).sort()).toEqual([...FAILURE_CAUSE_LEVELS].sort());
  });
});

describe("decision records", () => {
  it("builds a complete record and emits an event with the decision fingerprint", () => {
    resetDecisionIds();
    const state = { kind: "bash-command", command: "python migrate.py" };
    const record = buildDecisionRecord({
      runId: "run-1",
      taskId: "T-7",
      useCase: "bash-gray-zone",
      providerId: "typesafe-jev",
      mode: "shadow",
      outcome: {
        verdict: "REQUIRE_APPROVAL",
        source: "deterministic",
        reason: "shadow mode: historical behavior preserved",
      },
      semantic: { verdict: "ALLOW", source: "semantic", reason: "risk 0.15" },
      evaluation: evaluation({
        destructive: { kind: "noul", probability: 0.02 },
        risk: { kind: "score", score: "low", probabilities: { low: 0.9 }, confidence: 0.9 },
      }),
      state,
    });
    expect(record.decisionId).toMatch(/^D-run-1-1:/);
    expect(record.confidence).toBe(0.9);
    expect(record.stateHash).toHaveLength(16);
    expect(record.semantic?.verdict).toBe("ALLOW");
    const event = decisionEvent(record);
    expect(event.type).toBe("custom");
    expect(event.data.kind).toBe("decision");
    expect(event.data.useCase).toBe("bash-gray-zone");
    expect(event.data.verdict).toBe("REQUIRE_APPROVAL");
    expect(event.data.semanticVerdict).toBe("ALLOW");
    expect(event.data.stateHash).toBe(record.stateHash);
  });

  it("records are unique per call even for identical state", () => {
    resetDecisionIds();
    const input = {
      runId: "run-2",
      taskId: null,
      useCase: "bash-gray-zone" as const,
      providerId: "typesafe-jev",
      mode: "shadow" as DecisionMode,
      outcome: { verdict: "ALLOW" as const, source: "fallback" as const, reason: "off" },
      semantic: null,
      evaluation: null,
      state: { same: true },
    };
    const a = buildDecisionRecord(input);
    const b = buildDecisionRecord(input);
    expect(a.decisionId).not.toBe(b.decisionId);
    expect(a.stateHash).toBe(b.stateHash);
  });
});
