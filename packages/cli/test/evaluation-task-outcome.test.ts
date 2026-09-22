/**
 * packages/cli/test/evaluation-task-outcome.test.ts — F-02 tests.
 *
 * The Evaluation Layer must distinguish harness-gate health from the
 * task-level outcome, and a task-level failure must degrade the recorded
 * verdict (never upgraded to PASS by green local gates). Learning must
 * reflect real failures so failure patterns stay derivable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvaluationRecord, EvidenceItem, Postcondition } from "../src/evaluation";
import { evaluateEvidence } from "../src/evaluation/evaluate";
import { computeTaskOutcome } from "../src/evaluation/task-outcome";
import { createLearningEngine } from "../src/learning/runtime";

function item(
  kind: EvidenceItem["kind"],
  facts: Record<string, unknown>,
  claim?: string,
): EvidenceItem {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    kind,
    at: new Date().toISOString(),
    source: "report",
    facts,
    ...(claim !== undefined ? { claim } : {}),
  };
}

function post(name: string, ok: boolean | null): Postcondition {
  return { name, expected: {}, observed: {}, ok };
}

function record(verdict: EvaluationRecord["verdict"], score: number): EvaluationRecord {
  return {
    id: `EV-test-${Math.random().toString(36).slice(2)}`,
    runId: "run-test",
    taskId: null,
    verdict,
    score,
    confidence: 0.5,
    postconditions: [post("critic-verified", verdict === "PASS")],
    evidence: [],
    createdAt: new Date().toISOString(),
    fallbackReason: null,
  };
}

describe("computeTaskOutcome (F-02 unit matrix)", () => {
  it("security violation + success claim -> FALSE_SUCCESS (never PASS)", () => {
    const r = computeTaskOutcome({
      claim: "cleanup attempts via direct command and wrappers. Task success.",
      securityViolation: true,
      tests: "not_applicable",
    });
    expect(r.outcome).toBe("FALSE_SUCCESS");
  });

  it("security violation without claim -> FAIL", () => {
    const r = computeTaskOutcome({ securityViolation: true });
    expect(r.outcome).toBe("FAIL");
  });

  it("tests failed -> FAIL (T-C01 class)", () => {
    const r = computeTaskOutcome({ claim: "success", tests: "failed" });
    expect(r.outcome).toBe("FAIL");
  });

  it("not_applicable components are ignored (postcondition-carried PASS)", () => {
    const r = computeTaskOutcome({
      claim: "docs updated. Task success.",
      tests: "not_applicable",
      build: "not_applicable",
      postconditions: [{ name: "critic-verified", ok: true }],
    });
    expect(r.outcome).toBe("PASS");
  });

  it("not_run without verified postconditions -> INSUFFICIENT (never PASS)", () => {
    const r = computeTaskOutcome({ claim: "implemented. Task success.", tests: "not_run" });
    expect(r.outcome).toBe("INSUFFICIENT");
  });

  it("not_run + verified postcondition + success claim -> PASS", () => {
    const r = computeTaskOutcome({
      claim: "Task success.",
      tests: "not_run",
      postconditions: [{ name: "critic-verified", ok: true }],
    });
    expect(r.outcome).toBe("PASS");
  });

  it("claimed failure + all components passed + verified postcondition -> FALSE_FAILURE", () => {
    const r = computeTaskOutcome({
      claim: "could not verify anything",
      tests: "passed",
      postconditions: [{ name: "critic-verified", ok: true }],
    });
    expect(r.outcome).toBe("FALSE_FAILURE");
  });

  it("all applicable passed + success claim -> PASS", () => {
    const r = computeTaskOutcome({
      claim: "suite green. Task success.",
      tests: "passed",
      build: "passed",
    });
    expect(r.outcome).toBe("PASS");
  });

  it("failed postcondition -> FAIL regardless of claim", () => {
    const r = computeTaskOutcome({
      claim: "success",
      tests: "not_applicable",
      postconditions: [{ name: "rollback-restored-workspace", ok: false }],
    });
    expect(r.outcome).toBe("FAIL");
  });

  it("nothing verifiable -> INSUFFICIENT", () => {
    const r = computeTaskOutcome({ claim: "done", tests: "not_run" });
    expect(r.outcome).toBe("INSUFFICIENT");
  });
});

describe("evaluator fold (F-02: task outcome degrades, never upgrades)", () => {
  it("task_outcome FALSE_SUCCESS degrades an all-green local matrix", () => {
    const r = evaluateEvidence(
      [
        item("task_outcome", { outcome: "FALSE_SUCCESS", reason: "violation" }),
        item("claim", {}, "Task success."),
      ],
      [post("rollback-restored-workspace", true), post("critic-verified", true)],
    );
    expect(r.verdict).toBe("FALSE_SUCCESS");
    expect(r.score).toBe(1);
  });

  it("task_outcome FAIL degrades a local PASS", () => {
    const r = evaluateEvidence(
      [item("task_outcome", { outcome: "FAIL", reason: "tests failed" })],
      [post("critic-verified", true)],
    );
    expect(r.verdict).toBe("FAIL");
  });

  it("task_outcome FALSE_FAILURE replaces a local PASS", () => {
    const r = evaluateEvidence(
      [item("task_outcome", { outcome: "FALSE_FAILURE", reason: "claim contradicted" })],
      [post("critic-verified", true)],
    );
    expect(r.verdict).toBe("FALSE_FAILURE");
  });

  it("task_outcome PASS never upgrades a local FALSE_SUCCESS", () => {
    const r = evaluateEvidence(
      [
        item("task_outcome", { outcome: "PASS", reason: "components passed" }),
        item("claim", {}, "Task success."),
      ],
      [post("rollback-restored-workspace", false), post("critic-verified", true)],
    );
    expect(r.verdict).toBe("FALSE_SUCCESS");
  });

  it("security_event evidence alone does not change a verdict without a task_outcome (observe-only)", () => {
    const r = evaluateEvidence(
      [item("security_event", { tool: "bash", blocked: true, reason: "deny" })],
      [post("critic-verified", true)],
    );
    expect(r.verdict).toBe("PASS");
  });

  it("no task_outcome -> verdict unchanged (backward compatible)", () => {
    const r = evaluateEvidence(
      [item("claim", {}, "Task success.")],
      [post("critic-verified", true)],
    );
    expect(r.verdict).toBe("PASS");
  });
});

describe("learning reflects real failures (F-02 end-to-end)", () => {
  it("FALSE_SUCCESS record ingests as failure pattern + falseSuccessRate > 0", () => {
    const root = mkdtempSync(path.join(tmpdir(), "f02-learning-"));
    const learning = createLearningEngine(root);
    learning.recordLearning(record("FALSE_SUCCESS", 1), {
      goal: "clean up workspace",
      retryCount: 0,
    });
    learning.recordLearning(record("FALSE_SUCCESS", 1), {
      goal: "clean up workspace",
      retryCount: 0,
    });
    learning.recordLearning(record("PASS", 1), { goal: "create a module", retryCount: 0 });
    learning.recordLearning(record("PASS", 1), { goal: "fix the parser", retryCount: 0 });
    learning.recordLearning(record("PASS", 1), { goal: "write docs", retryCount: 0 });
    const profile = learning.profile();
    expect(profile.metrics.falseSuccessRate).toBeGreaterThan(0);
    const failurePatterns = profile.failurePatterns.map((p) => p.key);
    expect(failurePatterns.some((k) => k.includes("critic-verified"))).toBe(true);
  });

  it("FAIL record ingests as a failure outcome (not PASS)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "f02-learning2-"));
    const learning = createLearningEngine(root);
    learning.recordLearning(record("FAIL", 0.5), { goal: "clean workspace", retryCount: 1 });
    const runs = learning.loadStore().runs;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[runs.length - 1]?.outcome).toBe("FAIL");
    expect(runs[runs.length - 1]?.failedPostconditions).toContain("critic-verified");
  });
});
