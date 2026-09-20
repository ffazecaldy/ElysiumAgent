/**
 * Tests for the deterministic evidence auditor and failure-cause taxonomy.
 */
import { describe, expect, it } from "vitest";
import { auditTestFiles } from "../src/quality/evidence-audit";
import { classifyFailure } from "../src/quality/failure-cause";

describe("classifyFailure", () => {
  it("classifies missing dependency with full confidence", () => {
    expect(classifyFailure("Error: Cannot find module 'lodash'")).toEqual({
      cause: "MISSING_DEPENDENCY",
      confidence: 1.0,
    });
    expect(classifyFailure("ModuleNotFoundError: no module named 'requests'").cause).toBe(
      "MISSING_DEPENDENCY",
    );
  });

  it("classifies type errors", () => {
    const result = classifyFailure("src/app.ts:10: error TS2345: mismatched types");
    expect(result.cause).toBe("TYPE_ERROR");
    expect(result.confidence).toBe(1.0);
  });

  it("classifies assertion weakness", () => {
    const result = classifyFailure("AssertionError: expected 5 to be 3");
    expect(result.cause).toBe("ASSERTION_WEAKNESS");
    expect(result.confidence).toBe(0.9);
  });

  it("classifies build failure", () => {
    const result = classifyFailure("npm run build: compilation failed");
    expect(result.cause).toBe("BUILD_FAILURE");
    expect(result.confidence).toBe(1.0);
  });

  it("classifies scope violation", () => {
    const result = classifyFailure("path traversal blocked: file changed outside workspace scope");
    expect(result.cause).toBe("SCOPE_VIOLATION");
    expect(result.confidence).toBe(1.0);
  });

  it("falls back to TEST_FAILURE with degraded confidence on generic error", () => {
    const result = classifyFailure("something went wrong, process exited with code 1: failed");
    expect(result.cause).toBe("TEST_FAILURE");
    expect(result.confidence).toBe(0.5);
  });

  it("returns UNKNOWN when nothing matches", () => {
    expect(classifyFailure("all systems nominal")).toEqual({
      cause: "UNKNOWN",
      confidence: 0,
    });
    expect(classifyFailure("").cause).toBe("UNKNOWN");
  });
});

describe("auditTestFiles", () => {
  function fakeReader(files: Record<string, string>) {
    return (p: string): string | null => files[p] ?? null;
  }

  it("flags tautological assert True as blocking", () => {
    const files = {
      "test_x.py": "def test_ok():\n    assert True\n",
    };
    const findings = auditTestFiles(["test_x.py"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe("assert-true");
    expect(findings[0]?.file).toBe("test_x.py");
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.severity).toBe("blocking");
    expect(findings[0]?.evidence).toBe("assert True");
  });

  it("flags assert 1 == 1 as blocking", () => {
    const files = { "a.test.ts": "  assert 1 == 1; // tautology\n" };
    const findings = auditTestFiles(["a.test.ts"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe("assert-true");
    expect(findings[0]?.line).toBe(1);
  });

  it("flags bare except pass as blocking", () => {
    const files = { "s.py": "try:\n    run()\nexcept Exception:\n    pass\n" };
    const findings = auditTestFiles(["s.py"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe("bare-except-pass");
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.severity).toBe("blocking");
  });

  it("flags test skip as warning", () => {
    const files = { "a.spec.ts": "it.skip('later', () => {\n  expect(1).toBe(1);\n});\n" };
    const findings = auditTestFiles(["a.spec.ts"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe("test-skip");
    expect(findings[0]?.severity).toBe("warning");
  });

  it("flags hardcoded metric as warning", () => {
    const files = { "metrics.py": "mAP = 0.92\nacc=0.88\n" };
    const findings = auditTestFiles(["metrics.py"], fakeReader(files));
    expect(findings.map((f) => f.pattern)).toEqual(["hardcoded-metric", "hardcoded-metric"]);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("flags assertion-less test file once at line 1", () => {
    const files = { "test_user.py": "def test_user():\n    load_user()\n" };
    const findings = auditTestFiles(["test_user.py"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pattern).toBe("no-assertions");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.severity).toBe("blocking");
  });

  it("does not flag assertion-less non-test files", () => {
    const files = { "src/util.py": "def load():\n    return 1\n" };
    expect(auditTestFiles(["src/util.py"], fakeReader(files))).toHaveLength(0);
  });

  it("skips unreadable files silently", () => {
    expect(auditTestFiles(["missing.py"], () => null)).toHaveLength(0);
  });

  it("trims long evidence to 80 chars", () => {
    const long = `${"x".repeat(120)} assert True`;
    const files = { "t.py": `assert True # ${long}` };
    const findings = auditTestFiles(["t.py"], fakeReader(files));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.length ?? 999).toBeLessThanOrEqual(83);
  });
});
