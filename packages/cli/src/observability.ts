/**
 * Observability helpers for run reporting: ASCII run timeline, failure
 * explanations, and artifact provenance records. Pure string formatting —
 * no I/O, never throws on malformed input.
 */

/** Result state of a single phase in a run. */
export type PhaseResult = "ok" | "fail" | "skip";

/** Timing + token accounting for one phase of a run. */
export interface PhaseStat {
  name: string;
  ms: number;
  tokens: number;
  result: PhaseResult;
}

/** Human-friendly duration: `3.2s` below a minute, decimal minutes above (`1.2m`). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

const RESULT_MARKS: Record<PhaseResult, string> = {
  ok: "✓",
  fail: "✗",
  skip: "○",
};

const RESULT_LABELS: Record<PhaseResult, string> = {
  ok: "ok",
  fail: "fail",
  skip: "skip",
};

/** Column widths for the timeline table. */
const COL = {
  name: 10,
  time: 8,
  tokens: 7,
  result: 6,
} as const;

function padEndCell(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padStartCell(value: string, width: number): string {
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

function renderRow(name: string, time: string, tokens: string, result: string): string {
  return [
    padEndCell(name, COL.name),
    padStartCell(time, COL.time),
    padStartCell(tokens, COL.tokens),
    padEndCell(result, COL.result),
  ].join(" | ");
}

function renderSeparator(): string {
  const widths = [COL.name, COL.time, COL.tokens, COL.result];
  const total = widths.reduce((acc, w) => acc + w, 0) + (widths.length - 1) * 3;
  return "-".repeat(total);
}

/**
 * Render an aligned ASCII table of run phases:
 * header row (PHASE/TIME/TOKENS/RESULT), separator, one row per phase with
 * ✓ (ok), ✗ (fail) or ○ (skip) in the RESULT column.
 */
export function renderRunTimeline(phases: PhaseStat[]): string {
  const header = renderRow("PHASE", "TIME", "TOKENS", "RESULT");
  const rows = phases.map((phase) =>
    renderRow(
      phase.name,
      formatDuration(phase.ms),
      String(Math.max(0, Math.round(phase.tokens))),
      `${RESULT_MARKS[phase.result]} ${RESULT_LABELS[phase.result]}`,
    ),
  );
  return [header, renderSeparator(), ...rows].join("\n");
}

/**
 * Explain a failed run: a fixed header, the failure cause, then one bullet
 * per detail. Returns an empty string when there are no details; never throws.
 */
export function whyFailed(cause: string, details: string[]): string {
  if (!Array.isArray(details) || details.length === 0) return "";
  const lines: string[] = ["WHY DID THIS RUN FAIL", "", `Cause: ${cause}`, ""];
  for (const detail of details) {
    lines.push(`- ${detail}`);
  }
  return lines.join("\n");
}

/** Provenance record of a produced artifact. */
export interface ArtifactProvenance {
  artifactId: string;
  taskId: string;
  attempt: number;
  /** Source commit hash, or null when the artifact has no git origin. */
  commit: string | null;
  /** Verification id, or null when the artifact was never verified. */
  verifiedBy: string | null;
}

/**
 * Render a provenance block:
 *
 * ```
 * artifact: A-44
 * produced_by: T41 (attempt 3)
 * source commit: c1a82…
 * verified_by: V-88
 * ```
 *
 * Missing commit renders `source commit: (none)`; missing verification
 * renders `verified_by: (not verified)`.
 */
export function renderProvenance(p: ArtifactProvenance): string {
  const commit = p.commit === null || p.commit === "" ? "(none)" : p.commit;
  const verified = p.verifiedBy === null || p.verifiedBy === "" ? "(not verified)" : p.verifiedBy;
  return [
    `artifact: ${p.artifactId}`,
    `produced_by: ${p.taskId} (attempt ${p.attempt})`,
    `source commit: ${commit}`,
    `verified_by: ${verified}`,
  ].join("\n");
}
