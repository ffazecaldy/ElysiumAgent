/**
 * Tests for the durable leaf-restore semantics of {@link Session}:
 * - id counter is the MAX over every parseable entry id (hand-edited logs),
 * - a bare "leaf:" meta marker restores leaf = null and survives a reload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "@elysium/core";
import { describe, expect, it } from "vitest";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-session-test-"));
  return path.join(dir, "session.jsonl");
}

function jsonLine(entry: {
  id: string;
  parentId: string | null;
  timestamp?: string;
  label: string;
}): string {
  return `${JSON.stringify({
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    data: { kind: "meta", label: entry.label },
  })}\n`;
}

describe("Session restore semantics", () => {
  it("computes the id counter as the MAX parseable id, so appends never collide", () => {
    const filePath = tmpFile();
    // Hand-edited log: last line is NOT the highest id.
    fs.writeFileSync(
      filePath,
      jsonLine({ id: "e000001", parentId: null, label: "first" }) +
        jsonLine({ id: "e000003", parentId: "e000001", label: "third" }),
      "utf-8",
    );

    const session = new Session({ filePath });
    const appended = session.appendUser("hello");

    expect(appended.id).toBe("e000004");

    // Discriminating order: the highest id is NOT the last line — the old
    // "counter = last line" behavior would wrongly produce e000002 here.
    const filePath2 = tmpFile();
    fs.writeFileSync(
      filePath2,
      jsonLine({ id: "e000003", parentId: null, label: "third" }) +
        jsonLine({ id: "e000001", parentId: null, label: "first" }),
      "utf-8",
    );
    const session2 = new Session({ filePath: filePath2 });
    expect(session2.appendUser("again").id).toBe("e000004");
  });

  it("keeps leaf = null across a reload after restore({ entryId: null })", () => {
    const filePath = tmpFile();
    const session = new Session({ filePath });
    session.appendUser("one");
    session.appendUser("two");
    expect(session.leafId()).not.toBeNull();

    session.restore({ entryId: null, entryCount: session.entries().length });
    expect(session.leafId()).toBeNull();

    // A reload must honor the persisted bare "leaf:" marker, not the last line.
    const reloaded = new Session({ filePath });
    expect(reloaded.leafId()).toBeNull();

    // The new append re-rooted the tree: its parent is the null leaf.
    const appended = reloaded.appendUser("after-null-restore");
    expect(appended.parentId).toBeNull();
  });
});
