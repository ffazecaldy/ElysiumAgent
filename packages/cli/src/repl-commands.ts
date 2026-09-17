/**
 * REPL command handlers — pure, testable implementations of the `/resume`,
 * `/replay` and run-report boxing commands.
 *
 * Self-contained layer: no I/O beyond what `resume.ts` already owns, no ANSI
 * escapes, no `process.exit`. `bin/agent.ts` (future wiring) will call these
 * with raw REPL input and print `message` verbatim.
 *
 * Contract:
 * - `handleResumeCommand` — without an argument lists resumable runs; with a
 *   run id builds and applies a resume plan (attempt + 1 on disk).
 * - `handleReplayCommand` — trajectory replay over a generic event stream
 *   (impronte comportamentali, NON exact replay degli output); malformed
 *   expected-JSON degrades to `ok: false`, never throws.
 * - `formatRunReportMessage` — light boxing for REPL output.
 */

import { type TrajectoryReplayResult, replayTrajectory } from "./replay-session.js";
import { type ResumePlan, applyResume, findInterruptedRuns, planResume } from "./resume.js";
import type { RunState } from "./run-state.js";

/** Fingerprint shape, derived so this module needs no direct meta-layer dep. */
type TrajectoryFingerprint = TrajectoryReplayResult["fingerprint"];
type FingerprintDelta = TrajectoryReplayResult["deltas"][number];

/** Fields every valid fingerprint must carry (mirrors E9's TrajectoryFingerprint). */
const FINGERPRINT_FIELDS: readonly string[] = [
  "read",
  "edit",
  "bash",
  "test",
  "other",
  "retries",
  "errors",
  "tokensIn",
  "tokensOut",
  "filesTouched",
];

/** Result of the `/resume` command: a printable message plus its artifacts. */
export interface ResumeCommandResult {
  ok: boolean;
  message: string;
  /** The resume plan that was applied, when a run id was given and found. */
  plan: ResumePlan | null;
  /** The on-disk state after `applyResume`, when a run id was given and found. */
  state: RunState | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `/resume` handler.
 *
 * - No argument (undefined or blank): lists every resumable run, one line per
 *   run: `run <id> · <goal> · attempt N · checkpoint <tag|none>`. `ok` stays
 *   true when there is simply nothing to resume.
 * - With a run id: `planResume` + `applyResume`; message is
 *   `resumed <id> da <fromPhase> (attempt N, M operations pending)` where N is
 *   the post-resume attempt. Unknown / not-resumable run → `ok: false`.
 * - Never throws: unexpected failures degrade to `ok: false` with a message.
 */
export function handleResumeCommand(root: string, arg: string | undefined): ResumeCommandResult {
  const runId = typeof arg === "string" ? arg.trim() : "";

  if (runId === "") {
    const runs = findInterruptedRuns(root);
    if (runs.length === 0) {
      return { ok: true, message: "no interrupted runs to resume", plan: null, state: null };
    }
    const lines: string[] = ["interrupted runs:"];
    for (const run of runs) {
      const goal = run.goal ?? "(no goal)";
      const attempt = run.attempt ?? 0;
      const checkpoint = run.checkpointTag ?? "none";
      lines.push(`run ${run.runId} · ${goal} · attempt ${attempt} · checkpoint ${checkpoint}`);
    }
    return { ok: true, message: lines.join("\n"), plan: null, state: null };
  }

  try {
    const plan = planResume(root, runId);
    if (plan === null) {
      return {
        ok: false,
        message: `run "${runId}" not found or not resumable`,
        plan: null,
        state: null,
      };
    }
    const state = applyResume(root, plan);
    const message = `resumed ${plan.runId} da ${plan.fromPhase} (attempt ${state.attempt}, ${plan.pendingOperations.length} operations pending)`;
    return { ok: true, message, plan, state };
  } catch (error) {
    return {
      ok: false,
      message: `resume failed: ${errorText(error)}`,
      plan: null,
      state: null,
    };
  }
}

/** Parses and shape-checks an expected fingerprint; `null` when unusable. */
function asFingerprint(value: unknown): TrajectoryFingerprint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const field of FINGERPRINT_FIELDS) {
    const item = record[field];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
  }
  return record as unknown as TrajectoryFingerprint;
}

/**
 * `/replay` handler — TRAJECTORY REPLAY (impronte, non exact replay).
 *
 * Runs `replayTrajectory` over the event stream and renders a multiline
 * message: header, serialized fingerprint, `match: yes|no` and — when an
 * expected fingerprint is supplied and differs — one line per delta.
 *
 * `expectedFingerprintJson` is optional; when given it must parse into a
 * fingerprint-shaped object. Malformed JSON (or wrong shape) → `ok: false`,
 * never a throw. A completed comparison with `match: no` is still `ok: true`
 * (the command worked; the trajectory diverged).
 */
export function handleReplayCommand(
  events: unknown[],
  expectedFingerprintJson?: string,
): { ok: boolean; message: string } {
  let expected: TrajectoryFingerprint | undefined;
  if (expectedFingerprintJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(expectedFingerprintJson);
    } catch (error) {
      return {
        ok: false,
        message: `invalid expected fingerprint JSON: ${errorText(error)}`,
      };
    }
    const fingerprint = asFingerprint(parsed);
    if (fingerprint === null) {
      return {
        ok: false,
        message: "invalid expected fingerprint JSON: not a trajectory fingerprint object",
      };
    }
    expected = fingerprint;
  }

  const result = replayTrajectory(Array.isArray(events) ? events : [], expected);
  const lines: string[] = [
    "TRAJECTORY REPLAY (impronte, non exact replay)",
    `fingerprint: ${result.serialized}`,
    `match: ${result.match ? "yes" : "no"}`,
  ];
  const deltas: FingerprintDelta[] = result.deltas;
  for (const delta of deltas) {
    const sign = delta.delta > 0 ? "+" : "";
    lines.push(
      `  delta ${delta.field}: expected ${delta.from} → actual ${delta.to} (${sign}${delta.delta})`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}

/**
 * Boxes a run report for REPL display: `── run report ──` header, then every
 * line of `report` prefixed with two spaces. Empty report → header only.
 */
export function formatRunReportMessage(report: string): string {
  if (report.length === 0) {
    return "── run report ──";
  }
  const body = report
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `── run report ──\n${body}`;
}
