/**
 * Deterministic evidence auditor for test files.
 *
 * Scans test-like sources for weak-evidence patterns (tautological asserts,
 * swallowed exceptions, skipped tests, hardcoded metrics, assertion-less
 * files). The `readFile` dependency is injected so the audit is fully
 * testable without touching the real filesystem.
 */

/** A single weak-evidence finding produced by the audit. */
export interface AuditFinding {
  /** Identifier of the matched pattern (e.g. `assert-true`). */
  pattern: string;
  /** File the finding refers to (as passed in `paths`). */
  file: string;
  /** 1-indexed line number of the evidence. */
  line: number;
  /** `blocking` findings become repair-round gaps; `warning` only reports. */
  severity: "blocking" | "warning";
  /** Original (trimmed to 80 chars) source line as evidence. */
  evidence: string;
}

interface LineRule {
  pattern: string;
  regex: RegExp;
  severity: "blocking" | "warning";
}

/** Per-line rules, evaluated independently on every line. */
const LINE_RULES: readonly LineRule[] = [
  {
    pattern: "assert-true",
    regex: /^\s*assert\s+True\b|^\s*assert\s+1\s*==\s*1/,
    severity: "blocking",
  },
  {
    pattern: "bare-except-pass",
    regex: /except\s*(Exception)?\s*:\s*pass\s*$/,
    severity: "blocking",
  },
  {
    pattern: "test-skip",
    regex: /pytest\.skip\(|@pytest\.mark\.skip|it\.skip|test\.skip/,
    severity: "warning",
  },
  {
    pattern: "hardcoded-metric",
    regex: /(mAP|acc|score|loss|precision|recall)\s*[=:]\s*[0-9.]+/,
    severity: "warning",
  },
];

/**
 * Matches a bare `except ...:` header whose body (next line) is only `pass`
 * — the idiomatic Python swallowed-exception across two lines.
 */
const EXCEPT_HEADER = /^\s*except\b[^:]*:\s*$/;
const PASS_ONLY = /^\s*pass\s*$/;

/** Maximum characters kept in a finding's evidence string. */
const EVIDENCE_MAX = 80;

/** Heuristic: does this path look like a test file? */
function isTestPath(path: string): boolean {
  return /test|spec/i.test(path);
}

/** Heuristic: does this file contain at least one assertion call? */
function hasAssertion(content: string): boolean {
  return /assert|expect/i.test(content);
}

function trimEvidence(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > EVIDENCE_MAX ? `${trimmed.slice(0, EVIDENCE_MAX)}...` : trimmed;
}

/**
 * Audit a list of files for weak-evidence patterns.
 *
 * @param paths - Candidate file paths; unreadable files are silently skipped.
 * @param readFile - Injected reader returning file content or `null` if the
 *   file cannot be read. No real filesystem access is performed here.
 * @returns Findings ordered by input path then line number.
 */
export function auditTestFiles(
  paths: string[],
  readFile: (p: string) => string | null,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const path of paths) {
    const content = readFile(path);
    if (content === null || content === undefined) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const rule of LINE_RULES) {
        if (rule.regex.test(line)) {
          findings.push({
            pattern: rule.pattern,
            file: path,
            line: i + 1,
            severity: rule.severity,
            evidence: trimEvidence(line),
          });
        }
      }
    }

    // Two-line bare except: `except ...:` followed by a lone `pass`.
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (EXCEPT_HEADER.test(lines[i] ?? "") && PASS_ONLY.test(lines[i + 1] ?? "")) {
        findings.push({
          pattern: "bare-except-pass",
          file: path,
          line: i + 1,
          severity: "blocking",
          evidence: trimEvidence(lines[i] ?? ""),
        });
      }
    }

    // Per-file rule: a test/spec file with zero assertions yields one
    // blocking `no-assertions` finding anchored at line 1.
    if (isTestPath(path) && !hasAssertion(content)) {
      findings.push({
        pattern: "no-assertions",
        file: path,
        line: 1,
        severity: "blocking",
        evidence: trimEvidence(lines[0] ?? ""),
      });
    }
  }
  return findings;
}
