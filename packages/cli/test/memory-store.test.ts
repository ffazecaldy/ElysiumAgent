/**
 * Operator memory store tests: load from a missing file, add/load roundtrip,
 * the 50-entry cap (oldest discarded), clearing, and prompt-block rendering.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addMemoryEntry, clearMemory, loadMemory, memoryPromptBlock } from "../src/memory-store";

/** Creates a fresh temp project root per test. */
function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "elysium-mem-"));
}

describe("loadMemory", () => {
  it("returns [] when the project directory does not exist", () => {
    const missing = path.join(makeRoot(), "nope", "deeper");
    expect(loadMemory(missing)).toEqual([]);
  });

  it("returns [] when the memory file is absent but the root exists", () => {
    expect(loadMemory(makeRoot())).toEqual([]);
  });
});

describe("addMemoryEntry", () => {
  it("roundtrips entries through add + load", () => {
    const root = makeRoot();
    addMemoryEntry(root, "always run tests before commit");
    addMemoryEntry(root, "prefer pnpm over npm");
    expect(loadMemory(root)).toEqual(["always run tests before commit", "prefer pnpm over npm"]);
  });

  it("caps at 50 entries, discarding the oldest", () => {
    const root = makeRoot();
    for (let i = 1; i <= 55; i++) {
      addMemoryEntry(root, `entry ${i}`);
    }
    const entries = loadMemory(root);
    expect(entries).toHaveLength(50);
    // Oldest five ("entry 1".."entry 5") are discarded; chronological order kept.
    expect(entries.slice(0, 5)).toEqual(["entry 6", "entry 7", "entry 8", "entry 9", "entry 10"]);
    expect(entries.slice(-5)).toEqual(["entry 51", "entry 52", "entry 53", "entry 54", "entry 55"]);
  });
});

describe("clearMemory", () => {
  it("deletes the memory file so load returns []", () => {
    const root = makeRoot();
    addMemoryEntry(root, "temporary note");
    expect(loadMemory(root)).toHaveLength(1);
    clearMemory(root);
    expect(loadMemory(root)).toEqual([]);
  });

  it("does not throw when the file does not exist", () => {
    expect(() => clearMemory(makeRoot())).not.toThrow();
  });
});

describe("memoryPromptBlock", () => {
  it("returns an empty string for empty entries", () => {
    expect(memoryPromptBlock([])).toBe("");
  });

  it("renders a header and one bullet per entry", () => {
    const block = memoryPromptBlock(["first", "second"]);
    expect(block).toBe("\n\nMEMORY (operator notes — respect them):\n- first\n- second");
  });
});
