/**
 * Counterfactual verification (E8).
 *
 * The core insight: a test suite only proves something if it can FAIL.
 * We classify the *counterfactual strength* of a verification run by
 * comparing the test exit code BEFORE the fix vs AFTER the fix:
 *
 *  - STRONG: the suite failed before the change (it can detect the bug)
 *            and passes after it, with a test-like file among the changes.
 *  - MEDIUM: a new test was added and the suite is green after the change
 *            (some evidence, but the new test was never seen failing).
 *  - WEAK:   everything else — the suite is green but nothing shows it
 *            could ever have been red ("tests that cannot fail").
 *
 * DESIGN NOTE (honest scope): this module contains PURE classification
 * only. Executing the test command (twice, around the change) is the
 * caller's responsibility (swarm / quality gate): the caller runs the
 * command at the "before" checkpoint and at the "after" checkpoint and
 * feeds the two exit codes here. `runCounterfactual` is a thin driver
 * for callers that already hold a stateful `runCommand` closure.
 */

export interface CounterfactualInput {
  testCommand: string[];
  workspaceRoot: string;
  changedFiles: string[];
  /** Caller-supplied executor: the caller decides which workspace state each invocation sees. */
  runCommand: (cmd: string[], cwd: string) => { exitCode: number; stdout: string };
  /** True when the change introduced a brand-new test (strengthens to at least MEDIUM). */
  newTestAdded?: boolean;
}

export interface CounterfactualResult {
  strength: "WEAK" | "MEDIUM" | "STRONG";
  beforeExitCode: number | null;
  afterExitCode: number | null;
  beforeTargeted: boolean;
  skippedReason?: string;
}

export interface CounterfactualStrength {
  strength: "WEAK" | "MEDIUM" | "STRONG";
}

/** Convention for "this file looks like a test file". */
const TEST_LIKE = /(\.(test|spec)\.)|(test_)|(_test\.)|((^|\/)tests?\/)/;

/** True when at least one changed file is test-like. */
export function isTargetedTest(changedFiles: string[]): boolean {
  return changedFiles.some((f) => TEST_LIKE.test(f));
}

/**
 * Pure counterfactual classifier.
 *
 * @param beforeExitCode exit code of the suite run BEFORE the change
 *                       (null when a before-run was not performed)
 * @param afterExitCode  exit code of the suite run AFTER the change
 * @param opts.targeted     a test-like file is among the changed files
 * @param opts.newTestAdded the change adds a new test
 */
export function classifyCounterfactual(
  beforeExitCode: number | null,
  afterExitCode: number,
  opts: { targeted: boolean; newTestAdded: boolean },
): CounterfactualStrength {
  // STRONG: suite detected the bug before the fix and is green after,
  // and the change itself touched tests (the red was a real detection).
  if (beforeExitCode !== null && beforeExitCode !== 0 && afterExitCode === 0 && opts.targeted) {
    return { strength: "STRONG" };
  }
  // MEDIUM: a new test was added and the suite is green after the change.
  if (opts.newTestAdded && afterExitCode === 0) {
    return { strength: "MEDIUM" };
  }
  // WEAK: fallback — green suite with no counterfactual evidence.
  return { strength: "WEAK" };
}

/**
 * Thin driver: runs the test command twice through the caller-supplied
 * `runCommand` (the caller's closure is responsible for which workspace
 * state each run observes — e.g. a rollback/checkpoint around run #1),
 * then classifies.
 */
export function runCounterfactual(input: CounterfactualInput): CounterfactualResult {
  const targeted = isTargetedTest(input.changedFiles);

  const before = input.runCommand(input.testCommand, input.workspaceRoot);
  // Between run #1 and run #2 the CALLER's closure swaps workspace state
  // (baseline checkpoint -> changed tree). We only measure exit codes.
  const after = input.runCommand(input.testCommand, input.workspaceRoot);

  const { strength } = classifyCounterfactual(before.exitCode, after.exitCode, {
    targeted,
    newTestAdded: input.newTestAdded ?? targeted,
  });

  return {
    strength,
    beforeExitCode: before.exitCode,
    afterExitCode: after.exitCode,
    beforeTargeted: targeted,
    ...(strength === "WEAK" && after.exitCode !== 0
      ? { skippedReason: "suite still failing after change; counterfactual not established" }
      : {}),
  };
}
