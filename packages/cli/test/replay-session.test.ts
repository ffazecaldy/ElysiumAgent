/** replay-session tests: event→step extraction, fingerprint computation,
 * regression comparison, malformed-event tolerance. Contract: `tool`,
 * `outputTokens` and `filesTouched` live on the tool_call event; `isError`
 * is paired from the next tool_result with the same `name`. */
import { describe, expect, it } from "vitest";
import { extractReplaySteps, replayTrajectory } from "../src/replay-session";

/** Synthetic stream: 3 tool_calls (one failing) + noise + malformed entries. */
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
  { type: "tool_call", name: "probe", tool: "unknown-probe", input: { x: 1 } },
  { type: "tool_result", name: "probe" },
  "garbage string",
  null,
  { type: "tool_call" }, // malformed: no crash, becomes a fallback 'other' step
];

describe("extractReplaySteps", () => {
  it("extracts every tool_call (incl. malformed), reassigning seq from 1", () => {
    const steps = extractReplaySteps(STREAM);
    expect(steps).toHaveLength(4);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(steps.map((s) => s.tool)).toEqual(["read", "bash", "other", "other"]);
  });

  it("pairs isError from the next tool_result with the same name", () => {
    const steps = extractReplaySteps(STREAM);
    expect(steps[0]?.result.isError).toBe(false);
    expect(steps[1]?.result.isError).toBe(true);
    expect(steps[2]?.result.isError).toBe(false);
  });

  it("carries outputTokens and filesTouched from the tool_call", () => {
    const steps = extractReplaySteps(STREAM);
    expect(steps[0]?.result.outputTokens).toBe(120);
    expect(steps[1]?.result.filesTouched).toEqual(["a.ts"]);
  });

  it("returns [] for garbage arrays and never throws", () => {
    expect(extractReplaySteps(["a", 1, null])).toEqual([]);
    expect(extractReplaySteps([])).toEqual([]);
  });
});

describe("replayTrajectory", () => {
  it("computes a deterministic fingerprint and matches itself", () => {
    const first = replayTrajectory(STREAM);
    const second = replayTrajectory(STREAM);
    expect(first.serialized).toBe(second.serialized);
    expect(first.match).toBe(true);
    expect(first.deltas).toEqual([]);
    expect(first.fingerprint.read).toBe(1);
    expect(first.fingerprint.bash).toBe(1);
    expect(first.fingerprint.other).toBe(2);
    expect(first.fingerprint.errors).toBe(1);
    expect(first.fingerprint.tokensOut).toBe(120);
  });

  it("detects tampering via an expected fingerprint (regression)", () => {
    const baseline = replayTrajectory(STREAM);
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
    const result = replayTrajectory(tampered, baseline.fingerprint);
    expect(result.match).toBe(false);
    expect(result.deltas.some((d) => d.field === "errors")).toBe(true);
  });
});
