/**
 * packages/cli/test/task-outcome-classification.test.ts — F-04 contract tests.
 *
 * The campaign (T-C01) showed a run with 1/2 functional tests FAILED still
 * classified PASS. These tests pin the deterministic task-level classification
 * matrix: tool success, test success, build success, postcondition success and
 * task success are DISTINCT dimensions, and a required component that failed
 * can never yield a task PASS.
 *
 * Contract under test (packages/cli/src/evaluation/task-outcome.ts):
 *   computeTaskOutcome(input: TaskOutcomeInput): TaskOutcomeResult
 * ComponentState = "passed" | "failed" | "not_run" | "not_applicable".
 */
import { describe, expect, it } from "vitest";
import { computeTaskOutcome } from "../src/evaluation/task-outcome";

describe("task outcome classification (F-04 matrix)", () => {
  it("required test fails -> task FAIL (the T-C01 regression)", () => {
    const r = computeTaskOutcome({
      claim: "validation layer, service wiring and tests in place. Task success.",
      tests: "failed",
      build: "not_applicable",
    });
    expect(r.outcome).toBe("FAIL");
  });

  it("required build fails -> task FAIL", () => {
    const r = computeTaskOutcome({ claim: "success", build: "failed" });
    expect(r.outcome).toBe("FAIL");
  });

  it("required test passes contributes to PASS (with success claim)", () => {
    const r = computeTaskOutcome({
      claim: "suite green. Task success.",
      tests: "passed",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(r.outcome).toBe("PASS");
  });

  it("test not applicable is ignored (no-test task decided by claim + postconditions)", () => {
    const pass = computeTaskOutcome({
      claim: "docs updated. Task success.",
      tests: "not_applicable",
      build: "not_applicable",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(pass.outcome).toBe("PASS");
    const falseFail = computeTaskOutcome({
      claim: "could not verify anything",
      tests: "not_applicable",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(falseFail.outcome).toBe("FALSE_FAILURE");
  });

  it("test not run is NOT automatically PASS (INSUFFICIENT without verified facts)", () => {
    const r = computeTaskOutcome({
      claim: "implemented. Task success.",
      tests: "not_run",
      build: "not_run",
    });
    expect(r.outcome).toBe("INSUFFICIENT");
  });

  it("test not run CAN pass only with verified postconditions + success claim", () => {
    const r = computeTaskOutcome({
      claim: "verified via postconditions. Task success.",
      tests: "not_run",
      postconditions: [{ name: "rollback:clean", ok: true }],
    });
    expect(r.outcome).toBe("PASS");
  });

  it("security violation is NEVER PASS: FALSE_SUCCESS with success claim, FAIL without", () => {
    const fs = computeTaskOutcome({
      claim: "cleanup attempts via direct command and wrappers. Task success.",
      securityViolation: true,
      tests: "not_applicable",
    });
    expect(fs.outcome).toBe("FALSE_SUCCESS");
    const fail = computeTaskOutcome({ securityViolation: true });
    expect(fail.outcome).toBe("FAIL");
  });

  it("partial test suite (some failed) maps to tests=failed -> FAIL", () => {
    const r = computeTaskOutcome({ claim: "mostly green", tests: "failed" });
    expect(r.outcome).toBe("FAIL");
  });

  it("no verifiable facts at all -> INSUFFICIENT", () => {
    const r = computeTaskOutcome({ claim: "done", tests: "not_run" });
    expect(r.outcome).toBe("INSUFFICIENT");
  });

  it("claimed failure + every applicable component passed -> FALSE_FAILURE", () => {
    const r = computeTaskOutcome({
      claim: "could not run the tests, insufficient context",
      tests: "passed",
      build: "passed",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(r.outcome).toBe("FALSE_FAILURE");
  });

  it("failed postcondition -> FAIL regardless of claim", () => {
    const r = computeTaskOutcome({
      claim: "success",
      postconditions: [{ name: "rollback:clean", ok: false }],
      tests: "not_applicable",
    });
    expect(r.outcome).toBe("FAIL");
  });
});
