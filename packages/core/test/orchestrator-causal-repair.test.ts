/**
 * Unit tests: causal repair loop with collapse detection.
 *
 * After each failed critic verdict the orchestrator classifies the gaps into
 * failure causes. When a round's causes are all a subset of the previous
 * round's causes (nothing new surfaced), the repair loop collapses: an `error`
 * event is emitted and no further re-spawn happens.
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

function makePlan(subtasks: SubagentTask[]): OrchestrationPlan {
  return { goal: "causal repair probe", maxDepth: 2, subtasks };
}

function makeTask(): SubagentTask {
  return { id: "task-causal", goal: "fix the thing" };
}

/** Counting spawn fake returning failed results with the given summaries. */
function makeSpawn(summaries: string[]): {
  spawn: SpawnFn;
  getCalls: () => number;
} {
  let calls = 0;
  const spawn: SpawnFn = (task: SubagentTask): Promise<SubagentResult> => {
    const summary = summaries[Math.min(calls, summaries.length - 1)] ?? "";
    calls += 1;
    return Promise.resolve({ taskId: task.id, status: "fail", summary, artifacts: [] });
  };
  return { spawn, getCalls: () => calls };
}

describe("Orchestrator causal repair loop", () => {
  it("(a) performs both repairs when causes differ between rounds", async () => {
    // Round 1: MISSING_DEPENDENCY ("cannot find module x"). Round 2:
    // ASSERTION_WEAKNESS ("assertion failed...") — a new cause, so no collapse:
    // both repairs run, then the repairRounds budget is exhausted.
    const gapTexts = ["cannot find module x", "assertion failed: expected 1 but got 2"];
    const { spawn, getCalls } = makeSpawn(gapTexts);
    let criticCalls = 0;
    const orchestrator = new Orchestrator({
      spawn,
      critic: () => {
        const gap = gapTexts[Math.min(criticCalls, gapTexts.length - 1)] ?? "";
        criticCalls += 1;
        return Promise.resolve({ passed: false, gaps: [gap] });
      },
      repairRounds: 2,
    });

    const report = await orchestrator.execute(makePlan([makeTask()]));

    expect(getCalls()).toBe(3); // 1 initial + 2 repairs
    expect(report.subtasks).toHaveLength(1);
    expect(report.allPassed).toBe(false);
    expect(report.subtasks[0]?.result.summary).toBe("assertion failed: expected 1 but got 2");
  });

  it("(b) collapses when the second round repeats the first round's cause", async () => {
    // Both rounds classify to MISSING_DEPENDENCY: the second round introduces
    // no new cause, so the loop collapses after the first repair — 2 spawns,
    // an `error` event mentioning the collapse, and no second repair.
    const gapText = "cannot find module x";
    const { spawn, getCalls } = makeSpawn([gapText, gapText, gapText]);
    const events: HarnessEvent[] = [];
    const orchestrator = new Orchestrator({
      spawn,
      critic: () => Promise.resolve({ passed: false, gaps: [gapText] }),
      repairRounds: 2,
      onEvent: (event) => events.push(event),
    });

    const report = await orchestrator.execute(makePlan([makeTask()]));

    expect(getCalls()).toBe(2); // 1 initial + 1 repair, collapse stops the rest
    expect(report.subtasks).toHaveLength(1);
    expect(report.allPassed).toBe(false);
    const collapseError = events.find(
      (event) =>
        event.type === "error" &&
        (event.data as { message?: string }).message?.includes("repair loop collapse"),
    );
    expect(collapseError).toBeDefined();
    expect((collapseError?.data as { message?: string }).message).toContain(
      "repair loop collapse: repeated causes [MISSING_DEPENDENCY]",
    );
  });

  it("(c) does not collapse when the critic passes on the first round", async () => {
    const { spawn, getCalls } = makeSpawn(["all good"]);
    const events: HarnessEvent[] = [];
    const passingSpawn: SpawnFn = (task) =>
      spawn(task).then((result) => ({ ...result, status: "pass" as const }));
    const orchestrator = new Orchestrator({
      spawn: passingSpawn,
      critic: () => Promise.resolve({ passed: true, gaps: [] }),
      repairRounds: 2,
      onEvent: (event) => events.push(event),
    });

    const report = await orchestrator.execute(makePlan([makeTask()]));

    expect(getCalls()).toBe(1); // initial spawn only
    expect(report.subtasks).toHaveLength(1);
    expect(report.allPassed).toBe(true);
    expect(report.subtasks[0]?.critic?.passed).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
});
