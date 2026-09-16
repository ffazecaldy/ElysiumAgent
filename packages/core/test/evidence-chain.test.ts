/**
 * Tests: evidence chain + orchestrator integration.
 *
 * Part 1 — EvidenceChain unit behavior: progressive ids per kind, byTask
 * filtering, chronological ordering. Part 2 — the orchestrator records
 * attempt/critic/task_ended entries for every subtask of a fake plan and
 * mirrors each entry as a `custom` bus event.
 */
import {
  type HarnessEvent,
  type OrchestrationPlan,
  Orchestrator,
  type SpawnFn,
  type SubagentResult,
  type SubagentTask,
} from "@elysium/core";
import { describe, expect, it } from "vitest";
import { EvidenceChain } from "../src/orchestration/evidence";

const RUN_ID = "TESTRUN";

function makeTask(id: string): SubagentTask {
  return { id, goal: `do ${id}` };
}

function makePlan(subtasks: SubagentTask[]): OrchestrationPlan {
  return { goal: "evidence probe", maxDepth: 2, subtasks };
}

describe("EvidenceChain", () => {
  it("assigns progressive ids per kind (V-1, V-2, R-1, C-1)", () => {
    const chain = new EvidenceChain(RUN_ID);
    const v1 = chain.add("critic", "t1", "critic one");
    const a1 = chain.add("attempt", "t1", "attempt one");
    const v2 = chain.add("critic", "t2", "critic two");
    const r1 = chain.add("gate", "t2", "gate one");
    const c1 = chain.add("checkpoint", "t1", "checkpoint one");
    const v3 = chain.add("critic", "t3", "critic three");

    expect(v1.id).toBe(`${RUN_ID}:V-1`);
    expect(a1.id).toBe(`${RUN_ID}:A-1`);
    expect(v2.id).toBe(`${RUN_ID}:V-2`);
    expect(r1.id).toBe(`${RUN_ID}:R-1`);
    expect(c1.id).toBe(`${RUN_ID}:C-1`);
    expect(v3.id).toBe(`${RUN_ID}:V-3`);

    // Full id shape is `<runId>:<PREFIX>-<n>` and every entry carries runId.
    for (const entry of chain.entries()) {
      expect(entry.id.startsWith(`${RUN_ID}:`)).toBe(true);
      expect(entry.runId).toBe(RUN_ID);
    }
    // Unknown-id entry data is optional.
    expect(chain.entries()[0]?.data).toBeUndefined();
  });

  it("byTask filters entries by taskId preserving order", () => {
    const chain = new EvidenceChain(RUN_ID);
    chain.add("attempt", "t1", "a-t1-1");
    chain.add("critic", "t2", "v-t2-1");
    chain.add("critic", "t1", "v-t1-2");
    chain.add("task_ended", "t1", "end-t1");

    const forT1 = chain.byTask("t1");
    expect(forT1.map((entry) => entry.summary)).toEqual(["a-t1-1", "v-t1-2", "end-t1"]);
    expect(forT1.every((entry) => entry.taskId === "t1")).toBe(true);
    expect(chain.byTask("missing")).toEqual([]);
  });

  it("entries() returns a copy in chronological insertion order; toJSON snapshots", () => {
    const chain = new EvidenceChain(RUN_ID);
    chain.add("attempt", "t1", "first");
    chain.add("critic", "t1", "second");
    chain.add("task_ended", "t1", "third");

    const snapshot = chain.entries();
    expect(snapshot.map((entry) => entry.summary)).toEqual(["first", "second", "third"]);
    // Mutating the returned copy must not affect the chain.
    snapshot.length = 0;
    expect(chain.entries()).toHaveLength(3);

    const json = chain.toJSON();
    expect(json.runId).toBe(RUN_ID);
    expect(json.entries).toHaveLength(3);
    expect(json.entries[0]?.kind).toBe("attempt");
    expect(json.entries[2]?.summary).toBe("third");
  });
});

describe("Orchestrator with evidence chain", () => {
  it("records attempt + critic + task_ended per task and emits custom evidence events", async () => {
    const chain = new EvidenceChain(RUN_ID);
    const events: HarnessEvent[] = [];
    const spawn: SpawnFn = (task: SubagentTask): Promise<SubagentResult> =>
      Promise.resolve({ taskId: task.id, status: "pass", summary: `did ${task.id}`, artifacts: [] });
    const orchestrator = new Orchestrator({
      spawn,
      critic: (task) => Promise.resolve({ passed: true, gaps: [] }),
      evidence: chain,
      onEvent: (event) => events.push(event),
    });

    const report = await orchestrator.execute(makePlan([makeTask("t1"), makeTask("t2")]));

    expect(report.allPassed).toBe(true);

    // Per task: exactly attempt + critic + task_ended, in that order.
    for (const taskId of ["t1", "t2"]) {
      const taskEntries = chain.byTask(taskId);
      expect(taskEntries.map((entry) => entry.kind)).toEqual([
        "attempt",
        "critic",
        "task_ended",
      ]);
      expect(taskEntries[0]?.summary).toContain("did");
      expect(taskEntries[1]?.summary).toContain("critic");
      expect(taskEntries[2]?.summary).toContain("task ended");
      // Progressive ids scoped to this run for each kind.
      expect(taskEntries[0]?.id).toMatch(/:A-\d+$/);
      expect(taskEntries[1]?.id).toMatch(/:V-\d+$/);
      expect(taskEntries[2]?.id).toMatch(/:T-\d+$/);
      // Every entry carries the run id.
      expect(taskEntries.every((entry) => entry.runId === RUN_ID)).toBe(true);
    }

    // Whole chain stays consultable and chronologically consistent.
    const all = chain.entries();
    expect(all).toHaveLength(6); // 3 kinds x 2 tasks
    expect(new Set(all.map((entry) => entry.id)).size).toBe(6);

    // Every entry is mirrored as a `custom` event with evidence payload.
    const customEvidence = events.filter(
      (event) =>
        event.type === "custom" &&
        (event.data as { evidenceId?: string }).evidenceId !== undefined,
    );
    expect(customEvidence).toHaveLength(6);
    for (const event of customEvidence) {
      const data = event.data as { evidenceId: string; kind: string; summary: string };
      expect(data.evidenceId.startsWith(`${RUN_ID}:`)).toBe(true);
      expect(["attempt", "critic", "task_ended"]).toContain(data.kind);
      expect(typeof data.summary).toBe("string");
      expect(all.some((entry) => entry.id === data.evidenceId)).toBe(true);
    }
    // One custom event per task carries the matching taskId.
    const t1End = customEvidence.find(
      (event) => event.taskId === "t1" && (event.data as { kind?: string }).kind === "task_ended",
    );
    expect(t1End).toBeDefined();
  });

  it("records attempts for each repair round when the critic fails then passes", async () => {
    const chain = new EvidenceChain(RUN_ID);
    let criticCalls = 0;
    const spawn: SpawnFn = (task: SubagentTask): Promise<SubagentResult> =>
      Promise.resolve({ taskId: task.id, status: "pass", summary: "work", artifacts: [] });
    const orchestrator = new Orchestrator({
      spawn,
      critic: () => {
        criticCalls += 1;
        return Promise.resolve(
          criticCalls === 1
            ? { passed: false, gaps: ["cannot find module x"] }
            : { passed: true, gaps: [] },
        );
      },
      repairRounds: 2,
      evidence: chain,
    });

    const report = await orchestrator.execute(makePlan([makeTask("task-ev")]));

    expect(report.allPassed).toBe(true);
    const taskEntries = chain.byTask("task-ev");
    expect(taskEntries.map((entry) => entry.kind)).toEqual([
      "attempt",
      "critic",
      "attempt",
      "critic",
      "task_ended",
    ]);
    // Two attempts and two critic verdicts, progressive within each kind.
    expect(taskEntries[0]?.id).toBe(`${RUN_ID}:A-1`);
    expect(taskEntries[1]?.id).toBe(`${RUN_ID}:V-1`);
    expect(taskEntries[2]?.id).toBe(`${RUN_ID}:A-2`);
    expect(taskEntries[3]?.id).toBe(`${RUN_ID}:V-2`);
    expect(taskEntries[4]?.id).toBe(`${RUN_ID}:T-1`);
    // Chronological order across kinds.
    const t0 = taskEntries[0]?.timestamp ?? "";
    const t1 = taskEntries[1]?.timestamp ?? "";
    const t3 = taskEntries[3]?.timestamp ?? "";
    const t4 = taskEntries[4]?.timestamp ?? "";
    expect(t0 <= t1).toBe(true);
    expect(t3 <= t4).toBe(true);
  });
});
