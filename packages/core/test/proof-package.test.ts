/**
 * Tests for the proof package (E10): assembly rules, non-blocking
 * review/commit, failedChecks listing, and rendering.
 */
import { describe, expect, it } from "vitest";
import {
  type ProofPackageInput,
  assembleProofPackage,
  renderProofPackage,
} from "../src/verification/proof-package";

const okInput = (): ProofPackageInput => ({
  runId: "run-42",
  scopeOk: true,
  authorizedFilesOnly: true,
  buildOk: true,
  testsOk: true,
  evidenceCount: 3,
  reviewPassed: true,
  commitHash: "abc1234",
});

describe("assembleProofPackage", () => {
  it("VERIFIED when every gate passes (review+commit done)", () => {
    const p = assembleProofPackage(okInput());
    expect(p.status).toBe("VERIFIED");
    expect(p.failedChecks).toEqual([]);
    expect(p.checks.every((c) => c.passed)).toBe(true);
    expect(p.runId).toBe("run-42");
  });

  it("NOT VERIFIED with testsOk=false listing tests among failedChecks", () => {
    const p = assembleProofPackage({ ...okInput(), testsOk: false });
    expect(p.status).toBe("NOT_VERIFIED");
    expect(p.failedChecks.map((c) => c.id)).toContain("tests");
    expect(p.summary).toContain("NOT VERIFIED");
    expect(p.summary).toContain("tests");
  });

  it("NOT VERIFIED for each hard gate failing individually", () => {
    expect(assembleProofPackage({ ...okInput(), scopeOk: false }).status).toBe("NOT_VERIFIED");
    expect(assembleProofPackage({ ...okInput(), authorizedFilesOnly: false }).status).toBe(
      "NOT_VERIFIED",
    );
    expect(assembleProofPackage({ ...okInput(), buildOk: false }).status).toBe("NOT_VERIFIED");
    expect(assembleProofPackage({ ...okInput(), evidenceCount: 0 }).status).toBe("NOT_VERIFIED");
    expect(assembleProofPackage({ ...okInput(), repairLoopCollapsed: true }).status).toBe(
      "NOT_VERIFIED",
    );
  });

  it("commit null does NOT block but appears as a failed check with 'not performed'", () => {
    const p = assembleProofPackage({ ...okInput(), commitHash: null });
    expect(p.status).toBe("VERIFIED"); // non-blocking
    const commit = p.checks.find((c) => c.id === "commit");
    expect(commit?.passed).toBe(false);
    expect(commit?.detail).toBe("not performed");
    expect(p.failedChecks).toHaveLength(1);
    expect(p.failedChecks[0]?.id).toBe("commit");
  });

  it("review null does NOT block but appears as a failed check; review false also fails without blocking", () => {
    const pNull = assembleProofPackage({ ...okInput(), reviewPassed: null });
    expect(pNull.status).toBe("VERIFIED");
    const review = pNull.checks.find((c) => c.id === "review");
    expect(review?.passed).toBe(false);
    expect(review?.detail).toBe("not performed");

    const pFalse = assembleProofPackage({ ...okInput(), reviewPassed: false });
    expect(pFalse.status).toBe("VERIFIED"); // still non-blocking here
    expect(pFalse.checks.find((c) => c.id === "review")?.passed).toBe(false);
  });

  it("review false + commit null: both listed in failedChecks, status still VERIFIED", () => {
    const p = assembleProofPackage({ ...okInput(), reviewPassed: false, commitHash: null });
    expect(p.status).toBe("VERIFIED");
    expect(p.failedChecks.map((c) => c.id).sort()).toEqual(["commit", "review"]);
  });

  it("evidence detail mentions the count", () => {
    const p = assembleProofPackage(okInput());
    expect(p.checks.find((c) => c.id === "evidence")?.detail).toContain("3");
  });
});

describe("renderProofPackage", () => {
  it("renders ✓/✗ lines with labels and details", () => {
    const p = assembleProofPackage({ ...okInput(), testsOk: false, commitHash: null });
    const out = renderProofPackage(p);
    const lines = out.split("\n");

    expect(lines[0]).toBe("Proof package run-42: NOT_VERIFIED");
    expect(out).toContain("✗ Tests — test suite failed");
    expect(out).toContain("✗ Commit — not performed");
    expect(out).toContain("✓ Build");
    expect(out).toContain("✓ Scope respected");
    expect(lines[lines.length - 1]).toContain("NOT VERIFIED:");
    expect(lines[lines.length - 1]).toContain("tests");
    expect(lines[lines.length - 1]).toContain("commit");
  });

  it("renders an all-green VERIFIED package without ✗", () => {
    const out = renderProofPackage(assembleProofPackage(okInput()));
    expect(out.split("\n")).toHaveLength(10); // header + 8 checks + summary
    expect(out).not.toContain("✗");
    expect(out).toContain("✓ Commit");
    expect(out).toContain("✓ Review");
  });

  it("is ANSI-free", () => {
    const out = renderProofPackage(assembleProofPackage({ ...okInput(), testsOk: false }));
    // ESC character built without a regex control literal (biome clean).
    const esc = String.fromCharCode(27);
    expect(out.includes(`${esc}[`)).toBe(false);
  });
});
