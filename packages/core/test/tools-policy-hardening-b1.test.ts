/**
 * B1C hardening: builtin tools must return isError results (never throw) on
 * operational failures, bash policy evaluation must fail safe on bad policy
 * data, path-policy realpath fallback must not swallow OS errors, and the
 * ".." containment check must not false-positive on dot-prefixed filenames.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type HarnessEvent,
  type PathPolicy,
  type ToolContext,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  evaluateCommand,
  resolveWithin,
} from "@elysium/core";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

function policyFor(root: string): PathPolicy {
  return { allowedRoots: [root] };
}

function makeCtx(cwd: string, opts?: { signal?: AbortSignal }): ToolContext {
  const events: HarnessEvent[] = [];
  return {
    cwd,
    signal: opts?.signal ?? new AbortController().signal,
    emit: (e: HarnessEvent) => events.push(e),
  };
}

describe("isInside containment does not false-positive on dot-prefixed files", () => {
  it("allows a file literally named '..data.txt' inside the allowed root", () => {
    const root = makeRoot("elysium-b1-");
    const policy = policyFor(root);
    const target = path.join(root, "..data.txt");
    // Target does not exist yet: drive the lexical fallback path too.
    expect(resolveWithin(root, policy, "..data.txt")).toBe(target);
    fs.writeFileSync(target, "x", "utf-8");
    expect(resolveWithin(root, policy, target)).toBe(target);
  });

  it("still rejects real '..' escapes of every shape", () => {
    const root = makeRoot("elysium-b1-");
    const policy = policyFor(root);
    expect(() => resolveWithin(root, policy, "../escape.txt")).toThrow();
    expect(() => resolveWithin(root, policy, "..")).toThrow();
    expect(() => resolveWithin(root, policy, "..\\escape.txt")).toThrow();
  });

  it("treats a path traversing through a file (ENOTDIR) as inside but unresolvable-realpath", () => {
    const root = makeRoot("elysium-b1-");
    const policy = policyFor(root);
    // realpath fails with ENOTDIR here; the guarded fallback must NOT
    // accidentally deny (lexical resolution stays inside the root).
    expect(() => resolveWithin(root, policy, path.join("..data.txt", "sub.txt"))).not.toThrow();
  });
});

describe("evaluateCommand fail-safe on invalid policy regexes", () => {
  it("denies silently when a deniedCommands pattern is an invalid regex", () => {
    const policy: PathPolicy = {
      allowedRoots: [],
      deniedCommands: ["(", "\\brm\\s+-[rR][fF]", "[ungterminated"],
    };
    expect(() => evaluateCommand(policy, "rm -rf /")).not.toThrow();
    const verdict = evaluateCommand(policy, "rm -rf /");
    expect(verdict.allowed).toBe(false);
    expect(verdict.warn).toBe(false);
  });

  it("denies everything when any denied pattern is invalid (fail-closed)", () => {
    const policy: PathPolicy = {
      allowedRoots: [],
      deniedCommands: ["("],
      warnCommands: ["[ungterminated"],
    };
    expect(() => evaluateCommand(policy, "echo hello")).not.toThrow();
    const verdict = evaluateCommand(policy, "echo hello");
    expect(verdict.allowed).toBe(false);
    expect(verdict.warn).toBe(false);
  });

  it("invalid warn pattern alone still allows command (no warn flag)", () => {
    const policy: PathPolicy = {
      allowedRoots: [],
      warnCommands: ["[ungterminated"],
    };
    const verdict = evaluateCommand(policy, "echo hello");
    expect(verdict.allowed).toBe(true);
    expect(verdict.warn).toBe(false);
  });
});

describe("bash tool returns isError results, never throws", () => {
  it("returns isError (no throw) when policy contains an invalid denied regex", async () => {
    const root = makeRoot("elysium-b1-bash-");
    const policy: PathPolicy = {
      allowedRoots: [root],
      deniedCommands: ["("],
    };
    const tool = createBashTool(policy);
    const result = await tool.execute({ command: "rm -rf /does-not-matter" }, makeCtx(root));
    expect(result.isError).toBe(true);
    expect(result.content).toBe("blocked by policy");
  });

  it("returns isError (no throw) when resolveWithin fails for a bad cwd", async () => {
    const root = makeRoot("elysium-b1-bash-");
    const tool = createBashTool(policyFor(root));
    const result = await tool.execute(
      { command: 'node -e "console.log(1)"', cwd: "../outside-escape" },
      makeCtx(root),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed roots");
  });

  it("reports an exec timeout as an isError result", async () => {
    const previous = process.env.ELYSIUM_BASH_TIMEOUT_MS;
    process.env.ELYSIUM_BASH_TIMEOUT_MS = "300";
    try {
      const root = makeRoot("elysium-b1-bash-");
      const tool = createBashTool(policyFor(root));
      // Sleeps well past the 300ms configured timeout.
      const result = await tool.execute(
        { command: 'node -e "setTimeout(() => {}, 5000)"' },
        makeCtx(root),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("timed out");
    } finally {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: env cleanup requires delete (unset, not undefined)
        delete process.env.ELYSIUM_BASH_TIMEOUT_MS;
      } else {
        process.env.ELYSIUM_BASH_TIMEOUT_MS = previous;
      }
    }
  });

  it("reports a pre-aborted signal as an isError result without spawning", async () => {
    const root = makeRoot("elysium-b1-bash-");
    const tool = createBashTool(policyFor(root));
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      { command: "echo hi" },
      makeCtx(root, { signal: controller.signal }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted by caller");
  });
});

describe("read/write/edit builtin operational failures return isError", () => {
  const root = (): string => makeRoot("elysium-b1-io-");

  it("read: returns isError for a missing file", async () => {
    const dir = root();
    const tool = createReadTool(policyFor(dir));
    const result = await tool.execute({ path: "missing.txt" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing.txt");
  });

  it("read: returns isError for a path escaping allowed roots", async () => {
    const dir = root();
    const tool = createReadTool(policyFor(dir));
    const result = await tool.execute({ path: "../outside.txt" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed roots");
  });

  it("read: returns isError for a directory path", async () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, "adir"));
    const tool = createReadTool(policyFor(dir));
    const result = await tool.execute({ path: "adir" }, makeCtx(dir));
    expect(result.isError).toBe(true);
  });

  it("write: returns isError when parent directory is missing and createDirs is false", async () => {
    const dir = root();
    const tool = createWriteTool(policyFor(dir));
    const result = await tool.execute({ path: "no-such-dir/out.txt", content: "x" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("parent directory does not exist");
  });

  it("write: returns isError when the target path is a directory", async () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, "adir"));
    const tool = createWriteTool(policyFor(dir));
    const result = await tool.execute({ path: path.join(dir, "adir"), content: "x" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("directory");
  });

  it("write: returns isError when the path escapes allowed roots", async () => {
    const dir = root();
    const tool = createWriteTool(policyFor(dir));
    const result = await tool.execute({ path: "../escape.txt", content: "x" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed roots");
  });

  it("edit: returns isError when the file does not exist", async () => {
    const dir = root();
    const tool = createEditTool(policyFor(dir));
    const result = await tool.execute(
      { path: "missing.txt", oldText: "a", newText: "b" },
      makeCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file does not exist");
  });

  it("edit: returns isError when oldText is not found", async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, "f.txt"), "hello", "utf-8");
    const tool = createEditTool(policyFor(dir));
    const result = await tool.execute(
      { path: "f.txt", oldText: "nope", newText: "b" },
      makeCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("edit: returns isError for an ambiguous non-replaceAll match", async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, "f.txt"), "a a a", "utf-8");
    const tool = createEditTool(policyFor(dir));
    const result = await tool.execute({ path: "f.txt", oldText: "a", newText: "b" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("multiple locations");
  });

  it("edit: returns isError when the path escapes allowed roots", async () => {
    const dir = root();
    const tool = createEditTool(policyFor(dir));
    const result = await tool.execute(
      { path: "../escape.txt", oldText: "a", newText: "b" },
      makeCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed roots");
  });
});
