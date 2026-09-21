/** Adaptive Strategy Layer — gate, modes, store, lifecycle, security invariants. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RELIABILITY_POLICY,
  type PatternCandidate,
  type Strategy,
  createAdaptiveEngine,
  detectCandidates,
  evaluateReliability,
  isValidStrategyShape,
} from "../src/adaptive";
import type { AgentPerformanceProfile } from "../src/learning";

const tmpDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ely-adaptive-${Date.now()}-`));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const candidate = (overrides: Partial<PatternCandidate> = {}): PatternCandidate => ({
  pattern: "failure:exit-code-zero",
  sampleCount: 12,
  patternRate: 0.3,
  conflictRate: 0.05,
  evidenceCompleteness: 0.9,
  meanConfidence: 0.8,
  ...overrides,
});

const profile = (overrides: Partial<AgentPerformanceProfile> = {}): AgentPerformanceProfile => ({
  version: "perf-v1",
  generatedAt: new Date().toISOString(),
  sampleCount: 40,
  totalRunsIngested: 40,
  metrics: {
    verifiedSuccessRate: 0.7,
    falseSuccessRate: 0.1,
    falseFailureRate: 0.05,
    postconditionSuccessRate: 0.85,
    averageScore: 0.85,
    averageConfidence: 0.8,
    confidenceCalibration: 0.85,
    retryRate: 0.1,
    evidenceCompleteness: 0.9,
  },
  taskPatterns: [],
  failurePatterns: [
    {
      key: "failure:exit-code-zero",
      summary: "failure pattern: exit-code-zero",
      sampleCount: 12,
      rate: 0.3,
      lastSeenAt: new Date().toISOString(),
    },
  ],
  dataSufficient: true,
  fallbackReason: null,
  ...overrides,
});

describe("reliability gate (deterministic, no hidden thresholds)", () => {
  it("rejects below minimumSamples — one run is never a strategy", () => {
    const v = evaluateReliability(candidate({ sampleCount: 1 }), DEFAULT_RELIABILITY_POLICY);
    expect(v.reliable).toBe(false);
    expect(v.reasons.join(" ")).toContain("one run is never a strategy");
  });

  it("rejects low pattern rate, low confidence, low completeness", () => {
    expect(
      evaluateReliability(candidate({ patternRate: 0.05 }), DEFAULT_RELIABILITY_POLICY).reliable,
    ).toBe(false);
    expect(
      evaluateReliability(candidate({ meanConfidence: 0.2 }), DEFAULT_RELIABILITY_POLICY).reliable,
    ).toBe(false);
    expect(
      evaluateReliability(candidate({ evidenceCompleteness: 0.2 }), DEFAULT_RELIABILITY_POLICY)
        .reliable,
    ).toBe(false);
  });

  it("rejects conflicting patterns (conflict rate above maximum)", () => {
    const v = evaluateReliability(candidate({ conflictRate: 0.9 }), DEFAULT_RELIABILITY_POLICY);
    expect(v.reliable).toBe(false);
    expect(v.reasons.join(" ")).toContain("conflicting pattern");
  });

  it("accepts a solid candidate and returns a deterministic score", () => {
    const a = evaluateReliability(candidate(), DEFAULT_RELIABILITY_POLICY);
    const b = evaluateReliability(candidate(), DEFAULT_RELIABILITY_POLICY);
    expect(a.reliable).toBe(true);
    expect(a.score).toBe(b.score);
  });
});

describe("modes", () => {
  it("default is disabled — nothing approved/applied before an explicit choice", () => {
    const engine = createAdaptiveEngine({ root: makeDir() });
    expect(engine.mode()).toBe("disabled");
    const decisions = engine.learnFrom(profile());
    // learnFrom still records the gate audit in disabled mode, but applies nothing.
    expect(decisions.every((d) => d.applied === false)).toBe(true);
    expect(engine.applicableStrategies()).toHaveLength(0);
  });

  it("observe records decisions but never applies", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({ root: dir });
    engine.setMode("observe");
    const decisions = engine.learnFrom(profile());
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.applied === false)).toBe(true);
    expect(engine.applicableStrategies()).toHaveLength(0);
  });

  it("suggest approves strategies but applies nothing", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({ root: dir });
    engine.setMode("suggest");
    const decisions = engine.learnFrom(profile());
    const approved = decisions.find((d) => d.reason.includes("approved"));
    expect(approved).toBeDefined();
    expect(approved?.applied).toBe(false);
    expect(engine.applicableStrategies()).toHaveLength(0);
  });

  it("apply marks matching strategies applicable", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({ root: dir });
    engine.setMode("apply");
    engine.learnFrom(profile());
    const applicable = engine.applicableStrategies();
    expect(applicable.length).toBeGreaterThan(0);
    expect(applicable.every((s) => s.status === "enabled")).toBe(true);
  });
});

describe("strategy validation and security invariants", () => {
  it("rejects actions outside the closed safe vocabulary", () => {
    const hostile = {
      id: "x",
      version: 1 as const,
      condition: { pattern: "p" },
      action: { kind: "ALLOW_COMMAND" as unknown as Strategy["action"]["kind"] },
      sourcePattern: "p",
      sampleCount: 12,
      reliability: {
        score: 0.9,
        sampleCount: 12,
        patternRate: 0.3,
        conflictRate: 0,
        evidenceCompleteness: 0.9,
        policyVersion: 1,
      },
      createdAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      status: "enabled" as const,
    };
    expect(isValidStrategyShape(hostile)).toBe(false);
  });

  it("ADD_POSTCONDITION_VERIFICATION without a postcondition name is invalid", () => {
    const s = {
      id: "x",
      version: 1 as const,
      condition: { pattern: "p" },
      action: { kind: "ADD_POSTCONDITION_VERIFICATION" as const },
      sourcePattern: "p",
      sampleCount: 1,
      reliability: {
        score: 0.9,
        sampleCount: 1,
        patternRate: 0.3,
        conflictRate: 0,
        evidenceCompleteness: 0.9,
        policyVersion: 1,
      },
      createdAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      status: "enabled" as const,
    };
    expect(isValidStrategyShape(s)).toBe(false);
  });

  it("safe strategies pass shape validation", () => {
    const engine = createAdaptiveEngine({ root: makeDir() });
    engine.setMode("apply");
    const decisions = engine.learnFrom(profile());
    // Every approved decision's action must be within the safe vocabulary.
    for (const d of decisions) {
      if (d.reason.includes("approved")) {
        expect([
          "ADD_POSTCONDITION_VERIFICATION",
          "SUGGEST_EXTRA_CHECK",
          "REQUIRE_EVIDENCE",
        ]).toContain(d.action.kind);
      }
    }
  });
});

describe("store persistence and lifecycle", () => {
  it("corrupted strategy store falls back to disabled with no strategies", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, ".elysium", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".elysium", "learning", "strategies.json"),
      "{corrupt",
      "utf-8",
    );
    const engine = createAdaptiveEngine({ root: dir });
    expect(engine.mode()).toBe("disabled");
    expect(engine.store().strategies).toHaveLength(0);
  });

  it("duplicate strategy id is an upsert, never duplicated", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({ root: dir });
    engine.setMode("apply");
    engine.learnFrom(profile());
    engine.learnFrom(profile());
    const ids = engine.store().strategies.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stale strategies (age > policy.maxAgeMs) are not applicable; refresh marks them", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({
      root: dir,
      policy: { ...DEFAULT_RELIABILITY_POLICY, maxAgeMs: 1000 },
    });
    engine.setMode("apply");
    engine.learnFrom(profile());
    expect(engine.applicableStrategies().length).toBeGreaterThan(0);
    // Simulate ageing past the policy window.
    const later = Date.now() + 2000;
    expect(engine.applicableStrategies(later)).toHaveLength(0);
    const decisions = engine.refresh(later);
    expect(decisions.some((d) => d.reason.includes("stale"))).toBe(true);
    expect(engine.store().strategies.every((s) => s.status !== "enabled")).toBe(true);
  });

  it("invalidated strategies are not applicable", () => {
    const dir = makeDir();
    const engine = createAdaptiveEngine({ root: dir });
    engine.setMode("apply");
    engine.learnFrom(profile());
    const store = engine.store();
    const invalidated = store.strategies.map((s) => ({ ...s, status: "invalidated" as const }));
    fs.writeFileSync(
      path.join(dir, ".elysium", "learning", "strategies.json"),
      JSON.stringify({ version: 1, mode: "apply", strategies: invalidated }),
      "utf-8",
    );
    expect(engine.applicableStrategies()).toHaveLength(0);
  });

  it("persistence/reload: a fresh engine sees the same strategies", () => {
    const dir = makeDir();
    const a = createAdaptiveEngine({ root: dir });
    a.setMode("suggest");
    a.learnFrom(profile());
    const b = createAdaptiveEngine({ root: dir });
    expect(b.mode()).toBe("suggest");
    expect(b.store().strategies.length).toBe(a.store().strategies.length);
  });

  it("malformed strategies in the store are dropped on load (safe fallback)", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, ".elysium", "learning"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".elysium", "learning", "strategies.json"),
      JSON.stringify({
        version: 1,
        mode: "apply",
        strategies: [{ garbage: true }, { id: "half" }, null, "string"],
      }),
      "utf-8",
    );
    const engine = createAdaptiveEngine({ root: dir });
    expect(engine.store().strategies).toHaveLength(0);
  });
});

describe("audit trail", () => {
  it("every decision carries strategyId, trigger, reliability, evidence, reason", () => {
    const engine = createAdaptiveEngine({ root: makeDir() });
    engine.setMode("observe");
    const decisions = engine.learnFrom(profile());
    for (const d of decisions) {
      expect(d.strategyId).toMatch(/^strategy-/);
      expect(d.triggerPattern.length).toBeGreaterThan(0);
      expect(d.reliability).toBeGreaterThanOrEqual(0);
      expect(d.evidence.sampleCount).toBeGreaterThan(0);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.at).toBeTruthy();
    }
  });
});

describe("history stress", () => {
  it("detectCandidates over a 1000-pattern profile stays fast and bounded", () => {
    const patterns = Array.from({ length: 1000 }, (_, i) => ({
      key: `failure:p${i}`,
      summary: `p${i}`,
      sampleCount: 10,
      rate: 0.01,
      lastSeenAt: new Date().toISOString(),
    }));
    const t0 = Date.now();
    const candidates = detectCandidates(profile({ failurePatterns: patterns }));
    expect(candidates.length).toBe(1000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
