/**
 * Meta-Layer closed loop: subscribe to the core event bus -> persist
 * telemetry -> periodically propose hypotheses -> apply under control ->
 * measure delta on held-out re-run -> promote only positive deltas.
 */
import type { EventBus, HarnessEvent } from "@elysium/core";
import type { HypothesisEngine, OrchestrationConfig } from "./hypotheses/engine";
import type { HypothesisStore } from "./store/hypothesis-store";
import type { TelemetryStore } from "./store/telemetry-store";
import type { Hypothesis } from "./types";

export interface MetaLayerOptions {
  store: TelemetryStore;
  engine: HypothesisEngine;
  config: OrchestrationConfig;
  applyConfig(next: OrchestrationConfig): Promise<void>;
  measure(metric: string): Promise<number>;
  evaluationInterval?: number;
  /** Optional persistence for hypothesis lifecycle (proposals + transitions). */
  hypothesisStore?: HypothesisStore;
}

export interface MetaLayerStats {
  persisted: number;
  hypothesesProposed: number;
  promoted: number;
  rejected: number;
  errors: number;
}

type Unsubscribe = () => void;

function isImprovement(metric: string, delta: number): boolean {
  return metric.endsWith("_ms") ? delta < 0 : delta > 0;
}

export class MetaLayer {
  private readonly store: TelemetryStore;
  private readonly hypothesisStore: HypothesisStore | null;
  private readonly engine: HypothesisEngine;
  private config: OrchestrationConfig;
  private readonly applyConfig: (next: OrchestrationConfig) => Promise<void>;
  private readonly measure: (metric: string) => Promise<number>;
  private readonly evaluationInterval: number;
  private readonly pending: HarnessEvent[] = [];
  private stats: MetaLayerStats = {
    persisted: 0,
    hypothesesProposed: 0,
    promoted: 0,
    rejected: 0,
    errors: 0,
  };
  private unsubscribe: Unsubscribe | null = null;
  private bus: EventBus | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: MetaLayerOptions) {
    this.store = options.store;
    this.hypothesisStore = options.hypothesisStore ?? null;
    this.engine = options.engine;
    this.config = { ...options.config };
    this.applyConfig = options.applyConfig;
    this.measure = options.measure;
    this.evaluationInterval = options.evaluationInterval ?? 20;
  }

  attach(bus: EventBus): Unsubscribe {
    this.bus = bus;
    this.detach();
    this.unsubscribe = bus.on((event: HarnessEvent) => {
      this.store.append(event);
      this.stats.persisted += 1;
      if (event.type === "task_ended") {
        this.pending.push(event);
        if (this.pending.length >= this.evaluationInterval) {
          this.enqueueEvaluation();
        }
      }
    });
    return this.unsubscribe;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async evaluateNow(): Promise<void> {
    this.enqueueEvaluation();
    await this.chain;
  }

  async whenIdle(): Promise<void> {
    await this.chain;
  }

  /** Enqueue a single evaluation into the serialized chain. Errors are caught. */
  private enqueueEvaluation(): void {
    this.chain = this.chain.then(
      () => this.runEvaluation(),
      (err: unknown) => {
        this.stats.errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[meta-layer] evaluation error: ${msg}\n`);
        this.emitErrorEvent(msg);
      },
    );
  }

  /** Emit an "error" HarnessEvent on the attached bus, if any. */
  private emitErrorEvent(message: string): void {
    if (!this.bus) return;
    const event: HarnessEvent = {
      type: "error",
      timestamp: new Date().toISOString(),
      runId: "meta-layer",
      data: { component: "meta-layer", message },
    };
    try {
      this.bus.emit(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[meta-layer] failed to emit error event: ${msg}\n`);
    }
  }

  private async runEvaluation(): Promise<void> {
    if (this.pending.length === 0) return;
    const events = this.pending.splice(0, this.pending.length);
    const proposed = this.engine.observe(events);
    this.stats.hypothesesProposed += proposed.length;
    for (const hyp of proposed) {
      this.hypothesisStore?.append(hyp);
      try {
        const before = await this.measure(hyp.observation.metric);
        const next = this.nextConfig(hyp);
        await this.applyConfig(next);
        this.engine.markApplied(hyp.id);
        this.hypothesisStore?.update({ ...hyp, status: "applied" });
        const after = await this.measure(hyp.observation.metric);
        const delta = after - before;
        if (isImprovement(hyp.observation.metric, delta)) {
          this.engine.markPromoted(hyp.id, delta);
          this.hypothesisStore?.update({ ...hyp, status: "promoted", delta });
          this.stats.promoted += 1;
          this.config = next;
        } else {
          await this.applyConfig({ ...this.config });
          this.engine.markRejected(hyp.id, delta);
          this.hypothesisStore?.update({ ...hyp, status: "rejected", delta });
          this.stats.rejected += 1;
        }
      } catch (err) {
        // Per-hypothesis failure: roll back, mark rejected, keep the loop alive
        // so later hypotheses in the same batch still run.
        await this.applyConfig({ ...this.config });
        this.engine.markRejected(hyp.id, null);
        this.hypothesisStore?.update({ ...hyp, status: "rejected", delta: null });
        throw err;
      }
    }
  }

  private nextConfig(hyp: Hypothesis): OrchestrationConfig {
    const next = { ...this.config };
    if (hyp.change.kind === "retry_policy" && typeof hyp.change.to.repairRounds === "number") {
      next.repairRounds = hyp.change.to.repairRounds as number;
    }
    if (hyp.change.kind === "max_concurrency" && typeof hyp.change.to.maxConcurrency === "number") {
      next.maxConcurrency = hyp.change.to.maxConcurrency as number;
    }
    return next;
  }

  currentConfig(): OrchestrationConfig {
    return { ...this.config };
  }

  getStats(): MetaLayerStats {
    return { ...this.stats };
  }
}
