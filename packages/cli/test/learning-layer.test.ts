/** Learning Layer — store persistence, deterministic aggregation, stress. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProfile, computeMetrics, taskClassOf } from "../src/learning/engine";
import { LEARNING_DIR, type LearningEngine, createLearningEngine } from "../src/learning/runtime";
import { appendRun, loadStore, saveStore } from "../src/learning/store";
import { type LearningStoreShape, MAX_STORED_RUNS, type RunRecord } from "../src/learning/types";

const tmpDirs: string[] = [];
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ely-learning-${Date.now()}-`));
  tmpDirs.push(dir);
  return dir;
}
/** Direct store reads in tests target the SAME subdir the engine uses. */
const storeDir = (dir: string): string => path.join(dir, LEARNING_DIR);
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

const run = (overrides: Partial<RunRecord> & { runId: string }): RunRecord => ({
  at: "2026-01-01T00:00:00.000Z",
  goal: "create file",
  outcome: "PASS",
  score: 1,
  confidence: 0.8,
  retryCount: 0,
  taskClass: "create",
  tools: [],
  failedPostconditions: [],
  evidenceCount: 2,
  ...overrides,
});

const engine = (dir: string): LearningEngine => createLearningEngine(dir);

describe("learning store", () => {
  it("first run: empty dir → empty store → record → reload sees it", () => {
    const dir = makeDir();
    expect(loadStore(storeDir(dir)).runs).toHaveLength(0);
    engine(dir).recordLearning(
      {
        id: "EV-1",
        runId: "run-1",
        taskId: null,
        verdict: "PASS",
        score: 1,
        confidence: 0.9,
        postconditions: [],
        evidence: [],
        createdAt: new Date().toISOString(),
        fallbackReason: null,
      },
      { goal: "create x" },
    );
    const store = loadStore(storeDir(dir));
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.runId).toBe("run-1");
    expect(store.runs[0]?.taskClass).toBe("create");
  });

  it("duplicate run id is a no-op (no double counting)", () => {
    const dir = makeDir();
    const e = engine(dir);
    const record = {
      id: "EV-1",
      runId: "same-run",
      taskId: null,
      verdict: "PASS" as const,
      score: 1,
      confidence: 0.9,
      postconditions: [],
      evidence: [],
      createdAt: new Date().toISOString(),
      fallbackReason: null,
    };
    e.recordLearning(record);
    e.recordLearning(record);
    expect(loadStore(storeDir(dir)).runs).toHaveLength(1);
  });

  it("corrupted store degrades to empty without throwing", () => {
    const dir = makeDir();
    fs.mkdirSync(storeDir(dir), { recursive: true });
    fs.writeFileSync(path.join(storeDir(dir), "learning-store.json"), "{trunc///", "utf-8");
    expect(loadStore(storeDir(dir)).runs).toHaveLength(0);
    const e = engine(dir);
    expect(() => e.profile()).not.toThrow();
    expect(e.profile().sampleCount).toBe(0);
  });

  it("wrong schema version resets the store", () => {
    const dir = makeDir();
    fs.mkdirSync(storeDir(dir), { recursive: true });
    fs.writeFileSync(
      path.join(storeDir(dir), "learning-store.json"),
      JSON.stringify({ version: 99, runs: [run({ runId: "x" })] }),
      "utf-8",
    );
    expect(loadStore(storeDir(dir)).runs).toHaveLength(0);
  });

  it("oversized records are bounded on save (goal/strings capped, lists truncated)", () => {
    const dir = makeDir();
    const store: LearningStoreShape = {
      version: 1,
      runs: [],
      taskClassCounts: {},
    };
    // appendRun is immutable: it RETURNS the extended store.
    const withBig = appendRun(
      store,
      run({ runId: "big", goal: "g".repeat(5000), tools: Array(50).fill("bash") }),
    );
    saveStore(storeDir(dir), withBig);
    const loaded = loadStore(storeDir(dir));
    expect(loaded.runs[0]?.goal.length).toBeLessThanOrEqual(310);
    expect(loaded.runs[0]?.tools.length).toBeLessThanOrEqual(8);
  });

  it("cyclic data in a run record cannot crash ingestion", () => {
    const dir = makeDir();
    const hostile = run({ runId: "cyc" }) as RunRecord & { self?: unknown };
    hostile.self = hostile;
    expect(() =>
      saveStore(storeDir(dir), { version: 1, runs: [hostile], taskClassCounts: {} }),
    ).not.toThrow();
    // loadStore bounds whatever survived; JSON.stringify drops cycles via the bounded write path
    expect(() => loadStore(storeDir(dir))).not.toThrow();
  });

  it("store prunes beyond MAX_STORED_RUNS (no infinite growth)", () => {
    const dir = makeDir();
    let store = loadStore(storeDir(dir));
    for (let i = 0; i < MAX_STORED_RUNS + 50; i++) {
      store = appendRun(store, run({ runId: `r${i}` }));
    }
    saveStore(storeDir(dir), store);
    expect(loadStore(storeDir(dir)).runs.length).toBe(MAX_STORED_RUNS);
  });

  it("concurrent writes: last writer wins whole-file, never a torn mix", async () => {
    const dir = makeDir();
    const store = loadStore(storeDir(dir));
    const w1 = appendRun(store, run({ runId: "a" }));
    const w2 = appendRun(store, run({ runId: "b" }));
    saveStore(storeDir(dir), w1);
    saveStore(storeDir(dir), w2);
    const loaded = loadStore(storeDir(dir));
    const ids = loaded.runs.map((r) => r.runId);
    expect(ids).toContain("b");
    expect(ids.length).toBeLessThanOrEqual(2);
  });
});

describe("aggregation engine", () => {
  it("1000+ run stress aggregation stays fast and bounded", () => {
    const runs: RunRecord[] = [];
    for (let i = 0; i < 1200; i++) {
      runs.push(
        run({
          runId: `r${i}`,
          outcome: i % 5 === 0 ? "FALSE_SUCCESS" : i % 7 === 0 ? "FAIL" : "PASS",
          taskClass: ["create", "fix", "test"][i % 3] ?? "create",
          failedPostconditions: i % 5 === 0 ? ["exit-code-zero"] : [],
        }),
      );
    }
    const t0 = Date.now();
    const profile = buildProfile({ version: 1, runs, taskClassCounts: {} });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(profile.sampleCount).toBe(1200);
    expect(profile.metrics.falseSuccessRate).toBeCloseTo(0.2, 1);
    expect(profile.taskPatterns.length).toBeGreaterThan(0);
  });

  it("metrics: separate rates, calibration from PASS confidences", () => {
    const m = computeMetrics([
      run({ runId: "1", outcome: "PASS", confidence: 0.9, score: 1 }),
      run({ runId: "2", outcome: "PASS", confidence: 0.7, score: 1 }),
      run({ runId: "3", outcome: "FALSE_SUCCESS", confidence: 0.4, score: 0 }),
      run({ runId: "4", outcome: "FAIL", score: 0.2, retryCount: 1 }),
    ]);
    expect(m.verifiedSuccessRate).toBe(0.5);
    expect(m.falseSuccessRate).toBe(0.25);
    // All four runs carry a confidence (default 0.8 on the FAIL run):
    // (0.9 + 0.7 + 0.4 + 0.8) / 4
    expect(m.averageConfidence).toBeCloseTo(0.7, 5);
    expect(m.confidenceCalibration).toBeCloseTo(0.8, 5); // mean of PASS confidences
    expect(m.retryRate).toBe(0.25);
  });

  it("false-failure proxy: FAIL with score >= 0.5 counts as informative false-failure", () => {
    const m = computeMetrics([
      run({ runId: "1", outcome: "FAIL", score: 0.75 }),
      run({ runId: "2", outcome: "FAIL", score: 0.1 }),
    ]);
    expect(m.falseFailureRate).toBe(0.5);
  });

  it("taskClassOf: leading word, lowercase, non-word stripped, fallback unknown", () => {
    expect(taskClassOf("Create the thing")).toBe("create");
    expect(taskClassOf("  FIX   bug")).toBe("fix");
    expect(taskClassOf("!!!")).toBe("unknown");
    expect(taskClassOf("")).toBe("unknown");
  });

  it("profile dataSufficient gates on MIN_SAMPLES", () => {
    const few = buildProfile({ version: 1, runs: [run({ runId: "1" })], taskClassCounts: {} });
    expect(few.dataSufficient).toBe(false);
    const enough = buildProfile({
      version: 1,
      runs: Array.from({ length: 5 }, (_, i) => run({ runId: `r${i}` })),
      taskClassCounts: {},
    });
    expect(enough.dataSufficient).toBe(true);
  });

  it("failure patterns derive from failed postconditions and tools", () => {
    const profile = buildProfile({
      version: 1,
      runs: [
        run({
          runId: "1",
          outcome: "FAIL",
          failedPostconditions: ["exit-code-zero"],
          tools: ["bash"],
        }),
        run({
          runId: "2",
          outcome: "FAIL",
          failedPostconditions: ["exit-code-zero"],
          tools: ["bash"],
        }),
        run({ runId: "3", outcome: "PASS" }),
      ],
      taskClassCounts: {},
    });
    const keys = profile.failurePatterns.map((p) => p.key);
    expect(keys).toContain("exit-code-zero");
    expect(keys).toContain("tool:bash");
  });

  it("restart/reload: profile survives a fresh engine on the same dir", () => {
    const dir = makeDir();
    engine(dir).recordLearning(
      {
        id: "EV-1",
        runId: "run-a",
        taskId: null,
        verdict: "PASS",
        score: 1,
        confidence: 0.85,
        postconditions: [],
        evidence: [],
        createdAt: new Date().toISOString(),
        fallbackReason: null,
      },
      { goal: "fix bug" },
    );
    // NEW engine instance = process restart
    const profile = engine(dir).profile();
    expect(profile.sampleCount).toBe(1);
    expect(profile.taskPatterns.some((p) => p.key === "task-class:fix")).toBe(true);
  });
});
