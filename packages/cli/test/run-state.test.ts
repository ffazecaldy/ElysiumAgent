/**
 * Durable run state tests: roundtrip persistence, idempotent operation
 * recording, phase stamps, staleness detection, resume filtering, and the
 * atomic tmp+rename write guarantee (file always parses after save).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  completeOperation,
  createRunState,
  isStale,
  loadRunState,
  markInterrupted,
  markPhase,
  recordOperation,
  resumableOperations,
  saveRunState,
} from "../src/run-state";

/** Creates a fresh temp directory per test. */
function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "elysium-run-"));
}

/** Cleans up a temp directory created by makeRoot. */
function rmRoot(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates a temp root, runs `fn`, always cleans up. Returns fn's result. */
function withRoot<T>(fn: (root: string) => T): T {
  const root = makeRoot();
  try {
    return fn(root);
  } finally {
    rmRoot(root);
  }
}

describe("createRunState / loadRunState roundtrip", () => {
  it("roundtrips create → save → load", () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-1", "build the harness");
      expect(state.runId).toBe("run-1");
      expect(state.goal).toBe("build the harness");
      expect(state.status).toBe("RUNNING");
      expect(state.phase).toBe("PLANNING");
      expect(state.checkpointTag).toBeNull();
      expect(state.attempt).toBe(1);
      expect(state.operations).toEqual([]);

      // Mutate + save + reload from disk.
      state.checkpointTag = "ckpt-7";
      saveRunState(root, state);
      const loaded = loadRunState(root);
      expect(loaded).not.toBeNull();
      expect(loaded?.runId).toBe("run-1");
      expect(loaded?.checkpointTag).toBe("ckpt-7");
      expect(loaded?.phase).toBe("PLANNING");
    } finally {
      rmRoot(root);
    }
  });

  it("returns null on a directory without a state file", () => {
    withRoot((root) => expect(loadRunState(root)).toBeNull());
  });

  it("returns null when the parent directory does not exist", () => {
    withRoot((root) => {
      expect(loadRunState(path.join(root, "nope", "deeper"))).toBeNull();
    });
  });
});

describe("recordOperation idempotency", () => {
  it("recording the same operationId twice yields one record and alreadyDone on the second", () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-2", "goal");

      const first = recordOperation(root, state, "edit:src/a.ts", "edit");
      expect(first.alreadyDone).toBe(false);
      expect(first.op.status).toBe("PENDING");
      expect(state.operations).toHaveLength(1);

      const second = recordOperation(root, state, "edit:src/a.ts", "edit");
      expect(second.alreadyDone).toBe(false); // still PENDING, no duplicate
      expect(state.operations).toHaveLength(1);

      completeOperation(root, state, "edit:src/a.ts");

      const third = recordOperation(root, state, "edit:src/a.ts", "edit");
      expect(third.alreadyDone).toBe(true); // DONE → replay-safe skip
      expect(state.operations).toHaveLength(1); // never duplicated

      // And from a fresh load, idempotency survives persistence.
      const reloaded = loadRunState(root);
      expect(reloaded).not.toBeNull();
      const fourth = recordOperation(
        root,
        reloaded as NonNullable<typeof reloaded>,
        "edit:src/a.ts",
        "edit",
      );
      expect(fourth.alreadyDone).toBe(true);
      expect(reloaded?.operations).toHaveLength(1);
    } finally {
      rmRoot(root);
    }
  });
});

describe("markPhase", () => {
  it("updates phase, refreshes lastEventAt, and persists", async () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-3", "goal");
      const before = Date.parse(state.lastEventAt);

      // Let the clock move so lastEventAt strictly increases.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const updated = markPhase(root, state, "EXECUTION");

      expect(updated.phase).toBe("EXECUTION");
      expect(Date.parse(updated.lastEventAt)).toBeGreaterThan(before);
      expect(updated.updatedAt).toBe(updated.lastEventAt);

      const loaded = loadRunState(root);
      expect(loaded?.phase).toBe("EXECUTION");
      expect(Date.parse(loaded?.lastEventAt as string)).toBeGreaterThan(before);
    } finally {
      rmRoot(root);
    }
  });
});

describe("isStale", () => {
  it("flags an old RUNNING state as stale", () => {
    withRoot((root) => {
      const state = createRunState(root, "run-4", "goal");
      state.status = "RUNNING";
      state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
      expect(isStale(state)).toBe(true);
      expect(isStale(state, 15 * 60_000)).toBe(false);
      expect(isStale(state, 60_000, Date.now())).toBe(true);
    });
  });

  it("a fresh RUNNING state is not stale", () => {
    withRoot((root) => {
      expect(isStale(createRunState(root, "run-5", "goal"))).toBe(false);
    });
  });

  it("a non-RUNNING state is never stale", () => {
    withRoot((root) => {
      const state = createRunState(root, "run-6", "goal");
      state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
      state.status = "COMPLETED";
      expect(isStale(state)).toBe(false);
      state.status = "INTERRUPTED";
      expect(isStale(state)).toBe(false);
      state.status = "FAILED";
      expect(isStale(state)).toBe(false);
    });
  });
});

describe("resumableOperations", () => {
  it("returns only PENDING operations, filtering DONE", () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-7", "goal");
      recordOperation(root, state, "op-a", "edit");
      recordOperation(root, state, "op-b", "bash");
      recordOperation(root, state, "op-c", "edit");
      completeOperation(root, state, "op-a");
      completeOperation(root, state, "op-c");

      const pending = resumableOperations(state);
      expect(pending.map((op) => op.operationId)).toEqual(["op-b"]);
      expect(pending.every((op) => op.status === "PENDING")).toBe(true);

      completeOperation(root, state, "op-b");
      expect(resumableOperations(state)).toEqual([]);
    } finally {
      rmRoot(root);
    }
  });
});

describe("markInterrupted", () => {
  it("flags the run INTERRUPTED and persists the status", () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-8", "goal");
      recordOperation(root, state, "op-x", "edit");
      const interrupted = markInterrupted(root, state);
      expect(interrupted.status).toBe("INTERRUPTED");
      expect(loadRunState(root)?.status).toBe("INTERRUPTED");
    } finally {
      rmRoot(root);
    }
  });
});

describe("atomic write", () => {
  it("leaves a fully parseable JSON file after every save (no partial writes)", () => {
    const root = makeRoot();
    try {
      const state = createRunState(root, "run-9", "goal");
      for (let i = 0; i < 25; i++) {
        recordOperation(root, state, `op-${i}`, "edit");
        completeOperation(root, state, `op-${i}`);
      }
      const raw = fs.readFileSync(path.join(root, "elysium-run.json"), "utf-8");
      const parsed = JSON.parse(raw) as { operations: unknown[] };
      expect(parsed.operations).toHaveLength(25);

      // No tmp leftovers from the tmp+rename dance.
      const leftovers = fs.readdirSync(root).filter((f) => f.startsWith("elysium-run.json.tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      rmRoot(root);
    }
  });
});
