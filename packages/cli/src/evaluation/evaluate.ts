/**
 * packages/cli/src/evaluation/evaluate.ts — the deterministic verdict matrix.
 *
 * / Matrice dei verdetti deterministica, solo fatti: nessun modello nel loop.
 *
 * PURE: evaluateEvidence() reads facts and returns { verdict, score,
 * confidence } — no I/O, no clock, no randomness. Domain postcondition
 * builders (rollback / exit code / critic) share the same contract.
 */

import type { EvalVerdict, EvidenceEvaluation, EvidenceItem, Postcondition } from "./types";

/** Text that counts as a success claim (spec: success|succeeded|ok|completato). */
const SUCCESS_CLAIM_RE = /success|succeeded|ok|completato/i;
/** A rollback-flavoured claim is contradicted by a dirty git state. */
const ROLLBACK_RE = /rollback/i;

/** True when the evidence item asserts success (claim text or critic passed). */
function isSuccessClaim(item: EvidenceItem): boolean {
  if (item.kind === "claim") {
    return typeof item.claim === "string" && SUCCESS_CLAIM_RE.test(item.claim);
  }
  return item.kind === "critic_verdict" && item.facts.passed === true;
}

/** True when the success claim is rollback-flavoured (git-dirty contradicts it). */
function isRollbackClaim(item: EvidenceItem): boolean {
  return typeof item.claim === "string" && ROLLBACK_RE.test(item.claim);
}

/**
 * Contradiction scan: a success claim vs an ok=false postcondition, or a
 * rollback-success claim vs git_state evidence with clean=false.
 */
function hasContradiction(evidence: EvidenceItem[], postconditions: Postcondition[]): boolean {
  const postconditionFailed = postconditions.some((p) => p.ok === false);
  const claims = evidence.filter(isSuccessClaim);
  if (claims.length === 0) return false;
  if (postconditionFailed) return true;
  const rollbackClaimed = claims.some(isRollbackClaim);
  if (!rollbackClaimed) return false;
  return evidence.some((item) => item.kind === "git_state" && item.facts.clean === false);
}

/**
 * The verdict matrix, facts-only and deterministic:
 * - FALSE_SUCCESS: a success claim exists AND is contradicted.
 * - FAIL: at least one postcondition ok=false (no success claim involved).
 * - PASS: every postcondition verified ok=true, none contradicted.
 * - INSUFFICIENT: nothing verifiable (all null / none present), no contradiction.
 *
 * Task-outcome fold (F-02): a `task_outcome` evidence item is AUTHORITATIVE
 * for the verdict. FAIL/FALSE_SUCCESS degrade the verdict to that outcome —
 * local gate health can never upgrade a task-level failure to PASS.
 * FALSE_FAILURE/INSUFFICIENT replace a local PASS (an unobserved task must
 * not be recorded as a clean pass). A local FALSE_SUCCESS/FAIL is NEVER
 * upgraded by a task_outcome PASS. Score stays the local postcondition share.
 */
export function evaluateEvidence(
  evidence: EvidenceItem[],
  postconditions: Postcondition[],
): EvidenceEvaluation {
  const verified = postconditions.filter((p) => p.ok !== null);
  const failed = postconditions.filter((p) => p.ok === false);
  const successClaimed = evidence.some(isSuccessClaim);
  const contradicted = hasContradiction(evidence, postconditions);

  let verdict: EvalVerdict;
  if (successClaimed && contradicted) {
    verdict = "FALSE_SUCCESS";
  } else if (failed.length > 0) {
    verdict = "FAIL";
  } else if (verified.length > 0 && verified.length === postconditions.length) {
    verdict = "PASS";
  } else {
    verdict = "INSUFFICIENT";
  }

  // F-02 fold: the task-level outcome, when explicitly observed, is the
  // authority on whether the run actually succeeded (F-04 dimension split).
  // Downgrade-only semantics: FAIL/FALSE_SUCCESS replace PASS/INSUFFICIENT;
  // FALSE_SUCCESS is preserved when present (more informative than FAIL);
  // FALSE_FAILURE/INSUFFICIENT replace a local PASS only. No task_outcome
  // value ever upgrades a local FALSE_SUCCESS/FAIL.
  const taskOutcomeItem = [...evidence].reverse().find((item) => item.kind === "task_outcome");
  const taskRaw = taskOutcomeItem?.facts.outcome;
  if (taskRaw === "FAIL" || taskRaw === "FALSE_SUCCESS") {
    if (verdict === "PASS" || verdict === "INSUFFICIENT") verdict = taskRaw;
  } else if (taskRaw === "FALSE_FAILURE" || taskRaw === "INSUFFICIENT") {
    if (verdict === "PASS") verdict = taskRaw;
  }

  const score =
    postconditions.length === 0
      ? 0.5
      : postconditions.filter((p) => p.ok === true).length / postconditions.length;

  let confidence: number | null = null;
  if (evidence.length >= 2) {
    const confidences: number[] = [];
    for (const item of evidence) {
      const value = item.facts.confidence;
      if (typeof value === "number" && Number.isFinite(value)) confidences.push(value);
    }
    confidence = confidences.length > 0 ? Math.min(...confidences) : 0.5;
  }

  return { verdict, score, confidence };
}

/**
 * Build the rollback postcondition: workspace restored to the pre-repair
 * state — same HEAD, no new untracked/modified files. Unverifiable (null)
 * when either snapshot lacks a HEAD.
 */
export function buildRollbackPostcondition(
  before: { head?: string | null; untracked?: string[]; modified?: string[] },
  after: { head?: string | null; untracked?: string[]; modified?: string[] },
): Postcondition {
  const beforeHead = typeof before.head === "string" && before.head.length > 0 ? before.head : null;
  const afterHead = typeof after.head === "string" && after.head.length > 0 ? after.head : null;
  const headComparable = beforeHead !== null && afterHead !== null;
  const headUnchanged = headComparable ? afterHead === beforeHead : null;
  const untracked = Array.isArray(after.untracked) ? after.untracked : [];
  const modified = Array.isArray(after.modified) ? after.modified : [];
  return {
    name: "rollback-restored-workspace",
    expected: { headUnchanged: true, noUntracked: true, noModified: true },
    observed: {
      headUnchanged,
      untrackedCount: untracked.length,
      modifiedCount: modified.length,
    },
    ok:
      headUnchanged === null
        ? null
        : headUnchanged && untracked.length === 0 && modified.length === 0,
  };
}

/**
 * Build the exit-code postcondition: a command either ran clean (0) or it
 * did not. Unknown exit code (null) is unverifiable, never a pass.
 */
export function buildExitCodePostcondition(
  command: string,
  exitCode: number | null,
  claims: string[],
): Postcondition {
  return {
    name: "exit-code-zero",
    expected: { exitCode: 0 },
    observed: { command, exitCode, claimCount: claims.length },
    ok: exitCode === null ? null : exitCode === 0,
  };
}

/**
 * Build the critic postcondition. B17 rule: a fail-open critic that claims
 * passed=true cannot self-certify — that specific combination is ok=false.
 * passed=null is unverifiable.
 */
export function buildCriticPostcondition(verdict: {
  passed: boolean | null;
  failOpen: boolean;
}): Postcondition {
  return {
    name: "critic-verified",
    expected: { passed: true, failOpenSelfCertification: false },
    observed: { passed: verdict.passed, failOpen: verdict.failOpen },
    ok:
      verdict.passed === null ? null : verdict.failOpen && verdict.passed ? false : verdict.passed,
  };
}
