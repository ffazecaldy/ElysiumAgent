/**
 * Durable run state — crash-safe persistence for a swarm run on disk.
 *
 * A single JSON file (`elysium-run.json` in `dir`) records what a run was
 * doing when it last touched the file: current phase, checkpoint tag, and an
 * append-style log of operations with idempotency keys. The parent CLI wires
 * resume around it; this module only owns the on-disk contract.
 *
 * Every mutation is persisted with an ATOMIC tmp+rename write so a crash mid
 * save can never leave a partial file behind: readers always see either the
 * previous state or the new one, never torn JSON.
 *
 * No external dependencies; sync fs; `loadRunState` never throws.
 */

import fs from "node:fs";
import path from "node:path";

/** High-level lifecycle phase of a run. */
export type RunPhase = "PLANNING" | "EXECUTION" | "VERIFICATION" | "REVIEW" | "DONE";

/** Terminal/live status of the run as a whole. */
export type RunStatus = "RUNNING" | "INTERRUPTED" | "COMPLETED" | "FAILED";

/** One tracked operation in the run, keyed by a caller-chosen idempotency id. */
export interface OperationRecord {
  /** Stable idempotency key, unique per logical operation (e.g. "edit:src/a.ts"). */
  operationId: string;
  /** Coarse kind tag (e.g. "edit", "bash", "spawn"). */
  kind: string;
  /** PENDING until the operation is confirmed complete. */
  status: "PENDING" | "DONE";
  /** ISO timestamp of when the record was created. */
  at: string;
}

/** Full durable state of one run, persisted at `<dir>/elysium-run.json`. */
export interface RunState {
  runId: string;
  goal: string;
  status: RunStatus;
  phase: RunPhase;
  checkpointTag: string | null;
  attempt: number;
  lastEventAt: string;
  operations: OperationRecord[];
  updatedAt: string;
}

/** Returns the path of the run state file for a directory. */
function stateFile(dir: string): string {
  return path.join(dir, "elysium-run.json");
}

/** Current time as an ISO string. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Atomically persists `state` to `<dir>/elysium-run.json`.
 * Writes a uniquely named tmp sibling first, then renames it over the target —
 * rename is atomic on the same volume, so the target is never partial.
 */
function persist(dir: string, state: RunState): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile(dir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Tmp already gone — nothing extra to clean up.
    }
    throw error;
  }
}

/**
 * Creates a fresh run state for `runId`/`goal` and persists it.
 * Starts RUNNING in PLANNING, attempt 1, no checkpoint, empty operations.
 */
export function createRunState(dir: string, runId: string, goal: string): RunState {
  const now = nowIso();
  const state: RunState = {
    runId,
    goal,
    status: "RUNNING",
    phase: "PLANNING",
    checkpointTag: null,
    attempt: 1,
    lastEventAt: now,
    operations: [],
    updatedAt: now,
  };
  persist(dir, state);
  return state;
}

/**
 * Loads the run state from `<dir>/elysium-run.json`.
 * Returns `null` when the file is absent or unparseable (treated as no
 * durable state — the caller decides how to proceed).
 */
export function loadRunState(dir: string): RunState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile(dir), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunState>;
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.operations)) {
      return null;
    }
    return parsed as RunState;
  } catch {
    return null;
  }
}

/** Persists `state` as-is (mutating helpers below keep it in sync for you). */
export function saveRunState(dir: string, state: RunState): void {
  persist(dir, state);
}

/**
 * Moves the run to `phase`: mutates `state`, stamps `lastEventAt` and
 * `updatedAt`, persists, and returns the same (mutated) state object.
 */
export function markPhase(dir: string, state: RunState, phase: RunPhase): RunState {
  const now = nowIso();
  state.phase = phase;
  state.lastEventAt = now;
  state.updatedAt = now;
  persist(dir, state);
  return state;
}

/**
 * Records an operation by idempotency key.
 *
 * - Existing record with status DONE → returns it with `alreadyDone: true`
 *   and does NOT touch the store (safe to replay after a crash).
 * - Existing PENDING record with the same id → returned as-is, no duplicate.
 * - New id → appends a PENDING record, persists, `alreadyDone: false`.
 */
export function recordOperation(
  dir: string,
  state: RunState,
  operationId: string,
  kind: string,
): { op: OperationRecord; alreadyDone: boolean } {
  const existing = state.operations.find((op) => op.operationId === operationId);
  if (existing) {
    if (existing.status === "DONE") {
      return { op: existing, alreadyDone: true };
    }
    return { op: existing, alreadyDone: false };
  }
  const op: OperationRecord = {
    operationId,
    kind,
    status: "PENDING",
    at: nowIso(),
  };
  state.operations.push(op);
  state.lastEventAt = op.at;
  state.updatedAt = op.at;
  persist(dir, state);
  return { op, alreadyDone: false };
}

/**
 * Marks `operationId` DONE in `state` (no-op if unknown), stamps freshness,
 * persists and returns the mutated state.
 */
export function completeOperation(dir: string, state: RunState, operationId: string): RunState {
  const op = state.operations.find((o) => o.operationId === operationId);
  if (op) {
    op.status = "DONE";
  }
  const now = nowIso();
  state.lastEventAt = now;
  state.updatedAt = now;
  persist(dir, state);
  return state;
}

/**
 * Flags the run as INTERRUPTED (e.g. after catching a crash/signal),
 * persists and returns the mutated state.
 */
export function markInterrupted(dir: string, state: RunState): RunState {
  state.status = "INTERRUPTED";
  state.updatedAt = nowIso();
  persist(dir, state);
  return state;
}

/**
 * True when `state` claims RUNNING but `lastEventAt` is older than
 * `stalenessMs` (default 60s) relative to `now` — the classic signature of a
 * crashed run that never got to mark itself INTERRUPTED.
 * A non-RUNNING state is never stale.
 */
export function isStale(state: RunState, stalenessMs = 60_000, now = Date.now()): boolean {
  if (state.status !== "RUNNING") {
    return false;
  }
  const last = Date.parse(state.lastEventAt);
  if (Number.isNaN(last)) {
    return true;
  }
  return now - last > stalenessMs;
}

/** Operations still PENDING — the work a resumed run should retry. */
export function resumableOperations(state: RunState): OperationRecord[] {
  return state.operations.filter((op) => op.status === "PENDING");
}
