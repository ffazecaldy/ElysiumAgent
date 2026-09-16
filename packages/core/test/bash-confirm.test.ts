/**
 * Operator approval gate for bash warnCommands: when the tool context carries
 * a `confirm` callback, a warn-flagged command runs only after explicit
 * approval; a decline cancels the command with no side effects. Without the
 * callback the pre-existing behavior (execute, warn flag only) is preserved.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type HarnessEvent,
  type PathPolicy,
  type ToolContext,
  createBashTool,
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

/** Policy that ALLOWs everything but flags any command mentioning test-warn. */
function warnPolicy(root: string): PathPolicy {
  return { allowedRoots: [root], warnCommands: ["test-warn"] };
}

interface CtxRecorder {
  ctx: ToolContext;
  events: HarnessEvent[];
}

function makeCtx(
  cwd: string,
  opts?: { confirm?: (command: string) => Promise<boolean> },
): CtxRecorder {
  const events: HarnessEvent[] = [];
  const ctx: ToolContext = {
    cwd,
    signal: new AbortController().signal,
    emit: (e: HarnessEvent) => events.push(e),
  };
  if (opts?.confirm !== undefined) {
    ctx.confirm = opts.confirm;
  }
  return { ctx, events };
}

describe("bash warnCommands operator approval gate", () => {
  it("confirm returning false cancels execution with no side effects", async () => {
    const root = makeRoot("elysium-bash-confirm-");
    const marker = path.join(root, "marker.txt");
    const tool = createBashTool(warnPolicy(root));
    const { ctx, events } = makeCtx(root, { confirm: async () => false });
    const command = `echo test-warn > "${marker}"`;

    const result = await tool.execute({ command }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled by operator");
    expect(result.content).toContain("test-warn");
    // The command must never have spawned: no marker file on disk.
    expect(fs.existsSync(marker)).toBe(false);
    // The existing warn event is still emitted for telemetry.
    expect(events.some((e) => e.type === "custom" && e.data.warn === true)).toBe(true);
  });

  it("passes the exact command to the confirm callback", async () => {
    const root = makeRoot("elysium-bash-confirm-");
    const tool = createBashTool(warnPolicy(root));
    const seen: string[] = [];
    const { ctx } = makeCtx(root, {
      confirm: async (command) => {
        seen.push(command);
        return false;
      },
    });

    await tool.execute({ command: "echo test-warn" }, ctx);
    expect(seen).toEqual(["echo test-warn"]);
  });

  it("confirm returning true lets the command execute", async () => {
    const root = makeRoot("elysium-bash-confirm-");
    const marker = path.join(root, "marker.txt");
    const tool = createBashTool(warnPolicy(root));
    const { ctx } = makeCtx(root, { confirm: async () => true });

    const result = await tool.execute({ command: `echo test-warn > "${marker}"` }, ctx);

    expect(result.isError).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("absent confirm keeps the legacy behavior (executes, warn flag only)", async () => {
    const root = makeRoot("elysium-bash-confirm-");
    const marker = path.join(root, "marker.txt");
    const tool = createBashTool(warnPolicy(root));
    const { ctx, events } = makeCtx(root);

    const result = await tool.execute({ command: `echo test-warn > "${marker}"` }, ctx);

    expect(result.isError).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(events.some((e) => e.type === "custom" && e.data.warn === true)).toBe(true);
  });
});
