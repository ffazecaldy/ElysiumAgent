/**
 * packages/cli/src/decision/runtime.ts — the live decision seam.
 *
 * Wires the Decision Layer into the runtime with hard guarantees:
 * - mode comes from config (default shadow when a key exists, never enforce)
 * - the provider is constructed lazily and never throws
 * - recordDecision() emits a decision fingerprint event on the runtime bus
 *   and is best-effort: telemetry failure NEVER blocks the historical path.
 */

import { decisionMode } from "../config";
import { buildDecisionRecord, decisionEvent, resetDecisionIds } from "./fingerprint";
import type { DecisionMode, DecisionOutcome } from "./policy";
import { type DecisionEvaluation, type DecisionProvider, NullDecisionProvider } from "./provider";
import { TypeSafeDecisionProvider } from "./typesafe";

export interface DecisionRuntime {
  provider: DecisionProvider;
  mode: DecisionMode;
  /** True when the semantic layer may be consulted (mode !== off + provider available). */
  active: boolean;
}

/** Build the runtime decision seam from the environment (pure-ish, once). */
export function initDecisionRuntime(env: NodeJS.ProcessEnv = process.env): DecisionRuntime {
  resetDecisionIds();
  const mode: DecisionMode = decisionMode();
  const key = env.TYPESAFE_API_KEY;
  const provider: DecisionProvider =
    typeof key === "string" && key.length > 0
      ? new TypeSafeDecisionProvider({ apiKey: key })
      : new NullDecisionProvider();
  return { provider, mode, active: mode !== "off" && provider.available() === true };
}

/** Shared runtime instance for REPL wiring (initialized at process start). */
let runtime: DecisionRuntime | null = null;

/** Process-wide singleton (REPL). Tests can reset with resetDecisionRuntime(). */
export function getDecisionRuntime(): DecisionRuntime {
  if (runtime === null) {
    runtime = initDecisionRuntime();
  }
  return runtime;
}

/** Tests / provider changes. */
export function resetDecisionRuntime(next?: DecisionRuntime): void {
  runtime = next ?? initDecisionRuntime();
}

export type RecordDecisionFn = (input: {
  runId: string;
  taskId: string | null;
  useCase:
    | "bash-gray-zone"
    | "critic-triage"
    | "evidence-strength"
    | "risk-refinement"
    | "failure-cause";
  providerId: string;
  mode: DecisionMode;
  outcome: DecisionOutcome;
  semantic: DecisionOutcome | null;
  evaluation: DecisionEvaluation | null;
  state: Record<string, unknown>;
}) => void;

/** No-op recorder when no event sink is wired (keeps call sites clean). */
let sink: ((event: { type: "custom"; data: Record<string, unknown> }) => void) | null = null;

/** Wire the telemetry sink (the REPL passes its eventBus emit). */
export function setDecisionSink(
  emit: ((event: { type: "custom"; data: Record<string, unknown> }) => void) | null,
): void {
  sink = emit;
}

/** Build a recorder bound to a run id (best-effort: never throws). */
export function makeDecisionRecorder(runId: string): RecordDecisionFn {
  return (input) => {
    try {
      const record = buildDecisionRecord({ ...input, runId });
      sink?.(decisionEvent(record));
    } catch {
      // telemetry is best-effort by contract
    }
  };
}

/** Convenience wrapper returning a recorder that resolves the run id lazily. */
export function makeLazyDecisionRecorder(runIdOf: () => string): RecordDecisionFn {
  return (input) => {
    try {
      const record = buildDecisionRecord({ ...input, runId: runIdOf() });
      sink?.(decisionEvent(record));
    } catch {
      // best-effort
    }
  };
}
