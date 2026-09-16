/**
 * Tests for counterfactual verification (E8): pure classifier matrix
 * (WEAK / MEDIUM / STRONG) + isTargetedTest + thin driver.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCounterfactual,
  isTargetedTest,
  runCounterfactual,
} from "../src/verification/counterfactual";

describe("isTargetedTest", () => {
  it("detects .test. files", () => {
    expect(isTargetedTest(["src/app.ts", "src/app.test.ts"])).toBe(true);
  });

  it("detects .spec. files", () => {
    expect(isTargetedTest(["src/app.spec.ts"])).toBe(true);
  });

  it("detects python test_ prefix and _test. suffix", () => {
    expect(isTargetedTest(["pkg/test_app.py"])).toBe(true);
    expect(isTargetedTest(["pkg/app_test.py"])).toBe(true);
  });

  it("detects tests/ directories", () => {
    expect(isTargetedTest(["tests/smoke.ts"])).toBe(true);
    expect(isTargetedTest(["src/test/util.ts"])).toBe(true);
  });

  it("returns false for non-test changes", () => {
    expect(isTargetedTest(["src/index.ts", "README.md"])).toBe(false);
  });

  it("returns false for the empty list", () => {
    expect(isTargetedTest([])).toBe(false);
  });
});

describe("classifyCounterfactual", () => {
  const opts = (targeted: boolean, newTestAdded: boolean) => ({
    targeted,
    newTestAdded,
  });

  it("STRONG: red before, green after, targeted test change", () => {
    expect(classifyCounterfactual(1, 0, opts(true, true)).strength).toBe("STRONG");
    expect(classifyCounterfactual(1, 0, opts(true, false)).strength).toBe("STRONG");
    expect(classifyCounterfactual(2, 0, opts(true, true)).strength).toBe("STRONG");
  });

  it("not STRONG without a red before-run", () => {
    // green before -> nothing proves the suite could fail
    expect(classifyCounterfactual(0, 0, opts(true, true)).strength).toBe("MEDIUM");
    // no before-run performed
    expect(classifyCounterfactual(null, 0, opts(true, true)).strength).toBe("MEDIUM");
  });

  it("not STRONG without a targeted test change", () => {
    expect(classifyCounterfactual(1, 0, opts(false, true)).strength).toBe("MEDIUM");
  });

  it("not STRONG when the suite is still red after", () => {
    expect(classifyCounterfactual(1, 1, opts(true, true)).strength).toBe("WEAK");
  });

  it("MEDIUM: new test added, green after, but no red before-run", () => {
    expect(classifyCounterfactual(null, 0, opts(false, true)).strength).toBe("MEDIUM");
    expect(classifyCounterfactual(0, 0, opts(false, true)).strength).toBe("MEDIUM");
  });

  it("not MEDIUM when after !== 0 or no new test", () => {
    expect(classifyCounterfactual(null, 1, opts(false, true)).strength).toBe("WEAK");
    expect(classifyCounterfactual(0, 0, opts(false, false)).strength).toBe("WEAK");
  });

  it("WEAK: fallback — green with no counterfactual evidence", () => {
    expect(classifyCounterfactual(null, 0, opts(false, false)).strength).toBe("WEAK");
    expect(classifyCounterfactual(1, 1, opts(false, false)).strength).toBe("WEAK");
  });

  it("full matrix: every combination resolves to a valid strength", () => {
    for (const before of [null, 0, 1] as const) {
      for (const after of [0, 1] as const) {
        for (const targeted of [true, false]) {
          for (const newTestAdded of [true, false]) {
            const { strength } = classifyCounterfactual(before, after, {
              targeted,
              newTestAdded,
            });
            expect(["WEAK", "MEDIUM", "STRONG"]).toContain(strength);
          }
        }
      }
    }
  });
});

describe("runCounterfactual", () => {
  it("runs the command twice and classifies STRONG", () => {
    const runs: string[] = [];
    const result = runCounterfactual({
      testCommand: ["pnpm", "vitest", "run"],
      workspaceRoot: "/repo",
      changedFiles: ["src/app.test.ts"],
      runCommand: (cmd, cwd) => {
        runs.push(`${cwd}:${cmd.join(" ")}`);
        // caller swaps state between runs: baseline (red) -> changed (green)
        return { exitCode: runs.length === 1 ? 1 : 0, stdout: "" };
      },
    });
    expect(runs).toHaveLength(2);
    expect(result.beforeExitCode).toBe(1);
    expect(result.afterExitCode).toBe(0);
    expect(result.beforeTargeted).toBe(true);
    expect(result.strength).toBe("STRONG");
    expect(result.skippedReason).toBeUndefined();
  });

  it("reports WEAK with skippedReason when the suite is still red", () => {
    const result = runCounterfactual({
      testCommand: ["pnpm", "vitest", "run"],
      workspaceRoot: "/repo",
      changedFiles: ["src/index.ts"],
      runCommand: () => ({ exitCode: 1, stdout: "fail" }),
    });
    expect(result.strength).toBe("WEAK");
    expect(result.beforeTargeted).toBe(false);
    expect(result.skippedReason).toContain("counterfactual not established");
  });

  it("classifies MEDIUM when a new test is added without a red baseline", () => {
    const result = runCounterfactual({
      testCommand: ["pnpm", "vitest", "run"],
      workspaceRoot: "/repo",
      changedFiles: ["src/new-feature.test.ts"],
      runCommand: () => ({ exitCode: 0, stdout: "ok" }),
    });
    expect(result.strength).toBe("MEDIUM");
  });
});
