/**
 * Unit tests: Orchestrator `spawnTimeoutMs` option.
 *
 * A spawn that never settles must not hang the run: when the per-spawn budget
 * is exceeded, the orchestrator emits a task-scope `error` event and the
 * subtask report carries a failed result whose summary mentions the timeout.
 * The run itself resolves quickly and no rejection propagates.
 */
import {
  type HarnessEvent,
  type OrchestrationPlan,
  Orchestrator,
  type SubagentTask,
} from "@elysium/core";
import { describe, expect, it } from "vitest";

function makePlan(subtasks: SubagentTask[]): OrchestrationPlan {
  return { goal: "timeout probe", maxDepth: 2, subtasks };
}

describe("Orchestrator spawnTimeoutMs", () => {
  it("fails a never-settling spawn with a timeout summary, quickly", async () => {
    // Spawn that NEVER resolves (and never rejects).
    const spawn = (): Promise<never> => new Promise<never>(() => {});

    const events: HarnessEvent[] = [];
    const orchestrator = new Orchestrator({
      spawn,
      spawnTimeoutMs: 50,
      onEvent: (event) => events.push(event),
    });

    const startedAt = Date.now();
    const report = await orchestrator.execute(
      makePlan([{ id: "task-hang", goal: "never resolves" }]),
    );
    const elapsedMs = Date.now() - startedAt;

    // The run resolves quickly (bounded by the 50ms budget, not by the spawn).
    expect(elapsedMs).toBeLessThan(2000);
    expect(report.subtasks).toHaveLength(1);

    const subtask = report.subtasks[0];
    if (subtask === undefined) {
      throw new Error("missing subtask report");
    }
    expect(subtask.result.taskId).toBe("task-hang");
    expect(subtask.result.status).toBe("fail");
    expect(subtask.result.summary).toContain("timeout");
    expect(report.allPassed).toBe(false);
  });

  it("emits a task-scope error event on timeout", async () => {
    const spawn = (): Promise<never> => new Promise<never>(() => {});

    const events: HarnessEvent[] = [];
    const orchestrator = new Orchestrator({
      spawn,
      spawnTimeoutMs: 50,
      onEvent: (event) => events.push(event),
    });

    await orchestrator.execute(makePlan([{ id: "task-hang", goal: "never resolves" }]));

    const errorEvents = events.filter((event) => event.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const timeoutError = errorEvents.find((event) => {
      if (event.type !== "error") {
        return false;
      }
      const message = (event.data as { message?: unknown }).message;
      return typeof message === "string" && message.includes("timeout after");
    });
    expect(timeoutError).toBeDefined();
    const data = timeoutError?.data as { message: string; scope: string };
    expect(data.scope).toBe("task");
    expect(data.message).toContain("timeout after");
  });

  it("keeps spawns that settle within the budget unaffected", async () => {
    const spawn = async () => ({
      taskId: "task-quick",
      status: "pass" as const,
      summary: "done",
      artifacts: [],
    });

    const orchestrator = new Orchestrator({ spawn, spawnTimeoutMs: 5_000 });
    const report = await orchestrator.execute(makePlan([{ id: "task-quick", goal: "fast spawn" }]));

    expect(report.allPassed).toBe(true);
    const subtask = report.subtasks[0];
    if (subtask === undefined) {
      throw new Error("missing subtask report");
    }
    expect(subtask.result.status).toBe("pass");
    expect(subtask.result.summary).toBe("done");
  });

  it("defaults to timeout disabled (spawnTimeoutMs omitted)", async () => {
    let settled: (() => void) | undefined;
    const spawn = (): Promise<{
      taskId: string;
      status: "pass";
      summary: string;
      artifacts: never[];
    }> =>
      new Promise((resolve) => {
        settled = () =>
          resolve({ taskId: "task-slow", status: "pass", summary: "slow but fine", artifacts: [] });
      });

    const orchestrator = new Orchestrator({ spawn });
    const runPromise = orchestrator.execute(makePlan([{ id: "task-slow", goal: "slow spawn" }]));

    // No budget: even after well beyond any test budget the run must still be
    // waiting on the spawn, not on a timeout.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBeDefined();
    settled?.();

    const report = await runPromise;
    expect(report.allPassed).toBe(true);
  });
});
