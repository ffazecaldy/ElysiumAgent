/** Tests for the observability renderers: timeline, whyFailed, provenance. */
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  renderProvenance,
  renderRunTimeline,
  whyFailed,
} from "../src/observability";
import type { PhaseStat } from "../src/observability";

describe("renderRunTimeline", () => {
  it("contains aligned column headers and per-phase rows", () => {
    const phases: PhaseStat[] = [
      { name: "plan", ms: 3200, tokens: 840, result: "ok" },
      { name: "edit", ms: 72000, tokens: 12300, result: "ok" },
      { name: "test", ms: 1500, tokens: 300, result: "fail" },
      { name: "review", ms: 0, tokens: 0, result: "skip" },
    ];
    const out = renderRunTimeline(phases);
    const lines = out.split("\n");
    expect(lines[0]).toContain("PHASE");
    expect(lines[0]).toContain("TIME");
    expect(lines[0]).toContain("TOKENS");
    expect(lines[0]).toContain("RESULT");
    // separator under the header
    expect(lines[1]).toMatch(/^-+$/);
    expect(out).toContain("✓ ok");
    expect(out).toContain("✗ fail");
    expect(out).toContain("○ skip");
    expect(out).toContain("3.2s");
    expect(out).toContain("1.2m");
  });

  it("aligns TIME/TOKENS columns to the right across rows", () => {
    const phases: PhaseStat[] = [
      { name: "alpha", ms: 100, tokens: 1, result: "ok" },
      { name: "beta", ms: 9500, tokens: 4200, result: "fail" },
    ];
    const lines = renderRunTimeline(phases).split("\n");
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
    // TOKENS column starts at the same index in every row (right-aligned).
    const tokensIdx = lines[0]?.indexOf("TOKENS") ?? -1;
    expect(tokensIdx).toBeGreaterThan(0);
    const tokenCell = (line: string | undefined): string =>
      (line?.slice(tokensIdx) ?? "").split("|")[0]?.trim() ?? "";
    expect(tokenCell(lines[2])).toBe("1");
    expect(tokenCell(lines[3])).toBe("4200");
    expect(lines[2]).toContain("0.1s");
    expect(lines[3]).toContain("9.5s");
  });

  it("renders an empty table (header + separator) with no phases", () => {
    const out = renderRunTimeline([]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("PHASE");
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(3200)).toBe("3.2s");
    expect(formatDuration(59900)).toBe("59.9s");
  });

  it("formats minutes as decimal minutes (1.2m style)", () => {
    expect(formatDuration(60_000)).toBe("1.0m");
    expect(formatDuration(72_000)).toBe("1.2m");
    expect(formatDuration(600_000)).toBe("10.0m");
  });

  it("never returns NaN-ish output for invalid input", () => {
    expect(formatDuration(-5)).toBe("0.0s");
    expect(formatDuration(Number.NaN)).toBe("0.0s");
  });
});

describe("whyFailed", () => {
  it("includes header, cause and one bullet per detail", () => {
    const out = whyFailed("TEST_FAILURE", ["2 tests failed", "pytest exited with code 1"]);
    expect(out).toContain("WHY DID THIS RUN FAIL");
    expect(out).toContain("Cause: TEST_FAILURE");
    expect(out).toContain("- 2 tests failed");
    expect(out).toContain("- pytest exited with code 1");
  });

  it("returns an empty string when details are empty, never throws", () => {
    expect(whyFailed("BUILD_FAILURE", [])).toBe("");
    expect(whyFailed("", undefined as unknown as string[])).toBe("");
  });
});

describe("renderProvenance", () => {
  it("renders commit and verifier when present", () => {
    const out = renderProvenance({
      artifactId: "A-44",
      taskId: "T41",
      attempt: 3,
      commit: "c1a82",
      verifiedBy: "V-88",
    });
    expect(out).toContain("artifact: A-44");
    expect(out).toContain("produced_by: T41 (attempt 3)");
    expect(out).toContain("source commit: c1a82");
    expect(out).toContain("verified_by: V-88");
  });

  it("renders placeholders when commit and verifier are missing", () => {
    const out = renderProvenance({
      artifactId: "A-1",
      taskId: "T2",
      attempt: 1,
      commit: null,
      verifiedBy: null,
    });
    expect(out).toContain("source commit: (none)");
    expect(out).toContain("verified_by: (not verified)");
    expect(out).not.toContain("source commit: null");
  });

  it("treats empty-string commit/verifier as missing", () => {
    const out = renderProvenance({
      artifactId: "A-2",
      taskId: "T3",
      attempt: 2,
      commit: "",
      verifiedBy: "",
    });
    expect(out).toContain("source commit: (none)");
    expect(out).toContain("verified_by: (not verified)");
  });
});
