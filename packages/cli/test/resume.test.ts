import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUNS_DIR,
  type ResumePlan,
  applyResume,
  findInterruptedRuns,
  planResume,
  runDir,
} from "../src/resume.js";
import {
  completeOperation,
  createRunState,
  markInterrupted,
  markPhase,
  recordOperation,
} from "../src/run-state.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-resume-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Creates a run directory with fresh RUNNING state, like `swarm start` will. */
function startRun(runId: string, goal = "do the thing"): string {
  const dir = runDir(root, runId);
  createRunState(dir, runId, goal);
  return dir;
}

describe("runDir / RUNS_DIR", () => {
  it("joins root, RUNS_DIR and runId", () => {
    expect(RUNS_DIR).toBe(".elysium/runs");
    const p = runDir(root, "r1");
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(path.join(".elysium", "runs", "r1"))).toBe(true);
  });
});

describe("findInterruptedRuns", () => {
  it("sees a RUNNING-but-stale run (crashed without marking INTERRUPTED)", () => {
    const dir = startRun("crashed");
    const state = createRunState(dir, "crashed", "goal");
    // Simulate staleness: rewind lastEventAt far into the past.
    state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(state), "utf-8");

    const runs = findInterruptedRuns(root);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("crashed");
    expect(runs[0]?.status).toBe("RUNNING");
  });

  it("sees an explicitly INTERRUPTED run even when fresh", () => {
    const dir = startRun("flagged");
    const state = markInterrupted(dir, createRunState(dir, "flagged", "goal"));
    const runs = findInterruptedRuns(root);
    expect(runs.map((r) => r.runId)).toContain("flagged");
    expect(state.status).toBe("INTERRUPTED");
  });

  it("ignores COMPLETED and fresh RUNNING runs", () => {
    const doneDir = startRun("finished");
    const done = createRunState(doneDir, "finished", "goal");
    done.status = "COMPLETED";
    fs.writeFileSync(path.join(doneDir, "elysium-run.json"), JSON.stringify(done), "utf-8");

    startRun("live"); // fresh RUNNING, not stale

    expect(findInterruptedRuns(root).map((r) => r.runId)).toEqual([]);
  });

  it("skips corrupt state files and missing runs dir without throwing", () => {
    startRun("broken");
    fs.writeFileSync(path.join(runDir(root, "broken"), "elysium-run.json"), "{not json", "utf-8");
    fs.writeFileSync(path.join(root, RUNS_DIR, "notes.txt"), "not a dir", "utf-8");

    expect(() => findInterruptedRuns(root)).not.toThrow();
    expect(findInterruptedRuns(root)).toEqual([]);
    // Fully missing runs directory is fine too.
    expect(findInterruptedRuns(fs.mkdtempSync(path.join(os.tmpdir(), "elysium-empty-")))).toEqual(
      [],
    );
  });
});

describe("planResume", () => {
  it("returns null for an unknown run", () => {
    expect(planResume(root, "nope")).toBeNull();
  });

  it("returns null for a COMPLETED run", () => {
    const dir = startRun("done");
    const state = createRunState(dir, "done", "goal");
    state.status = "COMPLETED";
    fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(state), "utf-8");
    expect(planResume(root, "done")).toBeNull();
  });

  it("plans from checkpoint + PENDING operations and reconciles stale RUNNING", () => {
    const dir = startRun("planned");
    const state = createRunState(dir, "planned", "build tower");
    recordOperation(dir, state, "edit:src/a.ts", "edit");
    recordOperation(dir, state, "bash:test", "bash");
    markPhase(dir, state, "EXECUTION");
    state.checkpointTag = "ckpt-42";
    // Crash before completing anything: rewind clock to force staleness.
    state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(state), "utf-8");

    const plan: ResumePlan | null = planResume(root, "planned");
    expect(plan).not.toBeNull();
    expect(plan?.runId).toBe("planned");
    expect(plan?.goal).toBe("build tower");
    expect(plan?.fromPhase).toBe("EXECUTION");
    expect(plan?.checkpointTag).toBe("ckpt-42");
    expect(plan?.attempt).toBe(1);
    expect(plan?.pendingOperations.map((o) => o.operationId).sort()).toEqual([
      "bash:test",
      "edit:src/a.ts",
    ]);

    // Reconciliation side effect: stale RUNNING was marked INTERRUPTED on disk.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "elysium-run.json"), "utf-8")) as {
      status: string;
    };
    expect(onDisk.status).toBe("INTERRUPTED");
  });

  it("plans an explicitly INTERRUPTED run without touching a live RUNNING run", () => {
    const dir = startRun("halted");
    const halted = markInterrupted(dir, createRunState(dir, "halted", "goal"));
    expect(planResume(root, "halted")?.runId).toBe("halted");

    startRun("alive"); // fresh RUNNING → live, no plan
    expect(planResume(root, "alive")).toBeNull();
    expect(halted.status).toBe("INTERRUPTED");
  });
});

describe("applyResume", () => {
  it("full crash→resume roundtrip: RUNNING → stale → plan → resume", () => {
    const dir = startRun("roundtrip");
    const state = createRunState(dir, "roundtrip", "ship it");
    recordOperation(dir, state, "edit:a", "edit");
    recordOperation(dir, state, "edit:b", "edit");
    completeOperation(dir, state, "edit:a");
    markPhase(dir, state, "EXECUTION");
    state.checkpointTag = "ckpt-1";

    // --- crash: rewind lastEventAt so isStale fires ---
    state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(state), "utf-8");

    expect(findInterruptedRuns(root).map((r) => r.runId)).toEqual(["roundtrip"]);

    const plan = planResume(root, "roundtrip");
    expect(plan).not.toBeNull();
    // Idempotency: the DONE op is not pending again.
    expect(plan?.pendingOperations.map((o) => o.operationId)).toEqual(["edit:b"]);
    expect(plan?.attempt).toBe(1);

    const resumed = applyResume(root, plan as ResumePlan, { now: Date.now() });
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.attempt).toBe(2);
    expect(resumed.phase).toBe("EXECUTION");
    expect(resumed.checkpointTag).toBe("ckpt-1");
    // PENDING operations preserved on disk for the resumed run to retry.
    expect(resumed.operations.filter((o) => o.status === "PENDING").map((o) => o.operationId)) //
      .toEqual(["edit:b"]);
    // Persisted, and no longer reported as interrupted.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "elysium-run.json"), "utf-8"))).toMatchObject({
      status: "RUNNING",
      attempt: 2,
    });
    expect(findInterruptedRuns(root)).toEqual([]);
  });

  it("does not resurrect a stale run when resuming with fresh now", () => {
    const dir = startRun("stale-now");
    const state = createRunState(dir, "stale-now", "goal");
    state.lastEventAt = new Date(Date.now() - 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, "elysium-run.json"), JSON.stringify(state), "utf-8");

    const plan = planResume(root, "stale-now");
    expect(plan).not.toBeNull();

    const resumed = applyResume(root, plan as ResumePlan, { now: Date.now() });
    expect(resumed.status).toBe("RUNNING");
    // Freshness stamped from opts.now, so isStale no longer fires.
    expect(resumed.lastEventAt >= new Date(Date.now() - 60_000).toISOString()).toBe(true);
    expect(findInterruptedRuns(root)).toEqual([]);
  });
});
