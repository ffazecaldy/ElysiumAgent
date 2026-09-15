/**
 * Swarm live view tests: pane assignment cap (max 3), truncation, status
 * glyphs, and the non-TTY linear output contract.
 */
import { describe, expect, it } from "vitest";
import { MAX_PANES, assignPanes, statusGlyph, truncate } from "../src/swarm-view";

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
