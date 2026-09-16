import { describe, expect, it } from "vitest";
import { diffFingerprints, fingerprintTrajectory, serializeFingerprint } from "../src/fingerprint";
import type { TrajectoryFingerprint, TrajectoryRecord } from "../src/fingerprint";

describe("fingerprintTrajectory", () => {
  it("counts mixed records by tool category", () => {
    const records: TrajectoryRecord[] = [
      { kind: "tool_call", tool: "read" },
      { kind: "tool_call", tool: "grep" },
      { kind: "tool_call", tool: "glob" },
      { kind: "tool_call", tool: "write" },
      { kind: "tool_call", tool: "edit" },
      { kind: "tool_call", tool: "bash" },
      { kind: "tool_call", tool: "test" },
      { kind: "tool_call", tool: "web_search" },
      { kind: "tool_call", tool: "web_search" },
      { kind: "retry" },
      { kind: "tool_result", isError: true },
      { kind: "error" },
      { kind: "token_usage", inputTokens: 100, outputTokens: 40 },
      { kind: "tool_call", tool: "edit", filesTouched: ["a.ts", "b.ts"] },
      { kind: "tool_result", filesTouched: ["b.ts", "c.ts"] },
    ];

    const fp = fingerprintTrajectory(records);
    expect(fp.read).toBe(3);
    expect(fp.edit).toBe(3);
    expect(fp.bash).toBe(1);
    expect(fp.test).toBe(1);
    expect(fp.other).toBe(2);
    expect(fp.retries).toBe(1);
    expect(fp.errors).toBe(2);
    expect(fp.tokensIn).toBe(100);
    expect(fp.tokensOut).toBe(40);
    expect(fp.filesTouched).toBe(3); // union: a.ts, b.ts, c.ts
  });

  it("returns all zeros for an empty trajectory", () => {
    expect(fingerprintTrajectory([])).toEqual({
      read: 0,
      edit: 0,
      bash: 0,
      test: 0,
      other: 0,
      retries: 0,
      errors: 0,
      tokensIn: 0,
      tokensOut: 0,
      filesTouched: 0,
    });
  });

  it("treats a tool_call without tool as 'other'", () => {
    const fp = fingerprintTrajectory([{ kind: "tool_call" }]);
    expect(fp.other).toBe(1);
  });
});

describe("diffFingerprints", () => {
  it("reports only fields with non-zero delta (improvement case)", () => {
    const before: TrajectoryFingerprint = {
      read: 10,
      edit: 4,
      bash: 6,
      test: 2,
      other: 1,
      retries: 3,
      errors: 2,
      tokensIn: 5000,
      tokensOut: 2000,
      filesTouched: 7,
    };
    const after: TrajectoryFingerprint = {
      read: 10,
      edit: 4,
      bash: 6,
      test: 2,
      other: 1,
      retries: 1,
      errors: 0,
      tokensIn: 5000,
      tokensOut: 2000,
      filesTouched: 7,
    };

    const deltas = diffFingerprints(before, after);
    expect(deltas).toEqual([
      { field: "retries", from: 3, to: 1, delta: -2 },
      { field: "errors", from: 2, to: 0, delta: -2 },
    ]);
  });

  it("returns an empty array for identical fingerprints", () => {
    const fp = fingerprintTrajectory([{ kind: "tool_call", tool: "read" }]);
    expect(diffFingerprints(fp, fp)).toEqual([]);
  });
});

describe("serializeFingerprint", () => {
  it("produces a stable JSON line with alphabetically ordered keys", () => {
    const fp = fingerprintTrajectory([
      { kind: "tool_call", tool: "bash" },
      { kind: "tool_call", tool: "read", filesTouched: ["z.ts"] },
      { kind: "token_usage", inputTokens: 10, outputTokens: 5 },
    ]);
    const expected =
      '{"bash":1,"edit":0,"errors":0,"filesTouched":1,"other":0,"read":1,"retries":0,"test":0,"tokensIn":10,"tokensOut":5}';
    expect(serializeFingerprint(fp)).toBe(expected);
  });

  it("is deterministic across calls and input order", () => {
    const a = fingerprintTrajectory([
      { kind: "tool_call", tool: "read" },
      { kind: "tool_call", tool: "bash" },
    ]);
    const b = fingerprintTrajectory([
      { kind: "tool_call", tool: "bash" },
      { kind: "tool_call", tool: "read" },
    ]);
    expect(serializeFingerprint(a)).toBe(serializeFingerprint(b));
  });
});
