import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, makeEvent } from "@elysium/core";
import type { HarnessEvent } from "@elysium/core";
import { describe, expect, it, vi } from "vitest";
import { HypothesisEngine } from "../src/hypotheses/engine";
import { MetaLayer } from "../src/loop";
import { HypothesisStore } from "../src/store/hypothesis-store";
import { TelemetryStore } from "../src/store/telemetry-store";

function taskEnded(status: string, taskId: string): HarnessEvent {
  return makeEvent("task_ended", { status }, { runId: "run-1", taskId });
}

function latency(ms: number, taskId: string): HarnessEvent {
  return makeEvent("latency", { scope: "task", durationMs: ms }, { runId: "run-1", taskId });
}

describe("TelemetryStore", () => {
  it("persists JSONL verbatim and reloads", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ml-")), "t.jsonl");
    const s1 = new TelemetryStore({ filePath: file });
    s1.append(taskEnded("pass", "t1"));
    s1.append(latency(100, "t1"));
    expect(s1.size()).toBe(2);
    const s2 = new TelemetryStore({ filePath: file });
    expect(s2.size()).toBe(2);
    expect(s2.query({ type: "latency" })).toHaveLength(1);
    expect(s2.query({ taskId: "t1", type: "task_ended" })).toHaveLength(1);
    expect(s2.query({ taskId: "t2" })).toHaveLength(0);
  });

  it("filters by time window", () => {
    const s = new TelemetryStore({
      filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ml-")), "t.jsonl"),
    });
    const e1 = taskEnded("pass", "a");
    e1.timestamp = "2026-01-01T00:00:00.000Z";
    const e2 = taskEnded("fail", "b");
    e2.timestamp = "2026-06-01T00:00:00.000Z";
    s.append(e1);
    s.append(e2);
    expect(s.query({ since: "2026-03-01T00:00:00.000Z" })).toHaveLength(1);
    expect(s.query({ until: "2026-03-01T00:00:00.000Z" })).toHaveLength(1);
  });
});

describe("HypothesisEngine", () => {
  it("proposes nothing below the minimum window", () => {
    const engine = new HypothesisEngine({ minWindow: 5 });
    const events = [taskEnded("fail", "t1"), taskEnded("fail", "t2")];
    expect(engine.observe(events)).toHaveLength(0);
  });

  it("proposes a retry-policy hypothesis when first-pass rate is low", () => {
    const engine = new HypothesisEngine({ minWindow: 5 });
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(taskEnded(i < 4 ? "pass" : "fail", `t${i}`));
    }
    const proposed = engine.observe(events);
    expect(proposed.length).toBeGreaterThanOrEqual(1);
    expect(proposed[0]?.change.kind).toBe("retry_policy");
    expect(proposed[0]?.observation.metric).toBe("first_pass_rate");
    expect(proposed[0]?.status).toBe("proposed");
  });

  it("proposes a concurrency hypothesis when latency is high", () => {
    const engine = new HypothesisEngine({ minWindow: 3, latencyThresholdMs: 1000 });
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(taskEnded("pass", `t${i}`));
      events.push(latency(5000, `t${i}`));
    }
    const proposed = engine.observe(events);
    expect(proposed.some((h) => h.change.kind === "max_concurrency")).toBe(true);
  });

  it("marks transitions with delta values", () => {
    const engine = new HypothesisEngine(); // default minWindow: 5
    const proposed = engine.observe([taskEnded("fail", "x")]);
    expect(proposed).toHaveLength(0); // below the minimum window
    const h = engine.observe([
      taskEnded("fail", "a"),
      taskEnded("fail", "b"),
      taskEnded("fail", "c"),
      taskEnded("pass", "d"),
      taskEnded("fail", "e"),
    ]);
    expect(h.length).toBe(1);
    const id = h[0]?.id ?? "";
    engine.markApplied(id);
    engine.markPromoted(id, 0.12);
    const stored = engine.get(id);
    expect(stored?.status).toBe("promoted");
    expect(stored?.delta).toBe(0.12);
  });

  it("does not propose a duplicate hypothesis for the same metric+change.kind while one is active", () => {
    const engine = new HypothesisEngine({ minWindow: 3 });
    const failingEvents: HarnessEvent[] = [];
    for (let i = 0; i < 5; i++) failingEvents.push(taskEnded("fail", `t${i}`));

    const first = engine.observe(failingEvents);
    expect(first).toHaveLength(1);

    // A second identical window skips the existing non-rejected hypothesis.
    const second = engine.observe(failingEvents.map((e) => ({ ...e, taskId: `u${e.taskId}` })));
    expect(second).toHaveLength(0);

    // Applied hypotheses still block; rejected ones no longer do.
    const id = first[0]?.id ?? "";
    engine.markRejected(id, -0.01);
    const third = engine.observe(failingEvents);
    expect(third).toHaveLength(1);
    expect(third[0]?.id).not.toBe(id);
  });

  it("does not duplicate the latency hypothesis while active", () => {
    const engine = new HypothesisEngine({ minWindow: 3, latencyThresholdMs: 1000 });
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(taskEnded("pass", `t${i}`));
      events.push(latency(5000, `t${i}`));
    }
    expect(engine.observe(events).filter((h) => h.change.kind === "max_concurrency")).toHaveLength(
      1,
    );
    const secondWindow = events.map((e) => ({ ...e, taskId: `${e.taskId}-b` }));
    expect(
      engine.observe(secondWindow).filter((h) => h.change.kind === "max_concurrency"),
    ).toHaveLength(0);
  });
});

describe("HypothesisStore", () => {
  it("persists JSONL and restores", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const file = path.join(dir, "h.jsonl");
    const engine = new HypothesisEngine({ minWindow: 3 });
    const h = engine.observe([
      taskEnded("fail", "a"),
      taskEnded("fail", "b"),
      taskEnded("fail", "c"),
    ]);
    expect(h).toHaveLength(1);
    const s1 = new HypothesisStore({ filePath: file });
    s1.append(h[0] as NonNullable<(typeof h)[0]>);
    engine.markPromoted(h[0]?.id ?? "", 0.3);
    s1.update({ ...(h[0] as NonNullable<(typeof h)[0]>), status: "promoted", delta: 0.3 });

    // Restore on a "restart": a fresh engine gets hydrated from the store.
    const s2 = new HypothesisStore({ filePath: file });
    expect(s2.size()).toBe(2); // original proposal + updated record
    const latest = new Map(s2.all().map((x) => [x.id, x]));
    const engine2 = new HypothesisEngine({ minWindow: 3 });
    for (const hyp of latest.values()) engine2.restore(hyp);
    expect(engine2.list()).toHaveLength(1);
    expect(engine2.get(h[0]?.id ?? "")?.status).toBe("promoted");

    // Restored state still drives dedup: no duplicate proposal.
    const again = engine2.observe([
      taskEnded("fail", "z1"),
      taskEnded("fail", "z2"),
      taskEnded("fail", "z3"),
    ]);
    expect(again).toHaveLength(0);
  });

  it("skips malformed and invalid lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const file = path.join(dir, "h.jsonl");
    fs.writeFileSync(file, "not-json\n{}\n", "utf-8");
    const s = new HypothesisStore({ filePath: file });
    expect(s.size()).toBe(0);
  });

  it("ignores updates for unknown ids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const s = new HypothesisStore({ filePath: path.join(dir, "h.jsonl") });
    expect(() =>
      s.update({
        id: "hyp_missing",
        observation: { metric: "first_pass_rate", value: 0.5, window: 5 },
        change: { kind: "retry_policy", from: {}, to: {} },
        expectedEffect: "n/a",
        status: "applied",
        delta: null,
      }),
    ).not.toThrow();
    expect(s.size()).toBe(0);
  });
});

describe("MetaLayer closed loop", () => {
  it("persists bus events, proposes, applies, promotes only positive deltas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const engine = new HypothesisEngine({ minWindow: 5 });
    let config = { repairRounds: 1, maxConcurrency: 4 };
    const applied: Array<{ repairRounds: number; maxConcurrency: number }> = [];
    // Deterministic measurement: first-pass rate improves when repairRounds = 2.
    const measure = async (metric: string): Promise<number> => {
      if (metric !== "first_pass_rate") return 0;
      return config.repairRounds >= 2 ? 0.8 : 0.5;
    };
    const meta = new MetaLayer({
      store,
      engine,
      config,
      evaluationInterval: 1000, // no auto-trigger on this path
      applyConfig: async (next) => {
        config = next;
        applied.push({ ...next });
      },
      measure,
    });
    const bus = new EventBus();
    meta.attach(bus);

    // Feed 10 failing-ish tasks through the real bus, then evaluate explicitly.
    for (let i = 0; i < 10; i++) {
      bus.emit(taskEnded("fail", `t${i}`));
    }
    await meta.evaluateNow();

    const stats = meta.getStats();
    expect(stats.persisted).toBeGreaterThanOrEqual(10);
    expect(stats.hypothesesProposed).toBeGreaterThanOrEqual(1);
    expect(config.repairRounds).toBe(2);
    expect(stats.promoted).toBeGreaterThanOrEqual(1);
    const promoted = engine.list().filter((h) => h.status === "promoted");
    expect(promoted.length).toBeGreaterThanOrEqual(1);
    void applied;
  });

  it("rolls back when the delta is not positive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const engine = new HypothesisEngine({ minWindow: 5 });
    let config = { repairRounds: 1, maxConcurrency: 4 };
    const meta = new MetaLayer({
      store,
      engine,
      config,
      evaluationInterval: 5,
      applyConfig: async (next) => {
        config = next;
      },
      measure: async () => 0.5, // constant -> delta 0 -> reject + rollback
    });
    const bus = new EventBus();
    meta.attach(bus);
    for (let i = 0; i < 6; i++) {
      bus.emit(taskEnded("fail", `t${i}`));
    }
    await meta.evaluateNow();
    expect(config.repairRounds).toBe(1); // rolled back
    expect(engine.list().some((h) => h.status === "rejected")).toBe(true);
  });

  it("restores the engine from the hypothesis store on restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const hypStore = new HypothesisStore({ filePath: path.join(dir, "h.jsonl") });
    const config = { repairRounds: 1, maxConcurrency: 4 };
    const mk = (): { meta: MetaLayer; engine: HypothesisEngine } => {
      const engine = new HypothesisEngine({ minWindow: 5 });
      const meta = new MetaLayer({
        store,
        engine,
        config: { ...config },
        evaluationInterval: 1000,
        applyConfig: async () => {},
        measure: async () => 0.5, // constant -> reject, but still persisted
        hypothesisStore: hypStore,
      });
      return { meta, engine };
    };
    const bus = new EventBus();
    const { meta: meta1 } = mk();
    meta1.attach(bus);
    for (let i = 0; i < 6; i++) bus.emit(taskEnded("fail", `t${i}`));
    await meta1.evaluateNow();

    // "Restart": fresh engine, fresh MetaLayer, same store.
    const { meta: meta2, engine: engine2 } = mk();
    for (const hyp of latestById(hypStore).values()) engine2.restore(hyp);
    meta2.attach(bus);
    // Restored rejected hypothesis no longer blocks new proposals.
    for (let i = 0; i < 6; i++) bus.emit(taskEnded("fail", `u${i}`));
    await meta2.evaluateNow();
    const stats2 = meta2.getStats();
    expect(stats2.hypothesesProposed).toBeGreaterThanOrEqual(1);
    expect(latestById(hypStore).size).toBeGreaterThanOrEqual(2);
  });

  it("emits an error HarnessEvent on the bus when evaluation fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const engine = new HypothesisEngine({ minWindow: 5 });
    const meta = new MetaLayer({
      store,
      engine,
      config: { repairRounds: 1, maxConcurrency: 4 },
      evaluationInterval: 5,
      applyConfig: async () => {},
      measure: async () => {
        throw new Error("boom");
      },
    });
    const bus = new EventBus();
    const received: HarnessEvent[] = [];
    bus.on((e) => received.push(e));
    meta.attach(bus);
    for (let i = 0; i < 6; i++) bus.emit(taskEnded("fail", `t${i}`));
    await meta.whenIdle();
    const errors = received.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(String((errors[0]?.data as { message?: string }).message)).toContain("boom");
    expect(String((errors[0]?.data as { component?: string }).component)).toBe("meta-layer");
    expect(meta.getStats().errors).toBe(1);
  });

  it("recovers when measure() throws once then succeeds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    let config = { repairRounds: 1, maxConcurrency: 4 };
    let calls = 0;
    const meta = new MetaLayer({
      store,
      engine: new HypothesisEngine({ minWindow: 5 }),
      config,
      evaluationInterval: 5,
      applyConfig: async (next) => {
        config = { ...next };
      },
      measure: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient failure");
        // Improves only when the proposal was applied (repairRounds = 2).
        if (config.repairRounds >= 2) return 0.9;
        return 0.5;
      },
    });
    const bus = new EventBus();
    meta.attach(bus);

    // Round 1: fails transiently -> error recorded, loop stays alive.
    for (let i = 0; i < 6; i++) bus.emit(taskEnded("fail", `t${i}`));
    await meta.whenIdle();
    const stats1 = meta.getStats();
    expect(stats1.errors).toBe(1);
    expect(config.repairRounds).toBe(1); // unchanged after the failure

    // Round 2: measure recovers -> full proposal->promote cycle still works.
    for (let i = 0; i < 6; i++) bus.emit(taskEnded("fail", `r2-${i}`));
    await meta.whenIdle();
    const stats2 = meta.getStats();
    expect(stats2.errors).toBe(1);
    expect(stats2.hypothesesProposed).toBeGreaterThanOrEqual(1);
    expect(stats2.promoted).toBeGreaterThanOrEqual(1);
    expect(config.repairRounds).toBe(2);
  });
});

function latestById(store: HypothesisStore): Map<string, import("../src/types").Hypothesis> {
  const map = new Map<string, import("../src/types").Hypothesis>();
  for (const h of store.all()) map.set(h.id, h);
  return map;
}
