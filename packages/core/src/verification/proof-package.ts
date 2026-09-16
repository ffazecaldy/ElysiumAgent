/**
 * Proof package (E10) — the capstone artifact of a harness run.
 *
 * A run may only claim VERIFIED when every hard gate passes:
 * scope, authorized-files-only, build, tests, at least one piece of
 * evidence, and a repair loop that did not collapse. Review and commit
 * are recorded as checks but are deliberately NON-BLOCKING (null means
 * "not performed" -> failed check with detail, caller decides whether
 * that should block its own flow).
 */

export interface ProofCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface ProofPackage {
  status: "VERIFIED" | "NOT_VERIFIED";
  runId: string;
  checks: ProofCheck[];
  failedChecks: ProofCheck[];
  summary: string;
}

export interface ProofPackageInput {
  runId: string;
  scopeOk: boolean;
  authorizedFilesOnly: boolean;
  buildOk: boolean;
  testsOk: boolean;
  evidenceCount: number;
  reviewPassed: boolean | null;
  commitHash: string | null;
  repairLoopCollapsed?: boolean;
}

/**
 * Assemble the proof package for a run.
 * VERIFIED only if: scopeOk && authorizedFilesOnly && buildOk && testsOk
 *                   && evidenceCount > 0 && repairLoopCollapsed !== true.
 * reviewPassed / commitHash are recorded as checks; null -> passed=false
 * with detail "not performed" but they never block status here.
 */
export function assembleProofPackage(input: ProofPackageInput): ProofPackage {
  const checks: ProofCheck[] = [];

  checks.push({
    id: "scope",
    label: "Scope respected",
    passed: input.scopeOk,
    ...(input.scopeOk ? {} : { detail: "worktree state diverged from declared scope" }),
  });

  checks.push({
    id: "authorized-files",
    label: "Authorized files only",
    passed: input.authorizedFilesOnly,
    ...(input.authorizedFilesOnly ? {} : { detail: "files outside authorization were touched" }),
  });

  checks.push({
    id: "build",
    label: "Build",
    passed: input.buildOk,
    ...(input.buildOk ? {} : { detail: "build failed" }),
  });

  checks.push({
    id: "tests",
    label: "Tests",
    passed: input.testsOk,
    ...(input.testsOk ? {} : { detail: "test suite failed" }),
  });

  const evidenceOk = input.evidenceCount > 0;
  checks.push({
    id: "evidence",
    label: "Evidence chain non-empty",
    passed: evidenceOk,
    ...(evidenceOk
      ? { detail: `${input.evidenceCount} entr${input.evidenceCount === 1 ? "y" : "ies"}` }
      : { detail: "no evidence recorded" }),
  });

  checks.push({
    id: "repair-loop",
    label: "Repair loop",
    passed: input.repairLoopCollapsed !== true,
    ...(input.repairLoopCollapsed === true ? { detail: "repair loop collapsed" } : {}),
  });

  const reviewDone = input.reviewPassed !== null;
  checks.push({
    id: "review",
    label: "Review",
    passed: reviewDone ? input.reviewPassed === true : false,
    ...(reviewDone ? {} : { detail: "not performed" }),
  });

  const commitDone = input.commitHash !== null;
  checks.push({
    id: "commit",
    label: "Commit",
    passed: commitDone,
    ...(commitDone ? {} : { detail: "not performed" }),
  });

  const hardGate =
    input.scopeOk &&
    input.authorizedFilesOnly &&
    input.buildOk &&
    input.testsOk &&
    input.evidenceCount > 0 &&
    input.repairLoopCollapsed !== true;

  const failedChecks = checks.filter((c) => !c.passed);
  const status: ProofPackage["status"] = hardGate ? "VERIFIED" : "NOT_VERIFIED";

  const summary =
    status === "VERIFIED"
      ? `All ${checks.length - failedChecks.length} hard checks passed (${failedChecks.length} non-blocking failed).`
      : `NOT VERIFIED: ${failedChecks.length} check(s) failed — ${failedChecks.map((c) => c.id).join(", ")}.`;

  return { status, runId: input.runId, checks, failedChecks, summary };
}

/** Multiriga, ANSI-free: "✓ label — detail" / "✗ label — detail". */
export function renderProofPackage(p: ProofPackage): string {
  const lines: string[] = [];
  lines.push(`Proof package ${p.runId}: ${p.status}`);
  for (const c of p.checks) {
    const mark = c.passed ? "✓" : "✗";
    lines.push(c.detail ? `${mark} ${c.label} — ${c.detail}` : `${mark} ${c.label}`);
  }
  lines.push(p.summary);
  return lines.join("\n");
}
