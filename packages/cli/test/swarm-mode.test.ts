/**
 * Unit tests for the swarm-mode internals exported for testing:
 * - parsePlannerOutput: garbage → deterministic fallback, cap, unique ids,
 * - parseCriticVerdict: garbage → passed with default gap, valid JSON parsed,
 * - StreamLineBatcher: line emission, flush, and timer fallback (fake timers).
 * - runSwarmGoal: task_ended events carry builder token usage (local SSE server).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { riskScore } from "../../core/src/quality/risk-score";
import {
  StreamLineBatcher,
  type SwarmEvent,
  parseCriticVerdict,
  parsePlannerOutput,
  runSwarmGoal,
} from "../src/swarm-mode";

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

// ── runSwarmGoal: task_ended token surfacing ──────────────────────

interface ScriptedServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible SSE server: routes on the prompt content
 * (planner / critic / builder) and answers every turn with fixed usage
 * {prompt_tokens: 11, completion_tokens: 7} so the builder's cumulative
 * usage is deterministic.
 */
async function startScriptedServer(): Promise<ScriptedServer> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const flattened = parsed.messages.map((m) => String(m.content)).join(" ");
      let text: string;
      if (flattened.includes("Decompose the goal")) {
        text = JSON.stringify({
          subtasks: [{ id: "a", goal: "Write the file", acceptanceCriteria: ["file exists"] }],
        });
      } else if (flattened.includes("Judge if the result")) {
        text = JSON.stringify({ passed: true, gaps: [] });
      } else {
        text = "All done. file exists";
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {} }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("runSwarmGoal task_ended tokens", () => {
  it("surfaces builder token usage on task_ended events", async () => {
    const server = await startScriptedServer();
    try {
      const events: SwarmEvent[] = [];
      await runSwarmGoal({
        goal: "Write the file",
        provider: { baseUrl: server.url, apiKey: "test-key", model: "mock" },
        onEvent: (event) => {
          events.push(event);
        },
      });
      const ended = events.filter((event) => event.type === "task_ended");
      expect(ended).toHaveLength(1);
      const data = ended[0]?.data as {
        tokens?: { inputTokens?: unknown; outputTokens?: unknown };
      };
      expect(data.tokens).toBeDefined();
      expect(typeof data.tokens?.inputTokens).toBe("number");
      expect(data.tokens?.inputTokens).toBe(11);
      expect(data.tokens?.outputTokens).toBe(7);
    } finally {
      await server.close();
    }
  }, 15000);
});

// ── Adaptive verification: riskScore + risk-scaled gate threshold ────

describe("riskScore", () => {
  it("scores low at the 3/4 boundary", () => {
    // 3 criteria, 0 files → 3 → low (inclusive upper bound).
    expect(riskScore({ criteriaCount: 3, filesTouched: 0 })).toEqual({
      score: 3,
      level: "low",
    });
    // 4 criteria, 0 files → 4 → medium (just above the low bound).
    expect(riskScore({ criteriaCount: 4, filesTouched: 0 })).toEqual({
      score: 4,
      level: "medium",
    });
  });

  it("scores medium at the 6/7 boundary", () => {
    // 0 criteria, 12 files → 6 → medium (inclusive upper bound).
    expect(riskScore({ criteriaCount: 0, filesTouched: 12 })).toEqual({
      score: 6,
      level: "medium",
    });
    // 7 criteria, 0 files → 7 → high (just above the medium bound).
    expect(riskScore({ criteriaCount: 7, filesTouched: 0 })).toEqual({
      score: 7,
      level: "high",
    });
  });

  it("adds the critical-path bonus and can cross a level boundary", () => {
    // 3 + 0 + 3 → 6 → medium.
    expect(riskScore({ criteriaCount: 3, filesTouched: 0, hasCriticalPath: true })).toEqual({
      score: 6,
      level: "medium",
    });
    // Without the flag the same input stays low — bonus is not applied by default.
    expect(riskScore({ criteriaCount: 3, filesTouched: 0 }).level).toBe("low");
  });

  it("clamps the score to 0-10 and is deterministic", () => {
    expect(riskScore({ criteriaCount: 99, filesTouched: 99, hasCriticalPath: true })).toEqual({
      score: 10,
      level: "high",
    });
    expect(riskScore({ criteriaCount: 0, filesTouched: 0 })).toEqual({
      score: 0,
      level: "low",
    });
    const once = riskScore({ criteriaCount: 5, filesTouched: 4, hasCriticalPath: true });
    const twice = riskScore({ criteriaCount: 5, filesTouched: 4, hasCriticalPath: true });
    expect(once).toEqual(twice);
  });
});

describe("swarm gate adaptive threshold", () => {
  it("gate scoring stays deterministic with adaptive thresholds (coverage 10 passes at any level)", async () => {
    const server = await startScriptedServer();
    const events: SwarmEvent[] = [];
    try {
      await runSwarmGoal({
        goal: "Write the file",
        provider: { baseUrl: server.url, apiKey: "test-key", model: "mock" },
        onEvent: (event) => {
          events.push(event);
        },
      });
      const done = events.find((event) => event.type === "done");
      expect(done).toBeDefined();
      const data = done?.data as {
        scores: Array<{ taskId: string; weighted: number; passed: boolean }>;
      };
      expect(data.scores).toHaveLength(1);
      const entry = data.scores[0];
      expect(entry).toBeDefined();
      // structuralJudge weights: coverage round(1*10)=10 → weighted 10.
      expect(entry?.weighted).toBe(10);
      expect(entry?.passed).toBe(true);
    } finally {
      await server.close();
    }
  }, 15000);
});
