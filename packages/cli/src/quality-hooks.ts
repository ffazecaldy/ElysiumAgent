/**
 * Quality hooks: bridge between claimed artifacts and the deterministic
 * evidence auditor. Converts audit findings into repair-round gaps.
 */
// Direct module import (not the package root): the root index does not
// re-export the quality modules yet, and this file owns that wiring.
import { auditTestFiles, type AuditFinding } from "../../core/src/quality/evidence-audit";

/**
 * Heuristic: does this artifact path look like a test file?
 * Accepts `.test.`/`.spec.` infixes, `test_*`/`*_test.` prefixes/suffixes
 * and a `tests/` (or `test/`) path segment at any depth.
 */
function isTestLike(path: string): boolean {
  return /\.(test|spec)\.|test_|_test\.|(^|\/)tests?\//.test(path);
}

/**
 * Audit only the test-like artifacts among the claimed ones.
 *
 * @param artifacts - Paths the agent claimed to have produced/modified.
 * @param readFile - Injected reader (content or `null` when unreadable).
 * @returns Weak-evidence findings for the test-like subset.
 */
export function auditClaimedArtifacts(
  artifacts: string[],
  readFile: (p: string) => string | null,
): AuditFinding[] {
  const testLike = artifacts.filter((path) => isTestLike(path));
  return auditTestFiles(testLike, readFile);
}

/**
 * Convert blocking findings into repair-round gap strings. Warnings are
 * intentionally omitted: gaps must represent hard evidence failures.
 *
 * @param findings - Findings produced by an evidence audit.
 * @returns Gap strings of the form
 *   `Evidence audit [pattern] file:line — evidence`.
 */
export function findingsToGaps(findings: AuditFinding[]): string[] {
  return findings
    .filter((finding) => finding.severity === "blocking")
    .map(
      (finding) =>
        `Evidence audit [${finding.pattern}] ${finding.file}:${finding.line} — ${finding.evidence}`,
    );
}
