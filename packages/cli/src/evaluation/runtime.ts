/**
 * packages/cli/src/evaluation/runtime.ts — the OBSERVE-ONLY evaluation seam.
 *
 * / Seam di valutazione OBSERVE-ONLY: accumula evidenze e costruisce record.
 *
 * Wiring contract mirrors decision/runtime.ts: observe() accumulates facts,
 * evaluate() folds them into an immutable EvaluationRecord WITHOUT draining
 * the buffer, and the optional sink is best-effort (try/catch) — a telemetry
 * failure can never break the caller. Nothing here ever throws.
 */

import { evaluateEvidence } from "./evaluate";
import { MAX_EVIDENCE, boundEvidence, boundEvidenceList, makeEvaluationId } from "./evidence";
import type { EvaluationRecord, EvidenceItem, ObserveEntry, Postcondition } from "./types";

/** Optional telemetry sink — best-effort by contract, never blocks. */
export type EvaluationSink = (record: EvaluationRecord) => void;

export interface EvaluationRuntimeOptions {
  runId: string;
  sink?: EvaluationSink;
}

export interface EvaluationRuntime {
  /** Accumulate one observed fact. Returns the bounded EvidenceItem stored. */
  observe(entry: ObserveEntry): EvidenceItem;
  /** Build the record from current facts (buffer is NOT drained). */
  evaluate(taskId?: string | null): EvaluationRecord | null;
  /** Clear the accumulated evidence (id counter stays monotonic). */
  reset(): void;
}

/**
 * Deterministically re-materialize Postconditions from observed
 * `postcondition_check` evidence: facts must carry name (string) + ok
 * (boolean|null); expected/observed travel inside facts when present.
 */
function extractPostconditions(items: EvidenceItem[]): Postcondition[] {
  const out: Postcondition[] = [];
  for (const item of items) {
    if (item.kind !== "postcondition_check") continue;
    const ok = item.facts.ok;
    const name = item.facts.name;
    if (typeof name !== "string" || !(typeof ok === "boolean" || ok === null)) continue;
    const expected = item.facts.expected;
    const observed = item.facts.observed;
    out.push({
      name,
      expected:
        typeof expected === "object" && expected !== null
          ? (expected as Record<string, unknown>)
          : {},
      observed:
        typeof observed === "object" && observed !== null
          ? (observed as Record<string, unknown>)
          : {},
      ok,
    });
  }
  return out;
}

export function createEvaluationRuntime(opts: EvaluationRuntimeOptions): EvaluationRuntime {
  let items: EvidenceItem[] = [];

  const emit = (record: EvaluationRecord): void => {
    try {
      opts.sink?.(record);
    } catch {
      // sink is best-effort by contract — a broken telemetry listener must
      // never propagate into the observed run (decision/runtime.ts pattern).
    }
  };

  return {
    observe(entry: ObserveEntry): EvidenceItem {
      try {
        const item = boundEvidence({
          id: makeEvaluationId(opts.runId),
          kind: entry.kind,
          at: new Date().toISOString(),
          source: entry.source,
          facts: entry.facts,
          ...(entry.claim !== undefined ? { claim: entry.claim } : {}),
        });
        items.push(item);
        // Keep the buffer itself bounded: newest facts win, oldest dropped.
        if (items.length > MAX_EVIDENCE) items = items.slice(items.length - MAX_EVIDENCE);
        return item;
      } catch (error) {
        // OBSERVE-ONLY guarantee: even a pathological entry cannot throw.
        try {
          const marker: EvidenceItem = {
            id: makeEvaluationId(opts.runId),
            kind: "tool_outcome",
            at: new Date().toISOString(),
            source: "report",
            facts: { observeError: error instanceof Error ? error.message : String(error) },
          };
          items.push(marker);
          return marker;
        } catch {
          return {
            id: `EV-${opts.runId}-untracked`,
            kind: "tool_outcome",
            at: new Date().toISOString(),
            source: "report",
            facts: {},
          };
        }
      }
    },

    evaluate(taskId: string | null = null): EvaluationRecord | null {
      try {
        const snapshot = boundEvidenceList(items);
        if (snapshot.length === 0) return null;
        const postconditions = extractPostconditions(snapshot);
        const result = evaluateEvidence(snapshot, postconditions);
        const record: EvaluationRecord = {
          id: makeEvaluationId(opts.runId),
          runId: opts.runId,
          taskId,
          verdict: result.verdict,
          score: result.score,
          confidence: result.confidence,
          postconditions,
          evidence: snapshot,
          createdAt: new Date().toISOString(),
          fallbackReason: null,
        };
        emit(record);
        return record;
      } catch (error) {
        // Degraded but still observable: a fallback record, never a throw.
        const record: EvaluationRecord = {
          id: makeEvaluationId(opts.runId),
          runId: opts.runId,
          taskId: taskId ?? null,
          verdict: "INSUFFICIENT",
          score: 0.5,
          confidence: null,
          postconditions: [],
          evidence: [],
          createdAt: new Date().toISOString(),
          fallbackReason: error instanceof Error ? error.message : String(error),
        };
        emit(record);
        return record;
      }
    },

    reset(): void {
      items = [];
    },
  };
}
