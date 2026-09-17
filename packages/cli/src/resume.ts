/**
 * Resume module — discovery and relaunch planning for interrupted swarm runs.
 *
 * Self-contained layer on top of `run-state.ts`: finds crashed/interrupted
 * runs on disk, builds a resume plan (checkpoint + pending operations) and
 * reactivates a run with an incremented attempt counter.
 *
 * FUTURE WIRING (documented contract, not implemented here):
 * - `swarm start` will create each run directory under `.elysium/runs/` via
 *   `createRunState(runDir(root, runId), runId, goal)` before spawning agents.
 * - The `/resume <runId>` command in the REPL will call `planResume` and, on
 *   a non-null plan, `applyResume` to put the run back in RUNNING state.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type OperationRecord,
  type RunPhase,
  type RunState,
  isStale,
  loadRunState,
  resumableOperations,
  saveRunState,
} from "./run-state.js";

/** Root-relative directory containing one sub-directory per run. */
export const RUNS_DIR = ".elysium/runs";

/**
 * Absolute path of the run directory for `runId` under `root`.
 *
 * Future wiring: `swarm start` creates this directory (via `createRunState`)
 * before spawning agents; `/resume` reads it back.
 */
export function runDir(root: string, runId: string): string {
  return path.join(root, RUNS_DIR, runId);
}

/**
 * Finds all resumable runs under `root`.
 *
 * Scans every `elysium-run.json` in the immediate sub-directories of
 * `<root>/.elysium/runs/` and returns the states that
 * are either explicitly INTERRUPTED, or still RUNNING but stale (crashed
 * without a chance to mark themselves). COMPLETED/FAILED runs and corrupt or
 * unreadable state files are skipped — this never throws.
 *
 * Future wiring: the REPL `/resume` command (without arguments) will call
 * this to list candidate runs.
 */
export function findInterruptedRuns(root: string): RunState[] {
  const runsRoot = path.join(root, RUNS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: RunState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const state = loadRunState(path.join(runsRoot, entry.name));
    if (!state) {
      continue;
    }
    if (state.status === "INTERRUPTED" || isStale(state)) {
      found.push(state);
    }
  }
  return found;
}

/** Everything `/resume` needs to relaunch an interrupted run. */
export interface ResumePlan {
  /** Id of the run to resume. */
  runId: string;
  /** Original goal, carried over unchanged. */
  goal: string;
  /** Phase the run was in when it died — resume enters here. */
  fromPhase: RunPhase;
  /** Checkpoint tag recorded before the crash, if any. */
  checkpointTag: string | null;
  /** Operations still PENDING — the work to retry. */
  pendingOperations: OperationRecord[];
  /** Attempt counter as of the crash; `applyResume` will bump it. */
  attempt: number;
}

/**
 * Builds a resume plan for `runId`, or `null` when there is nothing to resume.
 *
 * Loads the durable state; a RUNNING-but-stale run is first marked
 * INTERRUPTED on disk (crash reconciliation). Returns `null` for an unknown
 * run, a corrupt state file, or a run already COMPLETED. INTERRUPTED, FAILED
 * and stale-RUNNING runs yield a plan built from `checkpointTag` and
 * `resumableOperations` (PENDING ops only — DONE ops never reappear).
 *
 * Future wiring: the REPL `/resume <runId>` command calls this, then
 * `applyResume` on a non-null plan.
 */
export function planResume(root: string, runId: string): ResumePlan | null {
  const dir = runDir(root, runId);
  const state = loadRunState(dir);
  if (!state) {
    return null;
  }
  if (state.status === "COMPLETED") {
    return null;
  }
  if (state.status === "RUNNING" && isStale(state)) {
    state.status = "INTERRUPTED";
    saveRunState(dir, state);
  }
  if (state.status === "RUNNING") {
    // Live run owned by another process — nothing to resume.
    return null;
  }
  return {
    runId: state.runId,
    goal: state.goal,
    fromPhase: state.phase,
    checkpointTag: state.checkpointTag,
    pendingOperations: resumableOperations(state),
    attempt: state.attempt,
  };
}

/**
 * Applies a resume plan: puts the run back in RUNNING state with
 * `attempt + 1`, persists atomically via `saveRunState`, and returns the
 * updated state. `opts.now` (epoch ms) overrides freshness stamping for
 * tests; phase/checkpoint/operations are carried over untouched so the
 * caller (future REPL `/resume` wiring) can re-enter at `fromPhase` and
 * replay only the PENDING operations from the plan.
 */
export function applyResume(root: string, plan: ResumePlan, opts: { now?: number } = {}): RunState {
  const dir = runDir(root, plan.runId);
  const state = loadRunState(dir);
  if (!state) {
    throw new Error(`cannot resume run "${plan.runId}": no durable state at ${dir}`);
  }
  const nowIsoString = new Date(opts.now ?? Date.now()).toISOString();
  state.status = "RUNNING";
  state.attempt = plan.attempt + 1;
  state.lastEventAt = nowIsoString;
  state.updatedAt = nowIsoString;
  saveRunState(dir, state);
  return state;
}
