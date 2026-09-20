/**
 * packages/cli/src/decision/fingerprint.ts — decision records.
 *
 * Every semantic consultation becomes an immutable record for telemetry /
 * evidence (E1/E9-ready: "why did the system ask for review?"). Records are
 * pure data — emission goes through the existing event/telemetry paths.
 */

import { createHash } from "node:crypto";
import type { DecisionMode, DecisionOutcome } from "./policy";
import type { DecisionEvaluation } from "./provider";

/** One consultable decision, ready for telemetry. */
export interface DecisionRecord {
  decisionId: string;
  runId: string;
  taskId: string | null;
  useCase:
    | "bash-gray-zone"
    | "critic-triage"
    | "evidence-strength"
    | "risk-refinement"
    | "failure-cause";
  provider: string;
  mode: DecisionMode;
  result: DecisionOutcome;
  /** What the semantic layer WOULD have decided (shadow mode only). */
  semantic: DecisionOutcome | null;
  /** Raw provider answers, when available. */
  answers: DecisionEvaluation["answers"];
  confidence: number | null;
  stateHash: string;
  latencyMs: number;
  fallbackReason: string | null;
  at: string;
}

const seenIds = new Set<string>();

/** Deterministic-ish unique id: run-scoped counter + state hash suffix. */
export function makeDecisionId(runId: string, stateHash: string, at: string): string {
  let n = 1;
  let id = `D-${runId}-${n}`;
  while (seenIds.has(id)) {
    n += 1;
    id = `D-${runId}-${n}`;
  }
  seenIds.add(id);
  return id;
}

/** Full decision id with state-hash + timestamp suffix. */
export function fullDecisionId(runId: string, stateHash: string, at: string): string {
  return `${makeDecisionId(runId, stateHash, at)}:${stateHash.slice(0, 6)}.${at}`;
}

/** Reset the id counter (tests). */
export function resetDecisionIds(): void {
  seenIds.clear();
}

export interface DecisionRecordInput {
  runId: string;
  taskId: string | null;
  useCase: DecisionRecord["useCase"];
  providerId: string;
  mode: DecisionMode;
  outcome: DecisionOutcome;
  semantic: DecisionOutcome | null;
  evaluation: DecisionEvaluation | null;
  state: Record<string, unknown>;
}

/** Build a DecisionRecord from an evaluation. Pure. */
export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const stateHash = createHash("sha256")
    .update(JSON.stringify(input.state))
    .digest("hex")
    .slice(0, 16);
  const at = new Date().toISOString();
  const confidences: number[] = [];
  if (input.evaluation?.ok) {
    for (const answer of Object.values(input.evaluation.answers)) {
      if (answer.kind === "choice" || answer.kind === "score") confidences.push(answer.confidence);
    }
  }
  return {
    decisionId: fullDecisionId(input.runId, stateHash, at),
    runId: input.runId,
    taskId: input.taskId,
    useCase: input.useCase,
    provider: input.evaluation?.ok ? input.providerId : input.providerId,
    mode: input.mode,
    result: input.outcome,
    semantic: input.semantic,
    answers: input.evaluation?.answers ?? {},
    confidence: confidences.length > 0 ? Math.min(...confidences) : null,
    stateHash,
    latencyMs: input.evaluation?.latencyMs ?? 0,
    fallbackReason:
      input.evaluation && !input.evaluation.ok
        ? (input.evaluation.fallbackReason ?? input.evaluation.errorClass ?? "unavailable")
        : null,
    at,
  };
}

/** HarnessEvent-shaped emission (type 'custom', same convention as evidence). */
export function decisionEvent(record: DecisionRecord): {
  type: "custom";
  data: Record<string, unknown>;
} {
  return {
    type: "custom",
    data: {
      evidenceId: record.decisionId,
      kind: "decision",
      useCase: record.useCase,
      provider: record.provider,
      mode: record.mode,
      verdict: record.result.verdict,
      source: record.result.source,
      semanticVerdict: record.semantic?.verdict ?? null,
      confidence: record.confidence,
      stateHash: record.stateHash,
      latencyMs: record.latencyMs,
      fallbackReason: record.fallbackReason,
      taskId: record.taskId,
      runId: record.runId,
      summary: `decision ${record.useCase} → ${record.result.verdict} (${record.result.source}${record.mode !== "enforce" ? `, mode=${record.mode}` : ""})`,
    },
  };
}
