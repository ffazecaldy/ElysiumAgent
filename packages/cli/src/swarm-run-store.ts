/**
 * Swarm run store — bridge between the swarm run loop and the durable run
 * state on disk.
 *
 * Thin, self-contained layer over `run-state.ts` (the on-disk contract) and
 * `resume.ts` (discovery/planning). Each function takes an explicit `root`
 * so the swarm loop never has to know where run directories live, and never
 * touches a state object without also persisting it.
 *
 * No external dependencies; sync fs.
 */

import fs from "node:fs";

import { type ResumePlan, findInterruptedRuns, planResume, runDir } from "./resume.js";
import {
  type OperationRecord,
  type RunPhase,
  type RunState,
  createRunState,
  markPhase,
  recordOperation,
  saveRunState,
} from "./run-state.js";

/**
 * Starts a new durable run record: creates the run directory under
 * `<root>/.elysium/runs/<runId>/` (recursive, idempotent) and persists a
 * fresh RUNNING/PLANNING state via `createRunState`.
 */
export function startRunRecord(root: string, runId: string, goal: string): RunState {
  const dir = runDir(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  return createRunState(dir, runId, goal);
}

/**
 * Moves the run to `phase`, persisting the transition.
 * Thin wrapper over `markPhase` bound to the run directory.
 */
export function recordRunPhase(root: string, state: RunState, phase: RunPhase): RunState {
  return markPhase(runDir(root, state.runId), state, phase);
}

/**
 * Records an operation by idempotency key, persisting the store.
 * Idempotent: a record already DONE comes back with `alreadyDone: true` and
 * the store is untouched (safe to replay after a crash); a new id appends a
 * PENDING record with `alreadyDone: false`.
 */
export function recordRunOperation(
  root: string,
  state: RunState,
  operationId: string,
  kind: string,
): { op: OperationRecord; alreadyDone: boolean } {
  return recordOperation(runDir(root, state.runId), state, operationId, kind);
}

/**
 * Sets `state.checkpointTag` to `tag` and persists the state.
 */
export function checkpointRun(root: string, state: RunState, tag: string): RunState {
  state.checkpointTag = tag;
  saveRunState(runDir(root, state.runId), state);
  return state;
}

/**
 * Terminates the run with `status` (COMPLETED or FAILED): sets the DONE
 * phase, persists, and returns the mutated state.
 */
export function finishRun(root: string, state: RunState, status: "COMPLETED" | "FAILED"): RunState {
  state.status = status;
  const dir = runDir(root, state.runId);
  return markPhase(dir, state, "DONE");
}

/**
 * Lists resume plans for every resumable run under `root` — the ones
 * `findInterruptedRuns` sees (explicitly INTERRUPTED, or RUNNING but stale).
 * Never throws: a run whose plan cannot be built (corrupt state, already
 * completed…) is silently skipped.
 */
export function listResumableRuns(root: string): ResumePlan[] {
  const plans: ResumePlan[] = [];
  let states: RunState[];
  try {
    states = findInterruptedRuns(root);
  } catch {
    return plans;
  }
  for (const state of states) {
    try {
      const plan = planResume(root, state.runId);
      if (plan) {
        plans.push(plan);
      }
    } catch {
      // Corrupt/unreadable run — skip it rather than fail the listing.
    }
  }
  return plans;
}
