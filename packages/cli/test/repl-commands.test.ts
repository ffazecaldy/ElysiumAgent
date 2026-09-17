/** repl-commands tests: /resume listing + apply, /replay fingerprint compare,
 * malformed-expected tolerance, run-report boxing. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatRunReportMessage,
  handleReplayCommand,
  handleResumeCommand,
} from "../src/repl-commands.js";
import { runDir } from "../src/resume.js";
import {
  completeOperation,
  createRunState,
  markInterrupted,
  markPhase,
  recordOperation,
} from "../src/run-state.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-repl-commands-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Creates a run directory with fresh RUNNING state, like `swarm start` will. */
function startRun(runId: string, goal = "do the thing"): string {
  const dir = runDir(root, runId);
  createRunState(dir, runId, goal);
  return dir;
}

describe("handleResumeCommand — listing (no argument)", () => {
  it("lists 2 interrupted runs, one line each", () => {
    const first = startRun("run-a", "ship the parser");
    markInterrupted(first, {
      runId: "run-a",
      goal: "ship the parser",
      status: "RUNNING",
      phase: "EXECUTION",
      checkpointTag: null,
      attempt: 1,
      lastEventAt: new Date().toISOString(),
      operations: [],
      updatedAt: new Date().toISOString(),
    });
    const second = startRun("run-b", "fix the gate");
    markInterrupted(second, {
      runId: "run-b",
      goal: "fix the gate",
      status: "RUNNING",
      phase: "PLANNING",
      checkpointTag: "pre-verify",
      attempt: 2,
      lastEventAt: new Date().toISOString(),
      operations: [],
      updatedAt: new Date().toISOString(),
    });

    const result = handleResumeCommand(root, undefined);

    expect(result.ok).toBe(true);
    expect(result.plan).toBeNull();
    expect(result.state).toBeNull();
    const lines = result.message.split("\n");
    expect(lines).toHaveLength(3); // header + 2 runs
    expect(lines[0]).toBe("interrupted runs:");
    expect(lines[1]).toBe("run run-a · ship the parser · attempt 1 · checkpoint none");
    expect(lines[2]).toBe("run run-b · fix the gate · attempt 2 · checkpoint pre-verify");
  });

  it("reports no resumable runs on an empty root, still ok", () => {
    const result = handleResumeCommand(root, undefined);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no interrupted runs");
  });
});

describe("handleResumeCommand — with run id", () => {
  it("applies the resume plan (attempt + 1 on disk) and returns plan + state", () => {
    const dir = startRun("run-resume", "write the docs");
    const state = markInterrupted(dir, {
      runId: "run-resume",
      goal: "write the docs",
      status: "RUNNING",
      phase: "EXECUTION",
      checkpointTag: null,
      attempt: 1,
      lastEventAt: new Date().toISOString(),
      operations: [],
      updatedAt: new Date().toISOString(),
    });
    recordOperation(dir, state, "edit:src/a.ts", "edit");
    recordOperation(dir, state, "bash:test", "bash");
    completeOperation(dir, state, "edit:src/a.ts"); // DONE → not pending

    const result = handleResumeCommand(root, "run-resume");

    expect(result.ok).toBe(true);
    expect(result.plan).not.toBeNull();
    expect(result.state).not.toBeNull();
    expect(result.message).toBe(
      "resumed run-resume da EXECUTION (attempt 2, 1 operations pending)",
    );
    expect(result.state?.attempt).toBe(2);
    expect(result.state?.status).toBe("RUNNING");

    // applyResume really hit the disk: reload and check.
    const reloaded = JSON.parse(fs.readFileSync(path.join(dir, "elysium-run.json"), "utf-8")) as {
      attempt: number;
      status: string;
    };
    expect(reloaded.attempt).toBe(2);
    expect(reloaded.status).toBe("RUNNING");
  });

  it("returns ok: false for an unknown run id", () => {
    const result = handleResumeCommand(root, "no-such-run");
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.state).toBeNull();
    expect(result.message).toContain("no-such-run");
  });
});

describe("handleReplayCommand", () => {
  /** Synthetic stream: one read (ok) + one failing bash touching a file. */
  const STREAM: unknown[] = [
    { type: "plan", goal: "demo" },
    { type: "tool_call", name: "read", tool: "read", input: { path: "a.ts" }, outputTokens: 120 },
    { type: "tool_result", name: "read", isError: false },
    {
      type: "tool_call",
      name: "bash",
      tool: "bash",
      input: { command: "npm test" },
      filesTouched: ["a.ts"],
    },
    { type: "tool_result", name: "bash", isError: true },
  ];

  it("replays a synthetic tool_call stream: ok, header, match yes", () => {
    const result = handleReplayCommand(STREAM);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("TRAJECTORY REPLAY");
    expect(result.message).toContain("match: yes");
    expect(result.message).toContain('"errors":1');
    expect(result.message).toContain('"tokensOut":120');
  });

  it("detects a tampered stream against expected: match no + deltas listed", () => {
    const baseline = handleReplayCommand(STREAM);
    const fingerprintLine = baseline.message
      .split("\n")
      .find((line) => line.startsWith("fingerprint: "));
    expect(fingerprintLine).toBeDefined();
    const expectedJson = (fingerprintLine as string).slice("fingerprint: ".length);

    const tampered = STREAM.map((event) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "tool_result" &&
        (event as { name?: string }).name === "bash"
      ) {
        return { ...event, isError: false };
      }
      return event;
    });

    const result = handleReplayCommand(tampered, expectedJson);

    expect(result.ok).toBe(true); // command worked; the trajectory diverged
    expect(result.message).toContain("match: no");
    expect(result.message).toContain("delta errors");
  });

  it("returns ok: false (never throws) for malformed expected JSON", () => {
    const result = handleReplayCommand(STREAM, "{not json");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid expected fingerprint JSON");
  });

  it("returns ok: false for valid JSON with a non-fingerprint shape", () => {
    const result = handleReplayCommand(STREAM, JSON.stringify({ foo: 1 }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a trajectory fingerprint");
  });
});

describe("formatRunReportMessage", () => {
  it("boxes the report: header line + 2-space prefix on every line", () => {
    const report = "RUN REPORT\nrun: r1\nstatus: COMPLETED";
    const message = formatRunReportMessage(report);
    const lines = message.split("\n");
    expect(lines[0]).toBe("── run report ──");
    expect(lines[1]).toBe("  RUN REPORT");
    expect(lines[2]).toBe("  run: r1");
    expect(lines[3]).toBe("  status: COMPLETED");
  });

  it("degrades to header-only for an empty report", () => {
    expect(formatRunReportMessage("")).toBe("── run report ──");
  });
});
