/**
 * CLI-layer wiring: core EventBus -> @elysium/meta-layer closed loop, plus a
 * measure() backed by the @elysium/benchmarks runner on held-out scenarios.
 *
 * Adapted to the REAL package interfaces (source of truth: the sources):
 * - EventBus (@elysium/core) registers a single handler:
 *   `on(handler: EventHandler): () => void` (no per-type subscription);
 *   `MetaLayer.attach(bus)` consumes exactly that shape.
 * - BenchmarkRunner (@elysium/benchmarks) exposes
 *   `runAll(cases: BenchmarkCase[]): Promise<RunSummary>`; the meta-loop
 *   metric `first_pass_rate` maps to `RunSummary.firstPassRate` and
 *   `avg_task_latency_ms` maps to `RunSummary.avgLatencyMs`.
 * - MetaLayer (@elysium/meta-layer) already implements the controlled cycle
 *   propose -> apply -> measure -> gate -> promote/rollback (see loop.ts):
 *   improvement = delta > 0 for non-"_ms" metrics, delta < 0 for "_ms"
 *   metrics; a rejected/failed hypothesis triggers a config rollback via
 *   `applyConfig({ ...previousConfig })`.
 */

import type { BenchmarkCase } from "@elysium/benchmarks";
import type { EventBus, HarnessEvent } from "@elysium/core";
import { HypothesisEngine, MetaLayer } from "@elysium/meta-layer";
import type { HypothesisStore, OrchestrationConfig, TelemetryStore } from "@elysium/meta-layer";

/** Default knobs when the caller does not pass an initial config. */
const DEFAULT_CONFIG: OrchestrationConfig = { repairRounds: 1, maxConcurrency: 4 };

/** Metrics a benchmark run exposes to the meta-loop (RunSummary subset). */
export interface BenchmarkRunMetrics {
  firstPassRate: number;
  avgLatencyMs?: number;
}

/**
 * Minimal runner shape consumed by the wiring. The real
 * `BenchmarkRunner.runAll(cases): Promise<RunSummary>` satisfies it
 * (RunSummary carries firstPassRate + avgLatencyMs).
 */
export interface BenchmarkRunnerLike {
  runAll(cases?: BenchmarkCase[]): Promise<BenchmarkRunMetrics> | BenchmarkRunMetrics;
}

/**
 * Minimal bus shape consumed by `MetaLayer.attach` (real `EventBus` fits:
 * its `on(handler)` returns an unsubscribe function and `emit` is only used
 * on the error path).
 */
export interface EventBusLike {
  on(handler: (event: HarnessEvent) => void): unknown;
  emit?(event: HarnessEvent): void;
}

export interface WireMetaLoopOptions {
  /** Benchmark runner used by measure(); invoked on held-out scenarios. */
  benchmarkRunner: BenchmarkRunnerLike;
  /** Telemetry sink required by MetaLayer (append-only JSONL store). */
  store: TelemetryStore;
  /** Hypothesis engine; defaults to `new HypothesisEngine()`. */
  engine?: HypothesisEngine;
  /** Optional persistence for hypothesis lifecycle transitions. */
  hypothesisStore?: HypothesisStore;
  /** Initial orchestration config; defaults to repairRounds 1 / maxConcurrency 4. */
  config?: OrchestrationConfig;
  /** Applies a candidate config; defaults to a no-op. */
  applyConfig?(next: OrchestrationConfig): Promise<void>;
  /** Metric tracked by the long-lived loop; defaults to "first_pass_rate". */
  metric?: string;
  /** task_ended events per automatic evaluation; defaults to 20 (loop.ts). */
  evaluationInterval?: number;
}

/** wireMetaLoop's resolved options, re-exposed for controlled iterations. */
export interface ResolvedWireMetaLoopOptions {
  readonly benchmarkRunner: BenchmarkRunnerLike;
  readonly store: TelemetryStore;
  readonly engine: HypothesisEngine;
  readonly hypothesisStore: HypothesisStore | null;
  readonly metric: string;
  readonly evaluationInterval: number;
  /** Wrapped applyConfig: keeps the wiring's live config in sync. */
  applyConfig(next: OrchestrationConfig): Promise<void>;
}

export interface MetaLoopWiring {
  /** Subscribe the meta-layer to an EventBus-like bus (real EventBus fits). */
  attach(eventBus: unknown): void;
  /** Unsubscribe the long-lived loop from its current bus. */
  detach(): void;
  /**
   * Run the benchmark runner over held-out scenarios and return the
   * first_pass_rate metric.
   */
  measureCurrent(heldOutCases?: BenchmarkCase[]): Promise<number>;
  /**
   * General form of measureCurrent: maps the metric name onto the benchmark
   * summary ("*_ms" -> avgLatencyMs, otherwise firstPassRate).
   */
  measureMetric(metric: string, heldOutCases?: BenchmarkCase[]): Promise<number>;
  /** Force an evaluation of the long-lived loop and await its completion. */
  evaluateNow(): Promise<void>;
  /** Live config snapshot (updated by applyConfig, incl. rollbacks). */
  currentConfig(): OrchestrationConfig;
  /** The long-lived MetaLayer instance. */
  readonly layer: MetaLayer;
  /** Resolved dependencies, reused by runControlledIteration. */
  readonly options: ResolvedWireMetaLoopOptions;
}

export interface ControlledIterationOptions {
  /** Harness events (task_ended window) that seed the proposal phase. */
  events: HarnessEvent[];
  /** Config snapshot the iteration starts from; defaults to the live one. */
  config?: OrchestrationConfig;
  /** Override of the config applier for this iteration only. */
  applyConfig?(next: OrchestrationConfig): Promise<void>;
}

export interface ControlledIterationResult {
  promoted: boolean;
  delta: number | null;
}

/**
 * Wire the existing MetaLayer to a benchmark-backed measure() function.
 * The long-lived loop is created here but only listens once
 * `attach(eventBus)` is called.
 */
export function wireMetaLoop(opts: WireMetaLoopOptions): MetaLoopWiring {
  const engine = opts.engine ?? new HypothesisEngine();
  const hypothesisStore = opts.hypothesisStore ?? null;
  const metric = opts.metric ?? "first_pass_rate";
  const evaluationInterval = opts.evaluationInterval ?? 20;
  let currentConfig: OrchestrationConfig = { ...(opts.config ?? DEFAULT_CONFIG) };
  const userApplyConfig = opts.applyConfig ?? (async (): Promise<void> => undefined);

  const applyConfig = async (next: OrchestrationConfig): Promise<void> => {
    currentConfig = { ...next };
    await userApplyConfig(next);
  };

  const measureMetric = async (name: string, heldOutCases?: BenchmarkCase[]): Promise<number> => {
    const summary: BenchmarkRunMetrics = await opts.benchmarkRunner.runAll(heldOutCases);
    return name.endsWith("_ms") ? (summary.avgLatencyMs ?? 0) : summary.firstPassRate;
  };

  const layer = new MetaLayer({
    store: opts.store,
    engine,
    config: { ...currentConfig },
    applyConfig,
    measure: (name: string) => measureMetric(name),
    ...(hypothesisStore !== null ? { hypothesisStore } : {}),
    evaluationInterval,
  });

  return {
    attach(eventBus: unknown): void {
      layer.attach(eventBus as EventBus);
    },
    detach(): void {
      layer.detach();
    },
    async measureCurrent(heldOutCases?: BenchmarkCase[]): Promise<number> {
      return measureMetric(metric, heldOutCases);
    },
    measureMetric,
    evaluateNow: () => layer.evaluateNow(),
    currentConfig: (): OrchestrationConfig => ({ ...currentConfig }),
    layer,
    options: {
      benchmarkRunner: opts.benchmarkRunner,
      store: opts.store,
      engine,
      hypothesisStore,
      metric,
      evaluationInterval,
      applyConfig,
    },
  };
}

/**
 * One controlled iteration of the EXISTING meta-layer loop:
 * propose (engine.observe over `events`) -> apply candidate config ->
 * measure before/after on held-out re-runs -> gate -> promote or rollback.
 * A fresh MetaLayer instance drives the cycle so the long-lived bus loop is
 * left untouched; the engine/store/applyConfig come from the wiring.
 */
export async function runControlledIteration(
  wiring: MetaLoopWiring,
  iteration: ControlledIterationOptions,
): Promise<ControlledIterationResult> {
  const events = iteration.events;
  const taskEndedCount = events.filter((e) => e.type === "task_ended").length;
  if (taskEndedCount === 0) {
    return { promoted: false, delta: null };
  }

  const { engine, store, hypothesisStore } = wiring.options;
  const knownIds = new Set(engine.list().map((h) => h.id));

  const iterationLayer = new MetaLayer({
    store,
    engine,
    config: iteration.config ?? wiring.currentConfig(),
    applyConfig: iteration.applyConfig ?? wiring.options.applyConfig,
    measure: (name: string) => wiring.measureMetric(name),
    ...(hypothesisStore !== null ? { hypothesisStore } : {}),
    // One evaluation exactly when the whole window has been received.
    evaluationInterval: taskEndedCount,
  });

  let handler: ((event: HarnessEvent) => void) | null = null;
  const transientBus: EventBusLike = {
    on(h: (event: HarnessEvent) => void): () => void {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  const emitEvent = (event: HarnessEvent): void => {
    if (handler !== null) handler(event);
  };

  iterationLayer.attach(transientBus as unknown as EventBus);
  try {
    for (const event of events) {
      emitEvent(event);
    }
    await iterationLayer.evaluateNow();
  } finally {
    iterationLayer.detach();
  }

  const settled = engine
    .list()
    .filter((h) => !knownIds.has(h.id))
    .filter((h) => h.status === "promoted" || h.status === "rejected");
  const promoted = settled.find((h) => h.status === "promoted");
  if (promoted !== undefined) {
    return { promoted: true, delta: promoted.delta };
  }
  return { promoted: false, delta: settled[0]?.delta ?? null };
}
