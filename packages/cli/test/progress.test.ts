/**
 * Progress file tests: init→read roundtrip, surgical section replacement
 * (only the requested section changes), double-update idempotency, null
 * reads on missing dirs, atomic persistence (no tmp leftovers), and the
 * capped inline rendering for resume prompts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROGRESS_FILE,
  initProgress,
  readProgress,
  renderProgressInline,
  updateProgressSection,
} from "../src/progress";

const dirs: string[] = [];

/** Creates a tracked temp dir, cleaned up after the test file. */
function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-prog-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Extracts a section's body from raw progress text. */
function section(raw: string, name: string): string {
  const match = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`, "").exec(raw);
  return match?.[1]?.trim() ?? "<missing>";
}

describe("initProgress / readProgress", () => {
  it("roundtrips init → read with all standard sections", () => {
    const dir = makeDir();
    const file = initProgress(dir, "fix the login flow");
    expect(file).toBe(path.join(dir, PROGRESS_FILE));
    expect(path.basename(file)).toBe("progress.md");

    const raw = readProgress(dir);
    expect(raw).not.toBeNull();
    expect(raw).toContain("## Goal");
    expect(raw).toContain("fix the login flow");
    for (const name of ["Completed", "Current", "Known failures", "Next", "Do not repeat"]) {
      expect(section(raw as string, name)).toBe("");
    }
  });

  it("readProgress returns null on an empty dir or missing parent", () => {
    expect(readProgress(makeDir())).toBeNull();
    expect(readProgress(path.join(makeDir(), "nope"))).toBeNull();
  });
});

describe("updateProgressSection", () => {
  it("replaces ONLY the requested section and preserves the others", () => {
    const dir = makeDir();
    initProgress(dir, "goal");
    updateProgressSection(dir, "Completed", "- step A\n- step B");
    updateProgressSection(dir, "Known failures", "- test X flaked");

    const raw = readProgress(dir) as string;
    expect(section(raw, "Completed")).toBe("- step A\n- step B");
    expect(section(raw, "Known failures")).toBe("- test X flaked");
    expect(section(raw, "Current")).toBe("");
    expect(section(raw, "Next")).toBe("");
    expect(section(raw, "Do not repeat")).toBe("");
    expect(section(raw, "Goal")).toBe("goal");

    // Updating a later section never corrupts an earlier one's body.
    updateProgressSection(dir, "Next", "- write tests");
    const raw2 = readProgress(dir) as string;
    expect(section(raw2, "Completed")).toBe("- step A\n- step B");
    expect(section(raw2, "Known failures")).toBe("- test X flaked");
    expect(section(raw2, "Next")).toBe("- write tests");
  });

  it("is idempotent under a double update of the same section", () => {
    const dir = makeDir();
    initProgress(dir, "goal");
    updateProgressSection(dir, "Current", "editing progress.ts");
    const once = readProgress(dir);
    updateProgressSection(dir, "Current", "editing progress.ts");
    expect(readProgress(dir)).toBe(once);

    // Replacing (not appending): the old body is gone, single occurrence.
    updateProgressSection(dir, "Current", "editing progress.test.ts");
    const raw = readProgress(dir) as string;
    expect(section(raw, "Current")).toBe("editing progress.test.ts");
    expect(raw.split("## Current")).toHaveLength(2);
  });

  it("creates the file via initProgress when missing, and writes atomically", () => {
    const dir = makeDir();
    updateProgressSection(dir, "Completed", "- bootstrapped");
    const raw = readProgress(dir) as string;
    expect(raw).toContain("## Goal"); // fresh init happened
    expect(section(raw, "Completed")).toBe("- bootstrapped");

    // No tmp leftovers from the tmp+rename dance.
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("renderProgressInline", () => {
  it("renders only non-empty sections and returns null with no file", () => {
    expect(renderProgressInline(makeDir())).toBeNull();

    const dir = makeDir();
    initProgress(dir, "ship it");
    updateProgressSection(dir, "Current", "mid-edit");
    const inline = renderProgressInline(dir) as string;
    expect(inline).toContain("Goal");
    expect(inline).toContain("ship it");
    expect(inline).toContain("Current");
    expect(inline).toContain("mid-edit");
    expect(inline).not.toContain("Known failures"); // empty section skipped
  });

  it("caps output at maxChars with a [truncated] note", () => {
    const dir = makeDir();
    initProgress(dir, "g");
    updateProgressSection(dir, "Completed", `- ${"y".repeat(400)}`);
    updateProgressSection(dir, "Next", `- ${"z".repeat(400)}`);
    const inline = renderProgressInline(dir, 300);
    expect(inline).not.toBeNull();
    expect(inline?.length).toBeLessThanOrEqual(300);
    expect(inline?.endsWith("[truncated]")).toBe(true);
  });
});
