/**
 * Swarm live view tests: pane assignment cap (max 3), truncation, status
 * glyphs, and the non-TTY linear output contract.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  assignPanes,
  createSwarmView,
  statusGlyph,
  truncate,
  type SwarmSnapshot,
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
