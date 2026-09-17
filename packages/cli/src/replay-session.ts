/**
 * Trajectory Replay — extract behavioral fingerprints from a generic event
 * stream and compare them against an expected fingerprint.
 *
 * ⚠️ QUESTO È TRAJECTORY REPLAY (impronte comportamentali), NON exact replay
 * degli output — gli output non vengono registrati né riverificati. The
 * fingerprint counts *what kind of actions* a run performed (tools used,
 * errors, token totals, files touched), never *what those actions produced*.
 *
 * Pure functions over plain data; no I/O. Malformed events are skipped, never
 * thrown: extraction always returns an array and `replayTrajectory` always
 * returns a complete result object.
 */

import {
  type FingerprintDelta,
  type ReplayStep,
  type ReplayTool,
  type TrajectoryFingerprint,
  replayAgainst,
  replayFingerprint,
  serializeFingerprint,
} from "@elysium/meta-layer";

const KNOWN_TOOLS: readonly string[] = ["read", "edit", "bash", "test", "other"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTool(value: unknown): ReplayTool {
  return typeof value === "string" && (KNOWN_TOOLS as readonly string[]).includes(value)
    ? (value as ReplayTool)
    : "other";
}

function asInputObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asOutputTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asFilesTouched(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.filter((file): file is string => typeof file === "string");
  return files.length > 0 ? files : undefined;
}

/**
 * Extract replay steps from a generic event stream.
 *
 * Recognized events: `{ type: "tool_call", name, tool, input, at?,
 * outputTokens?, filesTouched? }` and `{ type: "tool_result", name,
 * isError? }`. Everything else is ignored. `seq` is reassigned 1..n in
 * arrival order. `isError` comes from pairing each tool_call with the next
 * tool_result carrying the same `name` (default false); `outputTokens` and
 * `filesTouched` are picked up from optional fields on the tool_call.
 * Malformed events are skipped, never thrown.
 */
export function extractReplaySteps(events: unknown[]): ReplayStep[] {
  if (!Array.isArray(events)) return [];

  const steps: ReplayStep[] = [];
  // Name → index of the most recent tool_call still waiting for its
  // tool_result (pairing is strictly "next tool_result with the same name").
  const openCalls = new Map<string, number>();

  for (const raw of events) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (typeof type !== "string") continue;

    if (type === "tool_call") {
      const name = typeof raw.name === "string" ? raw.name : `call-${steps.length + 1}`;
      steps.push({
        seq: steps.length + 1,
        tool: asTool(raw.tool),
        input: asInputObject(raw.input),
        result: {
          isError: false,
          ...(asOutputTokens(raw.outputTokens) !== undefined
            ? { outputTokens: asOutputTokens(raw.outputTokens) }
            : {}),
          ...(asFilesTouched(raw.filesTouched) !== undefined
            ? { filesTouched: asFilesTouched(raw.filesTouched) }
            : {}),
        },
        at: typeof raw.at === "string" ? raw.at : "",
      });
      openCalls.set(name, steps.length - 1);
      continue;
    }

    if (type === "tool_result") {
      const name = typeof raw.name === "string" ? raw.name : undefined;
      if (name === undefined) continue;
      const index = openCalls.get(name);
      if (index === undefined) continue;
      const step = steps[index];
      if (step !== undefined) {
        step.result.isError = raw.isError === true;
      }
      openCalls.delete(name);
    }
  }

  return steps;
}

/** Result of a trajectory replay: fingerprint, its serialization and the match verdict. */
export interface TrajectoryReplayResult {
  fingerprint: TrajectoryFingerprint;
  serialized: string;
  match: boolean;
  deltas: FingerprintDelta[];
}

/**
 * Full trajectory replay over a generic event stream:
 * `extractReplaySteps` → `replayFingerprint` → `serializeFingerprint` →
 * `replayAgainst` (only when `expected` is provided; without it the replay
 * trivially matches with no deltas).
 *
 * ⚠️ QUESTO È TRAJECTORY REPLAY (impronte comportamentali), NON exact replay
 * degli output — gli output non vengono registrati né riverificati.
 */
export function replayTrajectory(
  events: unknown[],
  expected?: TrajectoryFingerprint,
): TrajectoryReplayResult {
  const steps = extractReplaySteps(events);
  const fingerprint = replayFingerprint(steps);
  const serialized = serializeFingerprint(fingerprint);
  if (expected === undefined) {
    return { fingerprint, serialized, match: true, deltas: [] };
  }
  const { match, deltas } = replayAgainst(steps, expected);
  return { fingerprint, serialized, match, deltas };
}
