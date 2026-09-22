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
 * ComponentState = "passed" | "failed" | "not_run" | "unknown" |
 *                  "not_applicable".
 *
 * The exhaustive-matrix test at the bottom walks ALL 5×5 component-state
 * pairs × 3 claim kinds × 2 security flags × 4 postcondition shapes (600
 * combinations) and proves totality by construction: every combination maps
 * to exactly one of the five outcomes, matching the documented rule table,
 * and no combination with an `unknown` required component ever yields PASS.
 */
import { describe, expect, it } from "vitest";
import {
  type ComponentState,
  type TaskOutcomeResult,
  computeTaskOutcome,
} from "../src/evaluation/task-outcome";

const ALL_STATES: ComponentState[] = ["passed", "failed", "not_run", "unknown", "not_applicable"];

type PostShape = "all-true" | "some-false" | "all-null" | "empty";

const POSTCONDITIONS: Record<PostShape, Array<{ name: string; ok: boolean | null }>> = {
  "all-true": [
    { name: "critic:passed", ok: true },
    { name: "rollback:clean", ok: true },
  ],
  "some-false": [
    { name: "critic:passed", ok: true },
    { name: "rollback:clean", ok: false },
  ],
  "all-null": [{ name: "critic:passed", ok: null }],
  empty: [],
};

type ClaimKind = "success" | "failure" | "absent";

const CLAIMS: Record<ClaimKind, string | undefined> = {
  success: "everything green. Task success.",
  failure: "could not verify anything, failure",
  absent: undefined,
};

function run(
  tests: ComponentState,
  build: ComponentState,
  claimKind: ClaimKind,
  security: boolean,
  postShape: PostShape,
): TaskOutcomeResult {
  return computeTaskOutcome({
    claim: CLAIMS[claimKind],
    securityViolation: security ? true : undefined,
    tests,
    build,
    postconditions: POSTCONDITIONS[postShape],
  });
}

/** Independent restatement of the documented rule table (R1..R10). */
function expectedOutcome(
  tests: ComponentState,
  build: ComponentState,
  claimKind: ClaimKind,
  security: boolean,
  postShape: PostShape,
): TaskOutcomeResult["outcome"] {
  const successClaim = claimKind === "success";
  const postFailed = postShape === "some-false";
  const postVerified = postShape === "all-true";
  // R1: security > everything.
  if (security) return successClaim ? "FALSE_SUCCESS" : "FAIL";
  // R2: required component failed.
  if (tests === "failed" || build === "failed") return "FAIL";
  // R3: observed postcondition failure.
  if (postFailed) return "FAIL";
  // R4: uninterpretable required dimension can never certify success.
  if (tests === "unknown" || build === "unknown") return "INSUFFICIENT";
  const applicable = [tests, build].filter((s) => s !== "not_applicable");
  const allPassed = applicable.length > 0 && applicable.every((s) => s === "passed");
  const verifiable =
    applicable.some((s) => s === "passed") || postVerified || claimKind !== "absent";
  // R5: nothing verifiable anywhere.
  if (!verifiable) return "INSUFFICIENT";
  // R10: not_applicable-only — decided by postconditions + claim.
  if (applicable.length === 0) {
    if (postVerified) return successClaim ? "PASS" : "FALSE_FAILURE";
    return "INSUFFICIENT";
  }
  // R6: not_run gates PASS behind verified postconditions + success claim.
  if (applicable.some((s) => s === "not_run")) {
    return postVerified && successClaim ? "PASS" : "INSUFFICIENT";
  }
  // R8: failure claim contradicted by verified facts.
  if (!successClaim && allPassed && postVerified) return "FALSE_FAILURE";
  // R7/R9.
  if (allPassed) return successClaim ? "PASS" : "INSUFFICIENT";
  return "INSUFFICIENT";
}

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

  it("required component UNKNOWN is INSUFFICIENT and reported distinctly (never coerced)", () => {
    const r = computeTaskOutcome({
      claim: "output garbled but looks fine. Task success.",
      tests: "unknown",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(r.outcome).toBe("INSUFFICIENT");
    expect(r.reason).toContain("unknown");
    // Distinct from not_run: not_run + verified postcondition + success claim
    // PASSes; the same input with unknown must NOT.
    const notRun = computeTaskOutcome({
      claim: "output garbled but looks fine. Task success.",
      tests: "not_run",
      postconditions: [{ name: "critic:passed", ok: true }],
    });
    expect(notRun.outcome).toBe("PASS");
    expect(r.outcome).not.toBe(notRun.outcome);
  });

  it("build UNKNOWN is INSUFFICIENT even when tests passed + success claim", () => {
    const r = computeTaskOutcome({
      claim: "build log unreadable. Task success.",
      tests: "passed",
      build: "unknown",
    });
    expect(r.outcome).toBe("INSUFFICIENT");
    expect(r.reason).toContain("build");
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

describe("task outcome classification (exhaustive total matrix)", () => {
  it("every (tests,build)×claim×security×postcondition combination maps to exactly one documented outcome", () => {
    const statePairs: Array<[ComponentState, ComponentState]> = [];
    for (const t of ALL_STATES) {
      for (const b of ALL_STATES) statePairs.push([t, b]);
    }
    const claimKinds: ClaimKind[] = ["success", "failure", "absent"];
    const postShapes: PostShape[] = ["all-true", "some-false", "all-null", "empty"];

    let count = 0;
    for (const [t, b] of statePairs) {
      for (const claimKind of claimKinds) {
        for (const security of [true, false]) {
          for (const postShape of postShapes) {
            count += 1;
            const r = run(t, b, claimKind, security, postShape);
            // Totality: always exactly one of the five outcomes, non-empty reason.
            expect(["PASS", "FAIL", "INSUFFICIENT", "FALSE_SUCCESS", "FALSE_FAILURE"]).toContain(
              r.outcome,
            );
            expect(r.reason.length).toBeGreaterThan(0);
            // Rule-table agreement.
            expect(r.outcome).toBe(expectedOutcome(t, b, claimKind, security, postShape));
            // UNKNOWN invariant: without a security violation, an
            // uninterpretable required component never yields PASS, and when
            // the unknown dimension is what decides (R4), the reason reports
            // it distinctly. Earlier rules (R2/R3 hard failures) may fire
            // first — a failed postcondition is a deterministic fact that
            // outranks the uninterpretable dimension.
            if (!security && (t === "unknown" || b === "unknown")) {
              expect(r.outcome).not.toBe("PASS");
              if (r.outcome === "INSUFFICIENT") {
                expect(r.reason).toContain("unknown");
              }
            }
          }
        }
      }
    }
    expect(count).toBe(5 * 5 * 3 * 2 * 4);
  });
});
