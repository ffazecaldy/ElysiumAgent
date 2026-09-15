/**
 * Unit tests for the swarm-mode internals exported for testing:
 * - parsePlannerOutput: garbage → deterministic fallback, cap, unique ids,
 * - parseCriticVerdict: garbage → passed with default gap, valid JSON parsed,
 * - StreamLineBatcher: line emission, flush, and timer fallback (fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCriticVerdict, parsePlannerOutput, StreamLineBatcher } from "../src/swarm-mode";

/** A planner answer with one valid subtask plus ignored noise around it. */
const VALID_PLAN = `noise before
{"subtasks":[{"id":"a","goal":"First","acceptanceCriteria":["a1"]},{"id":"b","goal":"Second"}]}
noise after`;

describe("parsePlannerOutput", () => {
  it("falls back to a single whole-goal subtask on garbage output", () => {
    const { subtasks, source } = parsePlannerOutput("total garbage", "Build the thing", 3);
    expect(source).toBe("fallback");
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]?.id).toBe("task-1");
    expect(subtasks[0]?.goal).toBe("Build the thing");
    expect(subtasks[0]?.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("caps parsed subtasks at maxSubtasks", () => {
    const { subtasks, source } = parsePlannerOutput(VALID_PLAN, "goal", 1);
    expect(source).toBe("llm");
    expect(subtasks).toHaveLength(1);
    expect(subtasks[0]?.id).toBe("a");
  });

  it("deduplicates duplicate ids", () => {
    const raw = `{"subtasks":[
      {"id":"same","goal":"One"},
      {"id":"same","goal":"Two"},
      {"id":"same","goal":"Three"}
    ]}`;
    const { subtasks, source } = parsePlannerOutput(raw, "goal", 5);
    expect(source).toBe("llm");
    expect(subtasks).toHaveLength(3);
    const ids = subtasks.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("same");
    expect(ids[1]).toBe("same-2");
    expect(ids[2]).toBe("same-3");
  });
});

describe("parseCriticVerdict", () => {
  it("defaults to passed=true with a gap on garbage output", () => {
    const verdict = parseCriticVerdict("not json at all");
    expect(verdict.passed).toBe(true);
    expect(verdict.gaps.length).toBeGreaterThan(0);
    expect(typeof verdict.gaps[0]).toBe("string");
  });

  it("parses valid JSON verdicts", () => {
    const verdict = parseCriticVerdict('{"passed": false, "gaps": ["missing tests"]}');
    expect(verdict.passed).toBe(false);
    expect(verdict.gaps).toEqual(["missing tests"]);
  });
});

describe("StreamLineBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits complete lines immediately on push", () => {
    const lines: string[] = [];
    const batcher = new StreamLineBatcher((text) => lines.push(text));
    batcher.push("first\nsec");
    expect(lines).toEqual(["first\n"]);
    batcher.push("ond\n");
    expect(lines).toEqual(["first\n", "second\n"]);
    expect(lines).toHaveLength(2);
  });

  it("flush() emits the pending partial line and is idempotent", () => {
    const lines: string[] = [];
    const batcher = new StreamLineBatcher((text) => lines.push(text));
    batcher.push("partial without newline");
    expect(lines).toEqual([]);
    batcher.flush();
    expect(lines).toEqual(["partial without newline"]);
    batcher.flush();
    expect(lines).toEqual(["partial without newline"]);
  });

  it("flushes the residual partial line after ~250ms of inactivity", () => {
    const lines: string[] = [];
    const batcher = new StreamLineBatcher((text) => lines.push(text), 250);
    batcher.push("dangling partial");
    expect(lines).toEqual([]);

    vi.advanceTimersByTime(249);
    expect(lines).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(lines).toEqual(["dangling partial"]);
  });
});
