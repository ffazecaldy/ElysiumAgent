/** Tests for the adversarial benchmark module: loading, catching, metrics. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_CATEGORIES,
  computeBenchMetrics,
  evaluateCatch,
  loadAdversarialCases,
} from "../src/adversarial";
import type { AdversarialCategory, BenchRunResult } from "../src/adversarial";

function makeRun(overrides: Partial<BenchRunResult> = {}): BenchRunResult {
  return {
    caseId: "case",
    passed: true,
    caught: true,
    falseSuccess: false,
    retries: 0,
    repairDepth: 0,
    tokens: 100,
    ...overrides,
  };
}

describe("loadAdversarialCases", () => {
  it("accepts well-formed cases from a bare array", () => {
    const json = [
      {
        id: "adv-x",
        category: "fake_test",
        description: "desc",
        hiddenCheckIds: ["assert-true"],
        expectsCatch: true,
      },
    ];
    const cases = loadAdversarialCases(json);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe("adv-x");
    expect(cases[0]?.category).toBe("fake_test");
  });

  it("accepts the `{ cases: [...] }` envelope", () => {
    const json = { cases: [validEntry()] };
    expect(loadAdversarialCases(json)).toHaveLength(1);
  });

  it("filters out malformed entries without throwing", () => {
    const json = [
      null,
      42,
      "nope",
      {},
      { id: "", category: "fake_test", description: "d", hiddenCheckIds: [], expectsCatch: true },
      // unknown category
      {
        id: "adv-y",
        category: "not_a_category",
        description: "d",
        hiddenCheckIds: ["assert-true"],
        expectsCatch: true,
      },
      // hiddenCheckIds not an array of non-empty strings
      {
        id: "adv-z",
        category: "flaky",
        description: "d",
        hiddenCheckIds: ["", 7],
        expectsCatch: false,
      },
      // missing expectsCatch
      { id: "adv-w", category: "flaky", description: "d", hiddenCheckIds: ["test-skip"] },
      validEntry(),
    ];
    const cases = loadAdversarialCases(json);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.id).toBe("adv-ok");
  });

  it("returns an empty array for garbage input shapes", () => {
    expect(loadAdversarialCases(undefined)).toEqual([]);
    expect(loadAdversarialCases("nope")).toEqual([]);
    expect(loadAdversarialCases({ wrong: 1 })).toEqual([]);
  });

  it("ships the bundled JSON with exactly one realistic case per category", () => {
    const raw = readFileSync(path.join(__dirname, "../src/tasks/adversarial.json"), "utf-8");
    const cases = loadAdversarialCases(JSON.parse(raw));
    expect(cases).toHaveLength(ADVERSARIAL_CATEGORIES.length);
    const categories = new Set<AdversarialCategory>(cases.map((c) => c.category));
    expect(categories).toEqual(new Set<AdversarialCategory>(ADVERSARIAL_CATEGORIES));
    for (const c of cases) {
      expect(c.id).toMatch(/^adv-/);
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.hiddenCheckIds.length).toBeGreaterThan(0);
    }
    // hiddenCheckIds must reference real evidence-audit pattern ids.
    const realPatterns = new Set([
      "assert-true",
      "bare-except-pass",
      "test-skip",
      "hardcoded-metric",
      "no-assertions",
    ]);
    for (const c of cases) {
      for (const id of c.hiddenCheckIds) {
        expect(realPatterns.has(id)).toBe(true);
      }
    }
  });
});

function validEntry(): Record<string, unknown> {
  return {
    id: "adv-ok",
    category: "swallowed_exception",
    description: "descrizione valida",
    hiddenCheckIds: ["bare-except-pass"],
    expectsCatch: false,
  };
}

describe("evaluateCatch", () => {
  const base = {
    id: "adv-c",
    category: "weak_assertion" as AdversarialCategory,
    description: "d",
    expectsCatch: true,
  };

  it("is true on non-empty intersection", () => {
    expect(evaluateCatch({ ...base, hiddenCheckIds: ["assert-true"] }, ["test-skip", "assert-true"])).toBe(true);
    expect(evaluateCatch({ ...base, hiddenCheckIds: ["a", "b"] }, ["b"])).toBe(true);
  });

  it("is false when no hidden check fired, or the list is empty", () => {
    expect(evaluateCatch({ ...base, hiddenCheckIds: ["assert-true"] }, ["test-skip"])).toBe(false);
    expect(evaluateCatch({ ...base, hiddenCheckIds: ["assert-true"] }, [])).toBe(false);
    expect(evaluateCatch({ ...base, hiddenCheckIds: [] }, ["assert-true"])).toBe(false);
  });
});

describe("computeBenchMetrics", () => {
  it("returns all zeros (no NaN) for zero runs", () => {
    expect(computeBenchMetrics([])).toEqual({
      total: 0,
      successRate: 0,
      catchRate: 0,
      falseSuccessRate: 0,
      avgRetries: 0,
      avgRepairDepth: 0,
      avgTokens: 0,
    });
  });

  it("computes exact fractions on known cases", () => {
    const runs: BenchRunResult[] = [
      makeRun({ caseId: "a", passed: true, caught: true, falseSuccess: false }),
      makeRun({ caseId: "b", passed: true, caught: false, falseSuccess: true }),
      makeRun({ caseId: "c", passed: false, caught: true, falseSuccess: false, retries: 2, repairDepth: 1 }),
      makeRun({ caseId: "d", passed: false, caught: false, falseSuccess: false, tokens: 300 }),
    ];
    const m = computeBenchMetrics(runs);
    expect(m.total).toBe(4);
    expect(m.successRate).toBeCloseTo(0.5, 10);
    expect(m.catchRate).toBeCloseTo(0.5, 10);
    expect(m.falseSuccessRate).toBeCloseTo(0.25, 10); // 1/4 exactly
    expect(m.avgRetries).toBeCloseTo(0.5, 10);
    expect(m.avgRepairDepth).toBeCloseTo(0.25, 10);
    expect(m.avgTokens).toBeCloseTo(150, 10); // (100*3 + 300) / 4
  });

  it("counts falseSuccess independently of caught", () => {
    const runs = [makeRun({ falseSuccess: true, caught: false })];
    expect(computeBenchMetrics(runs).falseSuccessRate).toBe(1);
  });
});
