import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type OperationRecord,
  type RunState,
  loadRunState,
  markInterrupted,
} from "../src/run-state.js";
import {
  checkpointRun,
  finishRun,
  listResumableRuns,
  recordRunOperation,
  recordRunPhase,
  startRunRecord,
} from "../src/swarm-run-store.js";

describe("swarm-run-store", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-store-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("startRunRecord", () => {
    it("creates the run dir and persists a fresh RUNNING/PLANNING state", () => {
      const state = startRunRecord(root, "run-1", "build the thing");

      expect(state.runId).toBe("run-1");
      expect(state.goal).toBe("build the thing");
      expect(state.status).toBe("RUNNING");
      expect(state.phase).toBe("PLANNING");
      expect(state.attempt).toBe(1);
      expect(state.checkpointTag).toBeNull();
      expect(state.operations).toEqual([]);

      const dir = path.join(root, ".elysium", "runs", "run-1");
      const onDisk = loadRunState(dir);
      expect(onDisk).not.toBeNull();
      expect(onDisk?.runId).toBe("run-1");
      expect(onDisk?.status).toBe("RUNNING");
    });
  });

  describe("recordRunPhase", () => {
    it("moves the phase and persists the transition", () => {
      const state = startRunRecord(root, "run-2", "goal-2");
      const updated = recordRunPhase(root, state, "EXECUTION");

      expect(updated.phase).toBe("EXECUTION");
      const onDisk = loadRunState(path.join(root, ".elysium", "runs", "run-2"));
      expect(onDisk?.phase).toBe("EXECUTION");
    });
  });

  describe("recordRunOperation", () => {
    it("records a PENDING operation then is idempotent once DONE", () => {
      let state = startRunRecord(root, "run-3", "goal-3");

      const first = recordRunOperation(root, state, "edit:src/a.ts", "edit");
      expect(first.alreadyDone).toBe(false);
      expect(first.op.status).toBe("PENDING");
      expect(first.op.kind).toBe("edit");

      state = recordRunPhase(root, state, "EXECUTION");
      getOp(state, "edit:src/a.ts").status = "DONE";

      const replay = recordRunOperation(root, state, "edit:src/a.ts", "edit");
      expect(replay.alreadyDone).toBe(true);
      expect(replay.op.operationId).toBe("edit:src/a.ts");
      expect(state.operations).toHaveLength(1);

      const onDisk = loadRunState(path.join(root, ".elysium", "runs", "run-3"));
      expect(onDisk?.operations).toHaveLength(1);
    });

    it("returns a PENDING duplicate as-is without appending", () => {
      const state = startRunRecord(root, "run-3b", "goal-3b");
      const first = recordRunOperation(root, state, "bash:ls", "bash");
      const second = recordRunOperation(root, state, "bash:ls", "bash");
      expect(second.alreadyDone).toBe(false);
      expect(second.op.operationId).toBe(first.op.operationId);
      expect(state.operations).toHaveLength(1);
    });
  });

  describe("checkpointRun", () => {
    it("sets the checkpoint tag and persists it", () => {
      const state = startRunRecord(root, "run-4", "goal-4");
      const updated = checkpointRun(root, state, "ckpt-42");

      expect(updated.checkpointTag).toBe("ckpt-42");
      const onDisk = loadRunState(path.join(root, ".elysium", "runs", "run-4"));
      expect(onDisk?.checkpointTag).toBe("ckpt-42");
    });
  });

  describe("finishRun", () => {
    it("sets terminal status and the DONE phase, persisted", () => {
      const state = startRunRecord(root, "run-5", "goal-5");
      const finished = finishRun(root, state, "COMPLETED");

      expect(finished.status).toBe("COMPLETED");
      expect(finished.phase).toBe("DONE");

      const onDisk = loadRunState(path.join(root, ".elysium", "runs", "run-5"));
      expect(onDisk?.status).toBe("COMPLETED");
      expect(onDisk?.phase).toBe("DONE");

      const failed = startRunRecord(root, "run-6", "goal-6");
      const finishedFailed = finishRun(root, failed, "FAILED");
      expect(finishedFailed.status).toBe("FAILED");
      expect(finishedFailed.phase).toBe("DONE");
    });
  });

  describe("full roundtrip on disk", () => {
    it("start → phase → operation → checkpoint → finish persists every step", () => {
      let state: RunState = startRunRecord(root, "run-rt", "roundtrip goal");
      state = recordRunPhase(root, state, "EXECUTION");
      state = recordRunPhase(root, state, "VERIFICATION");

      const { op } = recordRunOperation(root, state, "edit:x.ts", "edit");
      expect(op.status).toBe("PENDING");
      state = checkpointRun(root, state, "ckpt-rt");
      state = finishRun(root, state, "COMPLETED");

      const dir = path.join(root, ".elysium", "runs", "run-rt");
      const onDisk = loadRunState(dir);
      expect(onDisk).toEqual(state);
      expect(onDisk?.status).toBe("COMPLETED");
      expect(onDisk?.phase).toBe("DONE");
      expect(onDisk?.checkpointTag).toBe("ckpt-rt");
      expect(onDisk?.operations).toHaveLength(1);
    });
  });

  describe("listResumableRuns", () => {
    it("sees only INTERRUPTED runs, not COMPLETED/FAILED or live ones", () => {
      const done = startRunRecord(root, "run-done", "g-done");
      finishRun(root, done, "COMPLETED");

      const failed = startRunRecord(root, "run-failed", "g-failed");
      finishRun(root, failed, "FAILED");

      startRunRecord(root, "run-live", "g-live"); // RUNNING + fresh → not resumable

      const interrupted = startRunRecord(root, "run-int", "g-int");
      recordRunOperation(root, interrupted, "edit:a.ts", "edit");
      recordRunOperation(root, interrupted, "bash:b", "bash");
      markInterrupted(path.join(root, ".elysium", "runs", "run-int"), interrupted);

      const plans = listResumableRuns(root);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.runId).toBe("run-int");
      expect(plans[0]?.goal).toBe("g-int");
      expect(plans[0]?.pendingOperations).toHaveLength(2);
      expect(plans[0]?.pendingOperations.map((o) => o.operationId)).toEqual([
        "edit:a.ts",
        "bash:b",
      ]);
    });

    it("sees a stale RUNNING run (crash signature) once past the staleness window", async () => {
      const stale = startRunRecord(root, "run-stale", "g-stale");
      // Age the run past the 60s staleness window without waiting.
      const dir = path.join(root, ".elysium", "runs", "run-stale");
      const aged: RunState = {
        ...stale,
        lastEventAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      };
      fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(aged), "utf-8");

      const plans = listResumableRuns(root);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.runId).toBe("run-stale");
      expect(plans[0]?.pendingOperations).toEqual([]);
    });

    it("skips corrupt state files without throwing", () => {
      const okDir = path.join(root, ".elysium", "runs", "run-ok");
      const okState = startRunRecord(root, "run-ok", "g-ok");
      recordRunOperation(root, okState, "op:1", "edit");
      markInterrupted(okDir, okState);
      const corruptDir = path.join(root, ".elysium", "runs", "run-corrupt");
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, "elysium-run.json"), "{not json", "utf-8");

      expect(() => listResumableRuns(root)).not.toThrow();
      const plans = listResumableRuns(root);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.runId).toBe("run-ok");
    });

    it("returns [] and never throws when no runs directory exists", () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-run-store-empty-"));
      try {
        expect(listResumableRuns(empty)).toEqual([]);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe("crash simulation", () => {
    it("start + PENDING op → markInterrupted → plan carries correct pendingOperations", () => {
      let state = startRunRecord(root, "run-crash", "crash goal");
      state = recordRunPhase(root, state, "EXECUTION");

      recordRunOperation(root, state, "edit:keep.ts", "edit");
      recordRunOperation(root, state, "spawn:agent-1", "spawn");
      // First op completed before the crash.
      getOp(state, "edit:keep.ts").status = "DONE";

      const dir = path.join(root, ".elysium", "runs", "run-crash");
      const crashed = markInterrupted(dir, state);
      expect(crashed.status).toBe("INTERRUPTED");

      // On-disk roundtrip after the simulated crash.
      const onDisk = loadRunState(dir);
      expect(onDisk?.status).toBe("INTERRUPTED");

      const plans = listResumableRuns(root);
      expect(plans).toHaveLength(1);
      const plan = plans[0];
      expect(plan?.runId).toBe("run-crash");
      expect(plan?.fromPhase).toBe("EXECUTION");
      expect(plan?.attempt).toBe(1);
      expect(plan?.pendingOperations).toHaveLength(1);
      expect(plan?.pendingOperations[0]?.operationId).toBe("spawn:agent-1");
      expect(plan?.pendingOperations[0]?.status).toBe("PENDING");
    });
  });

  /** Returns the operation with `operationId`, failing the test if missing. */
  function getOp(state: RunState, operationId: string): OperationRecord {
    const op = state.operations.find((o) => o.operationId === operationId);
    if (!op) {
      throw new Error(`operation "${operationId}" not found`);
    }
    return op;
  }
});
