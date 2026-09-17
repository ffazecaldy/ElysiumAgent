import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type HarnessEvent,
  PathPolicyError,
  Session,
  ToolRegistry,
  type ToolResultMessage,
  createBashTool,
  createBuiltinTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  evaluateCommand,
  resolveWithin,
} from "@elysium/core";
import { describe, expect, it } from "vitest";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "elysium-test-"));
}

function makeCtx(cwd: string, events: HarnessEvent[] = []) {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: (e: HarnessEvent) => {
      events.push(e);
    },
  };
}

const policy = () => ({ allowedRoots: [] as string[] });

function rootPolicy(): { allowedRoots: string[] } {
  return { allowedRoots: [] };
}

function policyFor(root: string): { allowedRoots: string[] } {
  return { allowedRoots: [root] };
}

describe("path policy", () => {
  it("allows paths inside the root and rejects escapes", () => {
    const root = tmpDir();
    const p = policyFor(root);
    expect(resolveWithin(root, p, "sub/file.txt")).toBe(path.resolve(root, "sub/file.txt"));
    expect(() => resolveWithin(root, p, "../outside.txt")).toThrow(PathPolicyError);
    expect(() => resolveWithin(root, p, "sub/../../escape.txt")).toThrow(PathPolicyError);
  });

  it("rejects absolute paths outside any allowed root", () => {
    const root = tmpDir();
    expect(() => resolveWithin(root, policyFor(root), "C:\\Windows\\system32\\config.sys")).toThrow(
      PathPolicyError,
    );
  });

  it("evaluates commands against denied/warn regex sources", () => {
    const p = {
      allowedRoots: ["x"],
      deniedCommands: ["^rm\\s+-rf\\s+/", "^format\\b"],
      warnCommands: ["^git\\s+push\\s+--force"],
    };
    expect(evaluateCommand(p, "rm -rf /")).toEqual({ allowed: false, warn: false });
    expect(evaluateCommand(p, "echo hello")).toEqual({ allowed: true, warn: false });
    expect(evaluateCommand(p, "git push --force origin main")).toEqual({
      allowed: true,
      warn: true,
    });
  });
});

describe("builtin tools", () => {
  it("read/write roundtrip, offset/length windows", async () => {
    const root = tmpDir();
    const events: HarnessEvent[] = [];
    const ctx = makeCtx(root, events);
    const write = createWriteTool(policyFor(root));
    const read = createReadTool(policyFor(root));

    const w = await write.execute(
      { path: "docs/note.txt", content: "a\nb\nc", createDirs: true },
      ctx,
    );
    expect(w.isError).toBe(false);

    const r1 = await read.execute({ path: "docs/note.txt" }, ctx);
    expect(r1.isError).toBe(false);
    expect(r1.content).toBe("a\nb\nc");

    const r2 = await read.execute({ path: "docs/note.txt", offset: 2, length: 1 }, ctx);
    expect(r2.content).toBe("b");

    const r3 = await read.execute({ path: "missing.txt" }, ctx);
    expect(r3.isError).toBe(true);

    expect(events.filter((e) => e.type === "tool_called").length).toBe(4);
  });

  it("write refuses missing parent without createDirs", async () => {
    const root = tmpDir();
    const write = createWriteTool(policyFor(root));
    const r = await write.execute({ path: "no/such/dir/f.txt", content: "x" }, makeCtx(root));
    expect(r.isError).toBe(true);
    expect(r.content).toContain("createDirs");
  });

  it("edit requires exact match, honors replaceAll, preserves CRLF style", async () => {
    const root = tmpDir();
    const ctx = makeCtx(root);
    const write = createWriteTool(policyFor(root));
    const edit = createEditTool(policyFor(root));

    await write.execute({ path: "crlf.txt", content: "one\r\ntwo\r\none\r\n" }, ctx);
    const noMatch = await edit.execute({ path: "crlf.txt", oldText: "three", newText: "x" }, ctx);
    expect(noMatch.isError).toBe(true);

    const ambiguous = await edit.execute({ path: "crlf.txt", oldText: "one", newText: "1" }, ctx);
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain("replaceAll");

    const all = await edit.execute(
      { path: "crlf.txt", oldText: "one", newText: "1", replaceAll: true },
      ctx,
    );
    expect(all.isError).toBe(false);
    const after = fs.readFileSync(path.join(root, "crlf.txt"), "utf-8");
    expect(after).toContain("1\r\ntwo\r\n1\r\n");
  });

  it("bash executes portable commands, blocks denied, flags warns", async () => {
    const root = tmpDir();
    const events: HarnessEvent[] = [];
    const ctx = makeCtx(root, events);
    const pol = {
      allowedRoots: [root],
      deniedCommands: ["^rm\\s"],
      warnCommands: ["^node\\s"],
    };
    const bash = createBashTool(pol);

    const okRun = await bash.execute({ command: 'node -e "console.log(6*7)"' }, ctx);
    expect(okRun.isError).toBe(false);
    expect(okRun.content).toContain("42");

    const denied = await bash.execute({ command: "rm -rf /" }, ctx);
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("blocked by policy");

    const warned = await bash.execute({ command: "node -e \"console.log('warned')\"" }, ctx);
    expect(warned.isError).toBe(false);
    expect(
      events.some((e) => e.type === "custom" && (e.data as { warn?: boolean }).warn === true),
    ).toBe(true);
  });

  it("registry rejects duplicates and exposes provider definitions", () => {
    const root = tmpDir();
    const registry = new ToolRegistry();
    for (const t of createBuiltinTools(policyFor(root))) registry.register(t);
    expect(() => registry.register(createReadTool(policy()))).toThrow(/already registered/);
    expect(registry.list()).toHaveLength(6);
    const defs = registry.toDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual([
      "bash",
      "edit",
      "read",
      "web_fetch",
      "web_search",
      "write",
    ]);
    expect(defs.every((d) => typeof d.parameters === "object")).toBe(true);
  });
});

describe("Session", () => {
  it("appends, chains, persists and reloads", () => {
    const dir = tmpDir();
    const file = path.join(dir, "session.jsonl");
    const s1 = new Session({ filePath: file });
    const u = s1.appendUser("hello");
    const a = s1.appendAssistant({
      role: "assistant",
      text: "hi",
      toolCalls: [],
      stopReason: "end_turn",
    });
    expect(s1.leafId()).toBe(a.id);
    expect(a.parentId).toBe(u.id);
    expect(fs.existsSync(file)).toBe(true);

    const s2 = new Session({ filePath: file });
    expect(s2.entries()).toHaveLength(2);
    expect(s2.leafId()).toBe(a.id);
  });

  it("checkpoint/restore and branching", () => {
    const s = new Session({ filePath: path.join(tmpDir(), "s.jsonl") });
    s.appendUser("one");
    const cp = s.checkpoint();
    s.appendUser("two");
    expect(s.entries()).toHaveLength(2);
    s.restore(cp);
    expect(s.leafId()).toBe(cp.entryId);
    // branch from the checkpoint
    const branch = s.appendUser("two-prime");
    expect(branch.parentId).toBe(cp.entryId);
    expect(s.entries()).toHaveLength(4); // 2 user entries + 1 leaf-marker (setLeaf) + 1 branch
  });

  it("buildContext projects the branch; summaries replace covered entries", async () => {
    const s = new Session({ filePath: path.join(tmpDir(), "s.jsonl") });
    const u1 = s.appendUser("m1");
    s.appendAssistant({ role: "assistant", text: "m2", toolCalls: [], stopReason: "end_turn" });
    s.appendUser("m3");
    s.appendUser("m4");
    s.appendUser("m5");
    s.appendUser("m6");
    const res = await s.compact({ keepMessages: 2 });
    expect(res.coveredCount).toBe(4);
    const ctx = s.buildContext();
    // summary replaces 4 covered messages: 1 summary-user + 2 kept
    expect(ctx).toHaveLength(3);
    expect(ctx[0]?.role).toBe("user");
    expect((ctx[0] as { content: string }).content).toContain("[compacted]");
    void u1;
  });

  it("throws on corrupted lines with the line number", () => {
    const dir = tmpDir();
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(
      file,
      '{"id":"e000001","parentId":null,"timestamp":"t","data":{"kind":"user","message":{"role":"user","content":"x"}}}\nnot-json\n',
      "utf-8",
    );
    expect(() => new Session({ filePath: file })).toThrow(/line 2/);
  });
});

describe("tool result message shape", () => {
  it("is usable for session logging", () => {
    const tr: ToolResultMessage = {
      role: "tool_result",
      toolCallId: "tc_1",
      toolName: "read",
      content: "file body",
      isError: false,
    };
    expect(tr.isError).toBe(false);
  });
});
