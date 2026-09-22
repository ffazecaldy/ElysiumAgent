/**
 * packages/cli/src/evaluation/task-outcome.ts — the Task Outcome layer (F-02/F-04).
 *
 * / Distinzione esplicita tra successo dei componenti e successo del task.
 *
 * FINAL CONTRACT — five-state component vocabulary:
 *
 * ComponentState (exactly one of; NO nulls, NO free-form strings, NO
 * ambiguous booleans in this vocabulary):
 *   "passed"         the observation ran and verified green.
 *   "failed"         the observation ran and reported failure (partial suites
 *                    map to "failed").
 *   "not_run"        observation attempted but nothing verifiable came back
 *                    (or never attempted). Never contributes to PASS on its
 *                    own.
 *   "unknown"        observable-but-uninterpretable: an observation exists but
 *                    could not be interpreted into pass/fail. Behaves like
 *                    "not_run" for PASS-gating (never contributes to PASS) but
 *                    is reported DISTINCTLY in the reason and is never
 *                    silently coerced to "not_run" or "passed".
 *   "not_applicable" the dimension does not exist for this task (no-test /
 *                    no-build). Ignored entirely.
 *
 * Values outside this union coerce to "not_applicable" at the boundary
 * (absence of a valid observation) — never to "passed".
 *
 * TaskOutcome = "PASS" | "FAIL" | "INSUFFICIENT" | "FALSE_SUCCESS" |
 *               "FALSE_FAILURE".
 *
 * Rule table (rule order IS the priority order; security > everything):
 *   R1  securityViolation=true        → FALSE_SUCCESS with a success-flavoured
 *                                       claim, FAIL without. NEVER PASS.
 *   R2  tests|build == "failed"       → FAIL (required component failed).
 *   R3  any postcondition ok === false → FAIL (deterministic observed failure).
 *   R4  tests|build == "unknown"      → INSUFFICIENT (never PASS): an
 *                                       uninterpretable required dimension
 *                                       cannot certify success.
 *   R5  no verifiable facts anywhere  → INSUFFICIENT.
 *   R6  tests|build == "not_run"      → PASS only with ≥1 verified-true
 *                                       postcondition AND a success claim;
 *                                       otherwise INSUFFICIENT.
 *   R7  all applicable "passed" + success claim → PASS.
 *   R8  failure claim + all applicable "passed" + ≥1 verified postcondition
 *                                       → FALSE_FAILURE.
 *   R9  all applicable "passed", no success claim, no verified postcondition
 *                                       → INSUFFICIENT.
 *   R10 no applicable components      → decided by postconditions + claim
 *                                       alone; with no verified facts →
 *                                       INSUFFICIENT.
 *   "not_applicable" components are ignored entirely by R2/R4/R6/R7/R9.
 *
 * The classification matrix is TOTAL: every combination of (tests, build)
 * states × (success / failure / absent claim) × (securityViolation t/f) ×
 * (postconditions all-true / some-false / all-null / empty) maps to exactly
 * one outcome (proven by the exhaustive-matrix test).
 *
 * Pipeline: Evidence → Component Outcomes → Task Outcome → Evaluation Verdict
 * → Learning Record. The local gate matrix (critic/git/rollback postconditions)
 * measures HARNESS HEALTH; this module measures the TASK-level outcome from
 * explicitly observed component states. A green critic can never upgrade a
 * failed task to PASS, and a security violation is NEVER PASS.
 *
 * Deterministic, pure, no model in the loop.
 */

/** Observation state of one required-dimension component. */
export type ComponentState = "passed" | "failed" | "not_run" | "unknown" | "not_applicable";

/** Text that counts as a success claim (same vocabulary as the evaluator). */
const SUCCESS_CLAIM_RE = /success|succeeded|ok|completato/i;

export interface TaskOutcomeInput {
  claim?: string | undefined;
  /** True when the harness itself observed a security-relevant violation. */
  securityViolation?: boolean | undefined;
  tests?: ComponentState | undefined;
  build?: ComponentState | undefined;
  /** Local gate postconditions (critic/rollback/exit-code). */
  postconditions?: Array<{ name: string; ok: boolean | null }> | undefined;
}

export interface TaskOutcomeResult {
  outcome: "PASS" | "FAIL" | "INSUFFICIENT" | "FALSE_SUCCESS" | "FALSE_FAILURE";
  reason: string;
}

function isComponentState(v: unknown): v is ComponentState {
  return (
    v === "passed" || v === "failed" || v === "not_run" || v === "unknown" || v === "not_applicable"
  );
}

/**
 * Deterministic task-level classification. Implements the rule table in the
 * module header; the rules run in priority order (R1..R10) so the first match
 * wins. See the header for the total-matrix guarantee.
 */
export function computeTaskOutcome(input: TaskOutcomeInput): TaskOutcomeResult {
  const claim = typeof input.claim === "string" ? input.claim : "";
  const successClaimed = claim.length > 0 && SUCCESS_CLAIM_RE.test(claim);

  // (R1) Security violation: security deny outranks every other signal.
  if (input.securityViolation === true) {
    return successClaimed
      ? { outcome: "FALSE_SUCCESS", reason: "security violation observed under a success claim" }
      : { outcome: "FAIL", reason: "security violation observed" };
  }

  const tests = isComponentState(input.tests) ? input.tests : "not_applicable";
  const build = isComponentState(input.build) ? input.build : "not_applicable";
  const postconditions = Array.isArray(input.postconditions) ? input.postconditions : [];
  const postFailed = postconditions.some((p) => p.ok === false);
  const postVerifiedTrue = postconditions.some((p) => p.ok === true);

  // (R2) A required component failed → task FAIL.
  if (tests === "failed" || build === "failed") {
    return {
      outcome: "FAIL",
      reason: `required component failed: ${tests === "failed" ? "tests" : "build"}`,
    };
  }
  // (R3) A failed local postcondition also fails the task (deterministic fact).
  if (postFailed) {
    return { outcome: "FAIL", reason: "a postcondition failed" };
  }
  // (R4) A required component that is observable-but-uninterpretable can
  // never certify success — INSUFFICIENT, reported distinctly (never coerced
  // to not_run/passed, never PASS).
  if (tests === "unknown" || build === "unknown") {
    const dims = [tests === "unknown" ? "tests" : null, build === "unknown" ? "build" : null]
      .filter((d): d is string => d !== null)
      .join(", ");
    return {
      outcome: "INSUFFICIENT",
      reason: `required component observed but uninterpretable (unknown): ${dims}`,
    };
  }

  const applicableComponents: ComponentState[] = [];
  if (tests !== "not_applicable") applicableComponents.push(tests);
  if (build !== "not_applicable") applicableComponents.push(build);
  const allApplicablePassed =
    applicableComponents.length > 0 && applicableComponents.every((c) => c === "passed");
  const anyNotRun = applicableComponents.some((c) => c === "not_run");

  // (R5) Nothing verifiable anywhere → INSUFFICIENT.
  const verifiable =
    applicableComponents.some((c) => c === "passed") || postVerifiedTrue || claim.length > 0;
  if (!verifiable) {
    return { outcome: "INSUFFICIENT", reason: "no verifiable facts observed" };
  }

  // (R10) not_applicable-only runs are decided by postconditions + claim alone.
  if (applicableComponents.length === 0) {
    if (postVerifiedTrue) {
      return successClaimed
        ? { outcome: "PASS", reason: "verified postconditions + success claim" }
        : { outcome: "FALSE_FAILURE", reason: "failure claim contradicted by verified facts" };
    }
    return { outcome: "INSUFFICIENT", reason: "no applicable components and no verified facts" };
  }
  // (R6) not_run never contributes to PASS; PASS only via verified
  // postconditions + success claim.
  if (anyNotRun) {
    if (postVerifiedTrue && successClaimed) {
      // Explicit verified postconditions + success claim carry the run.
      return { outcome: "PASS", reason: "verified postconditions + success claim" };
    }
    return {
      outcome: "INSUFFICIENT",
      reason: "component not observed (not_run) and no verified postcondition carries the run",
    };
  }

  // (R8) Claim/outcome disagreement: claimed failure but everything passed.
  if (!successClaimed && allApplicablePassed && postVerifiedTrue) {
    return { outcome: "FALSE_FAILURE", reason: "failure claim contradicted by verified facts" };
  }

  // (R7)/(R9) Everything applicable passed.
  if (allApplicablePassed) {
    if (!successClaimed) {
      // (R9) Components passed but the agent never claimed success and there
      // are no verified postconditions to carry the claim side: insufficient.
      return { outcome: "INSUFFICIENT", reason: "components passed but claim unverifiable" };
    }
    return { outcome: "PASS", reason: "all applicable components passed + success claim" };
  }

  // Mixed states (e.g. only claim present) → insufficient.
  return { outcome: "INSUFFICIENT", reason: "insufficient component observations" };
}
