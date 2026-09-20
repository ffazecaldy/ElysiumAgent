/**
 * Swarm live view tests: pane assignment cap (max 3), truncation, status
 * glyphs, and the non-TTY linear output contract.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  type SwarmSnapshot,
  assignPanes,
  createSwarmView,
  statusGlyph,
  truncate,
} from "../src/swarm-view";

describe("assignPanes", () => {
  it("caps the panes at MAX_PANES even with many tasks", () => {
    const order = ["t1", "t2", "t3", "t4", "t5"];
    const status = new Map<string, "running" | "queued">([
      ["t1", "running"],
      ["t2", "running"],
      ["t3", "running"],
      ["t4", "queued"],
      ["t5", "queued"],
    ]);
    const panes = assignPanes(order, status);
    expect(panes).toHaveLength(MAX_PANES);
    expect(panes).toEqual(["t1", "t2", "t3"]);
  });

  it("prefers running tasks, then queued, then finished", () => {
    const order = ["q", "done", "run"];
    const status = new Map<string, "running" | "queued" | "pass">([
      ["q", "queued"],
      ["done", "pass"],
      ["run", "running"],
    ]);
    expect(assignPanes(order, status)).toEqual(["run", "q", "done"]);
  });

  it("recycles panes: a finished task frees the slot for the next queued", () => {
    const order = ["t1", "t2", "t3", "t4"];
    const status = new Map<string, "pass" | "running" | "queued">([
      ["t1", "pass"],
      ["t2", "pass"],
      ["t3", "running"],
      ["t4", "queued"],
    ]);
    const panes = assignPanes(order, status);
    expect(panes).toContain("t3");
    expect(panes).toContain("t4");
    expect(panes).toHaveLength(3);
  });

  it("returns an empty pane list with no tasks", () => {
    expect(assignPanes([], new Map())).toEqual([]);
  });
});

describe("truncate", () => {
  it("keeps short text untouched", () => {
    expect(truncate("hello world", 20)).toBe("hello world");
  });
  it("collapses whitespace and marks truncation", () => {
    const out = truncate("a  very\nlong   text here", 8);
    expect(out).toBe("a very…");
    expect(out.length).toBeLessThanOrEqual(8);
  });
});

describe("statusGlyph", () => {
  it("maps known statuses and falls back for unknown", () => {
    expect(statusGlyph("running")).toBeDefined();
    expect(statusGlyph("pass")).toBeDefined();
    // @ts-expect-error — runtime robustness for unknown statuses
    expect(statusGlyph("bogus")).toBeDefined();
  });
});

describe("snapshot", () => {
  it("reflects states, tools and elapsed after plan+start+tool+end", async () => {
    const view = createSwarmView();
    view.plan(
      "obiettivo di prova",
      [
        { id: "task-1", goal: "primo" },
        { id: "task-2", goal: "secondo" },
      ],
      "/tmp/ws",
    );

    // Before start: queued, no elapsed, no tools.
    let snap: SwarmSnapshot = view.snapshot();
    expect(snap.goal).toBe("obiettivo di prova");
    expect(snap.total).toBe(2);
    expect(snap.running).toBe(0);
    expect(snap.tasks[0]).toMatchObject({
      id: "task-1",
      status: "queued",
      tools: 0,
      attempts: 1,
      elapsedSec: 0,
      lastTool: "",
    });

    view.taskStarted("task-1");
    view.taskTool("task-1", "write", false);
    view.taskTool("task-1", "bash", false);
    await new Promise((r) => setTimeout(r, 1100)); // ensure elapsedSec >= 1

    snap = view.snapshot();
    expect(snap.running).toBe(1);
    const running = snap.tasks.find((t) => t.id === "task-1");
    expect(running).toMatchObject({ status: "running", tools: 2, lastTool: "bash" });
    expect(running?.elapsedSec).toBeGreaterThanOrEqual(1);

    view.taskEnded("task-1", "pass", 1500, 2);
    snap = view.snapshot();
    expect(snap.running).toBe(0);
    const ended = snap.tasks.find((t) => t.id === "task-1");
    expect(ended).toMatchObject({ status: "pass", tools: 2, attempts: 2, lastTool: "bash" });
    // endedAt freezes elapsed at durationMs → 1s (floor of 1500/1000).
    expect(ended?.elapsedSec).toBe(1);

    const queued = snap.tasks.find((t) => t.id === "task-2");
    expect(queued).toMatchObject({ status: "queued", elapsedSec: 0, lastTool: "" });

    // Plain data: no ANSI escape codes anywhere in the snapshot.
    expect(JSON.stringify(snap)).not.toContain("\\u001b");
  });
});

describe("taskEnded tokens", () => {
  it("stores tokensIn/tokensOut in the snapshot when the event carries them", () => {
    const view = createSwarmView();
    view.plan("obiettivo token", [{ id: "task-t", goal: "conta i token" }], "/tmp/ws");
    view.taskStarted("task-t");
    view.taskEnded("task-t", "pass", 900, 1, { inputTokens: 800, outputTokens: 400 });

    const snap: SwarmSnapshot = view.snapshot();
    const t = snap.tasks.find((x) => x.id === "task-t");
    expect(t?.status).toBe("pass");
    expect(t?.tokensIn).toBe(800);
    expect(t?.tokensOut).toBe(400);
    expect((t?.tokensIn ?? 0) + (t?.tokensOut ?? 0)).toBe(1200);
  });

  it("defaults tokens to 0 when taskEnded is called without them", () => {
    const view = createSwarmView();
    view.plan("obiettivo token", [{ id: "task-u", goal: "senza token" }], "/tmp/ws");
    view.taskStarted("task-u");
    view.taskEnded("task-u", "pass", 500, 1);
    const t = view.snapshot().tasks.find((x) => x.id === "task-u");
    expect(t?.tokensIn).toBe(0);
    expect(t?.tokensOut).toBe(0);
  });
});
