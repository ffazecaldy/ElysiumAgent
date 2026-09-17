/**
 * Wave 5b — Deterministic Replay (su E9).
 *
 * Converte una sequenza di `ReplayStep` (rappresentazione neutra e
 * serializzabile di un run) nei `TrajectoryRecord` di E9 e ne calcola
 * il fingerprint, permettendo replay deterministici e confrontabili.
 *
 * Modulo puro: nessuna I/O. Dipende solo da `./fingerprint`.
 */

import {
  type FingerprintDelta,
  type TrajectoryFingerprint,
  type TrajectoryRecord,
  diffFingerprints,
  fingerprintTrajectory,
} from "./fingerprint";

export type ReplayTool = "read" | "edit" | "bash" | "test" | "other";

export interface ReplayStep {
  seq: number;
  tool: ReplayTool;
  input: Record<string, unknown>;
  result: {
    isError: boolean;
    outputTokens?: number;
    filesTouched?: string[];
  };
  at: string;
}

/**
 * Mappa ogni step sulla traiettoria E9:
 * - ogni step → un `tool_call` col suo tool (categoria già normalizzata);
 * - `result.isError` → record `error` dedicato (contato da fingerprintTrajectory);
 * - `result.outputTokens` → record `token_usage`;
 * - `result.filesTouched` → riflesso nel `tool_call`.
 */
export function stepsToTrajectory(steps: ReplayStep[]): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const step of steps) {
    // Nota: `fingerprintTrajectory` non considera `isError` sui `tool_call`
    // (solo `kind: "error"` / `tool_result` / `retry`), quindi l'errore di un
    // step deve viaggiare come record `error` dedicato per essere contato.
    if (step.result.isError) {
      records.push({ kind: "error" });
    }
    records.push({
      kind: "tool_call",
      tool: step.tool,
      ...(step.result.filesTouched !== undefined ? { filesTouched: step.result.filesTouched } : {}),
    });
    if (step.result.outputTokens !== undefined) {
      records.push({
        kind: "token_usage",
        outputTokens: step.result.outputTokens,
      });
    }
  }
  return records;
}

/**
 * Registrar che accumula `ReplayStep` con sequenza progressiva e timestamp ISO.
 */
export class TrajectoryRecorder {
  // Nota: il campo privato NON può chiamarsi `steps` — con target ES2022
  // (useDefineForClassFields) l'omonimia col metodo `steps()` lo oscurerebbe.
  private recorded: ReplayStep[] = [];

  record(
    tool: ReplayTool,
    input: Record<string, unknown>,
    result: ReplayStep["result"],
  ): ReplayStep {
    const step: ReplayStep = {
      seq: this.recorded.length + 1,
      tool,
      input,
      result,
      at: new Date().toISOString(),
    };
    this.recorded.push(step);
    return step;
  }

  steps(): ReplayStep[] {
    // Copia dell'array con copia superficiale di ogni step: le mutazioni
    // sulla copia non filtrano nello stato interno del recorder.
    return this.recorded.map((step) => ({ ...step }));
  }
}

/**
 * Fingerprint deterministico di un set di step: stepsToTrajectory + fingerprintTrajectory.
 */
export function replayFingerprint(steps: ReplayStep[]): TrajectoryFingerprint {
  return fingerprintTrajectory(stepsToTrajectory(steps));
}

/**
 * Confronta il replay degli step con un fingerprint atteso.
 * `match` è true solo se non ci sono delta.
 */
export function replayAgainst(
  steps: ReplayStep[],
  expected: TrajectoryFingerprint,
): { match: boolean; deltas: FingerprintDelta[] } {
  const actual = replayFingerprint(steps);
  const deltas = diffFingerprints(expected, actual);
  return { match: deltas.length === 0, deltas };
}
