/**
 * E9 — Trajectory Fingerprint.
 *
 * Modulo puro: nessuna I/O, nessuna dipendenza. Input neutro: la struttura
 * `TrajectoryRecord` è agnostica rispetto all'infrastruttura sottostante.
 */

export interface TrajectoryRecord {
  kind: "tool_call" | "tool_result" | "token_usage" | "retry" | "error";
  tool?: string;
  isError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  filesTouched?: string[];
}

export interface TrajectoryFingerprint {
  read: number;
  edit: number;
  bash: number;
  test: number;
  other: number;
  retries: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  filesTouched: number;
}

type ToolCategory = "read" | "edit" | "bash" | "test" | "other";

function classifyTool(tool: string): ToolCategory {
  switch (tool) {
    case "test":
      return "test";
    case "bash":
      return "bash";
    case "read":
    case "grep":
    case "glob":
      return "read";
    case "write":
    case "edit":
      return "edit";
    default:
      return "other";
  }
}

function emptyFingerprint(): TrajectoryFingerprint {
  return {
    read: 0,
    edit: 0,
    bash: 0,
    test: 0,
    other: 0,
    retries: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    filesTouched: 0,
  };
}

export function fingerprintTrajectory(records: TrajectoryRecord[]): TrajectoryFingerprint {
  const fp = emptyFingerprint();
  const files = new Set<string>();

  for (const record of records) {
    if (record.kind === "tool_call") {
      const tool = record.tool ?? "";
      fp[classifyTool(tool)] += 1;
    } else if (record.kind === "retry") {
      fp.retries += 1;
    } else if (record.kind === "error" || record.isError === true) {
      fp.errors += 1;
    }

    if (record.inputTokens !== undefined && Number.isFinite(record.inputTokens)) {
      fp.tokensIn += record.inputTokens;
    }
    if (record.outputTokens !== undefined && Number.isFinite(record.outputTokens)) {
      fp.tokensOut += record.outputTokens;
    }
    if (record.filesTouched !== undefined) {
      for (const file of record.filesTouched) {
        files.add(file);
      }
    }
  }

  fp.filesTouched = files.size;
  return fp;
}

export interface FingerprintDelta {
  field: keyof TrajectoryFingerprint;
  from: number;
  to: number;
  delta: number;
}

export function diffFingerprints(
  a: TrajectoryFingerprint,
  b: TrajectoryFingerprint,
): FingerprintDelta[] {
  const deltas: FingerprintDelta[] = [];
  const fields = Object.keys(emptyFingerprint()) as Array<keyof TrajectoryFingerprint>;
  for (const field of fields) {
    const from = a[field];
    const to = b[field];
    const delta = to - from;
    if (delta !== 0) {
      deltas.push({ field, from, to, delta });
    }
  }
  return deltas;
}

export function serializeFingerprint(f: TrajectoryFingerprint): string {
  const ordered = Object.keys(emptyFingerprint())
    .sort()
    .reduce<Record<string, number>>((acc, key) => {
      acc[key] = f[key as keyof TrajectoryFingerprint];
      return acc;
    }, {});
  return JSON.stringify(ordered);
}
