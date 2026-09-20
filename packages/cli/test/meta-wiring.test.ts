/**
 * meta-wiring tests: EventBus handler-registration spy, benchmark-backed
 * measure(), and one controlled meta-layer iteration (promote / rollback).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@elysium/core";
import { HypothesisEngine, TelemetryStore } from "@elysium/meta-layer";
import type { OrchestrationConfig } from "@elysium/meta-layer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runControlledIteration, wireMetaLoop } from "../src/meta-wiring";

function makeTempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "elysium-meta-wiring-"));
}

function taskEnded(status: "pass" | "fail"): HarnessEvent {
  return {
    type: "task_ended",
    timestamp: new Date().toISOString(),
    runId: "run-wiring-test",
    data: { status },
  };
}

function failingWindow(): HarnessEvent[] {
  return Array.from({ length: 5 }, () => taskEnded("fail"));
}

/** Fake benchmark runner: returns queued firstPassRate values in order. */
function makeQueueRunner(values: number[]) {
  let cursor = 0;
  const runner = {
    runAll: vi.fn(async (_cases?: unknown[]) => {
      const index = Math.min(cursor, values.length - 1);
      cursor += 1;
      const value = values[index];
      return { firstPassRate: value ?? 0 };
    }),
  };
  return runner;
}

describe("wireMetaLoop", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("attach registers exactly one handler on the bus (spy)", () => {
    const on = vi.fn((_handler: unknown) => (): void => undefined);
    const wiring = wireMetaLoop({
      benchmarkRunner: makeQueueRunner([0.5]),
      store: new TelemetryStore({ filePath: path.join(root, "telemetry.jsonl") }),
    });

    wiring.attach({ on, emit: (): void => undefined });

    expect(on).toHaveBeenCalledTimes(1);
    expect(typeof on.mock.calls[0]?.[0]).toBe("function");
  });

  it("measureCurrent invokes the benchmark runner and returns first_pass_rate", async () => {
    const runner = makeQueueRunner([0.5]);
    const wiring = wireMetaLoop({
      benchmarkRunner: runner,
      store: new TelemetryStore({ filePath: path.join(root, "telemetry.jsonl") }),
    });

    await expect(wiring.measureCurrent()).resolves.toBe(0.5);
    expect(runner.runAll).toHaveBeenCalledTimes(1);
  });
});

describe("runControlledIteration", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeWiring(runner: ReturnType<typeof makeQueueRunner>, applied: OrchestrationConfig[]) {
    return wireMetaLoop({
      benchmarkRunner: runner,
      store: new TelemetryStore({ filePath: path.join(root, "telemetry.jsonl") }),
      engine: new HypothesisEngine(),
      config: { repairRounds: 1, maxConcurrency: 4 },
      applyConfig: async (next) => {
        applied.push({ ...next });
      },
    });
  }

  it("promotes a positive delta (first_pass_rate 0.5 -> 0.9)", async () => {
    const runner = makeQueueRunner([0.5, 0.9]);
    const applied: OrchestrationConfig[] = [];
    const wiring = makeWiring(runner, applied);

    const result = await runControlledIteration(wiring, {
      events: failingWindow(),
    });

    expect(result.promoted).toBe(true);
    expect(result.delta).not.toBeNull();
    expect(result.delta).toBeCloseTo(0.4, 10);
    // applyConfig was called with the candidate (repairRounds 2).
    expect(applied.some((c) => c.repairRounds === 2)).toBe(true);
    // The runner measured before and after the apply.
    expect(runner.runAll).toHaveBeenCalledTimes(2);
    // The hypothesis reached the promoted state in the shared engine.
    const promoted = wiring.options.engine.list().at(-1);
    expect(promoted?.status).toBe("promoted");
  });

  it("rejects and rolls back on a negative delta (first_pass_rate 0.5 -> 0.3)", async () => {
    const runner = makeQueueRunner([0.5, 0.3]);
    const applied: OrchestrationConfig[] = [];
    const wiring = makeWiring(runner, applied);

    const result = await runControlledIteration(wiring, {
      events: failingWindow(),
    });

    expect(result.promoted).toBe(false);
    expect(result.delta).not.toBeNull();
    expect(result.delta).toBeCloseTo(-0.2, 10);
    // Rollback: the last applied config restores the original knobs.
    expect(applied.length).toBe(2);
    expect(applied[1]?.repairRounds).toBe(1);
    expect(applied[1]?.maxConcurrency).toBe(4);
    expect(wiring.currentConfig().repairRounds).toBe(1);
    // The hypothesis was marked rejected with the measured delta.
    const rejected = wiring.options.engine.list().at(-1);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.delta).not.toBeNull();
    expect(rejected?.delta).toBeCloseTo(-0.2, 10);
  });
});
