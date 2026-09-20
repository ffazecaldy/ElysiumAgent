/** run-report tests: section assembly per status, provenance blocks,
 * graceful degradation on malformed/empty input. */
import { describe, expect, it } from "vitest";
import type { PhaseStat } from "../src/observability";
import { buildRunReport } from "../src/run-report";

const phases: PhaseStat[] = [
  { name: "Planning", ms: 3200, tokens: 1800, result: "ok" },
  { name: "Execution", ms: 41000, tokens: 8400, result: "ok" },
  { name: "Build", ms: 12000, tokens: 0, result: "fail" },
];

describe("buildRunReport", () => {
  it("renders COMPLETED runs without the failure section", () => {
    const report = buildRunReport({
      runId: "run-1",
      goal: "Ship it",
      status: "COMPLETED",
      phases,
      evidenceStatus: "PASSED",
    });
    expect(report).toContain("RUN REPORT");
    expect(report).toContain("run: run-1");
    expect(report).toContain("status: COMPLETED");
    expect(report).toContain("TIMELINE");
    expect(report).toContain("Planning");
    expect(report).toContain("EVIDENCE");
    expect(report).toContain("status: PASSED");
    expect(report).not.toContain("WHY DID THIS RUN FAIL");
    expect(report).not.toContain("PROVENANCE");
  });

  it("renders FAILED runs with the why-failed section and cause", () => {
    const report = buildRunReport({
      runId: "run-2",
      goal: "Ship it",
      status: "FAILED",
      phases,
      failureCause: "TEST_FAILURE",
      failureDetails: ["2 tests failed in auth.spec.ts"],
    });
    expect(report).toContain("WHY DID THIS RUN FAIL");
    expect(report).toContain("TEST_FAILURE");
    expect(report).toContain("2 tests failed in auth.spec.ts");
  });

  it("renders INTERRUPTED runs and optional provenance", () => {
    const report = buildRunReport({
      runId: "run-3",
      goal: "g",
      status: "INTERRUPTED",
      phases: [],
      artifacts: [
        { artifactId: "A-44", taskId: "T41", attempt: 3, commit: "c1a82f9", verifiedBy: "V-88" },
        { artifactId: "A-45", taskId: "T42", attempt: 1, commit: null, verifiedBy: null },
      ],
    });
    expect(report).toContain("status: INTERRUPTED");
    expect(report).toContain("PROVENANCE");
    expect(report).toContain("A-44");
    expect(report).toContain("c1a82f9");
    expect(report).toContain("(none)"); // evidence status absent
  });

  it("never throws on empty or malformed input", () => {
    expect(() =>
      buildRunReport({
        runId: "",
        goal: "",
        status: "COMPLETED",
        phases: [],
        failureDetails: undefined,
      }),
    ).not.toThrow();
    const empty = buildRunReport({
      runId: "run-4",
      goal: "g",
      status: "COMPLETED",
      phases: [],
    });
    expect(empty).toContain("TIMELINE");
  });
});
