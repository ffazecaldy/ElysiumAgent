/**
 * packages/cli/src/evaluation/task-outcome.ts — the Task Outcome layer (F-02/F-04).
 *
 * / Distinzione esplicita tra successo dei componenti e successo del task.
 *
 * Pipeline: Evidence → Component Outcomes → Task Outcome → Evaluation Verdict
 * → Learning Record. The local gate matrix (critic/git/rollback postconditions)
 * measures HARNESS HEALTH; this module measures the TASK-level outcome from
 * explicitly observed component states. A green critic can never upgrade a
 * failed task to PASS, and a security violation is NEVER PASS.
 *
 * Deterministic, pure, no model in the loop. Component states come from
 * explicit observations only — the absence of an observation is `not_run`
 * (which never contributes to PASS), never an inferred `passed`.
 */

/** Observation state of one required-dimension component. */
export type ComponentState = "passed" | "failed" | "not_run" | "not_applicable";

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
  return v === "passed" || v === "failed" || v === "not_run" || v === "not_applicable";
}

/**
 * Deterministic task-level classification. Rule order IS the priority order
 * (security > required-component failure > claim/outcome agreement):
 *
 * 1. securityViolation=true  → FALSE_SUCCESS with a success-flavoured claim,
 *    FAIL without. NEVER PASS — security deny outranks everything.
 * 2. tests/build state "failed" → FAIL (a required component failed; partial
 *    suites map to "failed").
 * 3. "not_applicable" components are ignored entirely.
 * 4. "not_run" never contributes to PASS: PASS is allowed only when at least
 *    one verified-true postcondition exists AND the claim is success-flavoured;
 *    otherwise the run is INSUFFICIENT (unverifiable, not trusted).
 * 5. Non-matching claim (failure/insufficiency language) + every applicable
 *    component passed + ≥1 verified postcondition → FALSE_FAILURE.
 * 6. No verifiable facts anywhere → INSUFFICIENT.
 * 7. All applicable components passed + success-flavoured claim → PASS.
 */
export function computeTaskOutcome(input: TaskOutcomeInput): TaskOutcomeResult {
  const claim = typeof input.claim === "string" ? input.claim : "";
  const successClaimed = claim.length > 0 && SUCCESS_CLAIM_RE.test(claim);

  // (1) Security violation: security deny outranks every other signal.
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

  // (2) A required component failed → task FAIL.
  if (tests === "failed" || build === "failed") {
    return {
      outcome: "FAIL",
      reason: `required component failed: ${tests === "failed" ? "tests" : "build"}`,
    };
  }
  // A failed local postcondition also fails the task (deterministic fact).
  if (postFailed) {
    return { outcome: "FAIL", reason: "a postcondition failed" };
  }

  const applicableComponents: ComponentState[] = [];
  if (tests !== "not_applicable") applicableComponents.push(tests);
  if (build !== "not_applicable") applicableComponents.push(build);
  const allApplicablePassed =
    applicableComponents.length > 0 && applicableComponents.every((c) => c === "passed");
  const anyNotRun = applicableComponents.some((c) => c === "not_run");

  // (6) Nothing verifiable anywhere → INSUFFICIENT.
  const verifiable =
    applicableComponents.some((c) => c === "passed") || postVerifiedTrue || claim.length > 0;
  if (!verifiable) {
    return { outcome: "INSUFFICIENT", reason: "no verifiable facts observed" };
  }

  // (4) not_run never contributes to PASS; an empty applicable set is decided
  // by postconditions + claim alone (rule 5 applies vacuously there).
  if (applicableComponents.length === 0) {
    if (postVerifiedTrue) {
      return successClaimed
        ? { outcome: "PASS", reason: "verified postconditions + success claim" }
        : { outcome: "FALSE_FAILURE", reason: "failure claim contradicted by verified facts" };
    }
    return { outcome: "INSUFFICIENT", reason: "no applicable components and no verified facts" };
  }
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

  // (5) Claim/outcome disagreement: claimed failure but everything passed.
  if (!successClaimed && allApplicablePassed && postVerifiedTrue) {
    return { outcome: "FALSE_FAILURE", reason: "failure claim contradicted by verified facts" };
  }

  // (7) Everything applicable passed.
  if (allApplicablePassed) {
    if (!successClaimed) {
      // Components passed but the agent never claimed success and there are
      // no verified postconditions to carry the claim side: insufficient.
      return postVerifiedTrue
        ? { outcome: "FALSE_FAILURE", reason: "failure claim contradicted by verified facts" }
        : { outcome: "INSUFFICIENT", reason: "components passed but claim unverifiable" };
    }
    return { outcome: "PASS", reason: "all applicable components passed + success claim" };
  }

  // Mixed states (e.g. only claim present) → insufficient.
  return { outcome: "INSUFFICIENT", reason: "insufficient component observations" };
}
