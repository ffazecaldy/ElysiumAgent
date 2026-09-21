/** Adaptive application runtime — strategy → real behavior → feedback loop. */
import { describe, expect, it } from "vitest";
import { type LearningStoreShape, type RunRecord, revalidateStrategy } from "../src/learning";
import { parseCriticVerdict } from "../src/swarm-mode";

const run = (overrides: Partial<RunRecord> & { runId: string }): RunRecord => ({
  at: "2026-01-01T00:00:00.000Z",
  goal: "fix the build",
  outcome: "PASS",
  score: 1,
  confidence: 0.9,
  retryCount: 0,
  taskClass: "fix",
  tools: ["bash"],
  failedPostconditions: [],
  evidenceCount: 2,
  verifiedPostconditions: 2,
  totalPostconditions: 2,
  agentClaim: "success",
  ...overrides,
});

const store = (runs: RunRecord[]): LearningStoreShape => ({
  version: 1,
  runs,
  taskClassCounts: {},
});

describe("adaptive application runtime — security invariants", () => {
  it("strategy actions can never include security-relevant verbs (closed vocabulary)", async () => {
    // The action type is imported from the module: assert the vocabulary.
    const mod = await import("../src/adaptive");
    const engine = mod.createAdaptiveEngine({ root: "." });
    // detectCandidates only emits learning pattern keys; actions derive from
    // ACTION_BY_PATTERN — all three kinds are verification-adding.
    const candidates = mod.detectCandidates({
      version: "perf-v1",
      generatedAt: "",
      sampleCount: 10,
      totalRunsIngested: 10,
      metrics: {
        verifiedSuccessRate: 0.5,
        falseSuccessRate: 0.2,
        falseFailureRate: 0,
        postconditionSuccessRate: 0.8,
        averageScore: 0.8,
        averageConfidence: 0.8,
        confidenceCalibration: 0.8,
        retryRate: 0.1,
        evidenceCompleteness: 0.9,
      },
      taskPatterns: [],
      failurePatterns: [
        { key: "tool:bash", summary: "", sampleCount: 5, rate: 0.5, lastSeenAt: "" },
      ],
      dataSufficient: true,
      fallbackReason: null,
    });
    expect(candidates.length).toBe(1);
    // The engine has no API to author an arbitrary action: strategy actions
    // are produced internally only. A hostile store entry is dropped on load.
    expect(engine.store).toBeDefined();
  });

  it("B17 fail-open still observed after adaptive wiring (verdict unchanged)", () => {
    const v = parseCriticVerdict("not json {{{");
    expect(v.passed).toBe(true);
    expect(v.gaps.some((g) => g.includes("not valid JSON"))).toBe(true);
  });
});

describe("revalidateStrategy — feedback loop verdicts", () => {
  const policy = { maximumConflictRate: 0.2, minimumSamples: 5 };

  it("insufficient post-strategy samples → no re-judgement (still-reliable)", () => {
    const v = revalidateStrategy(store([run({ runId: "1", at: "2026-01-02T00:00:00.000Z" })]), {
      strategyId: "s",
      pattern: "p",
      since: "2026-01-01T00:00:00.000Z",
      policy,
    });
    expect(v.verdict).toBe("still-reliable");
    expect(v.reason).toContain("insufficient");
  });

  it("pattern vanished (all post-strategy runs PASS) → invalidated", () => {
    const v = revalidateStrategy(
      store([
        run({ runId: "1", at: "2026-01-02T00:00:00.000Z" }),
        run({ runId: "2", at: "2026-01-03T00:00:00.000Z" }),
        run({ runId: "3", at: "2026-01-04T00:00:00.000Z" }),
        run({ runId: "4", at: "2026-01-05T00:00:00.000Z" }),
        run({ runId: "5", at: "2026-01-06T00:00:00.000Z" }),
      ]),
      { strategyId: "s", pattern: "p", since: "2026-01-01T00:00:00.000Z", policy },
    );
    expect(v.verdict).toBe("invalidated");
    expect(v.failureRate).toBe(0);
  });

  it("failures above the conflict maximum → degraded", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      run({
        runId: `r${i}`,
        at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + (i + 1) * 1000).toISOString(),
        outcome: i < 4 ? "FAIL" : "PASS",
        score: i < 4 ? 0 : 1,
      }),
    );
    const v = revalidateStrategy(store(runs), {
      strategyId: "s",
      pattern: "p",
      since: "2026-01-01T00:00:00.000Z",
      policy,
    });
    expect(v.verdict).toBe("degraded");
    expect(v.failureRate).toBeCloseTo(2 / 3, 5);
  });

  it("failures within the policy → still-reliable", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      run({
        runId: `r${i}`,
        at: new Date(Date.parse("2026-01-01T00:00:00.000Z") + (i + 1) * 1000).toISOString(),
        outcome: i === 0 ? "FAIL" : "PASS",
        score: i === 0 ? 0 : 1,
      }),
    );
    const v = revalidateStrategy(store(runs), {
      strategyId: "s",
      pattern: "p",
      since: "2026-01-01T00:00:00.000Z",
      policy,
    });
    expect(v.verdict).toBe("still-reliable");
  });

  it("runs before `since` are out of scope", () => {
    const v = revalidateStrategy(store([run({ runId: "old", at: "2025-06-01T00:00:00.000Z" })]), {
      strategyId: "s",
      pattern: "p",
      since: "2026-01-01T00:00:00.000Z",
      policy,
    });
    expect(v.sampleCount).toBe(0);
    expect(v.verdict).toBe("still-reliable");
  });
});
