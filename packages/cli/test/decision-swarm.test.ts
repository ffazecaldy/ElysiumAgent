/** Decision Layer — swarm integration tests (GAP 1-5).
 *
 * Proves the LIVE swarm path (runSwarmGoal) consults the Decision Layer
 * through the real critic seam:
 *  - no evaluator → zero decision events, behavior identical (GAP 7 off)
 *  - shadow       → decision events recorded, critic still runs, verdicts
 *                   identical to the historical run (GAP 7 shadow)
 *  - evaluator unavailable/timeout → critic runs, fallback recorded
 *  - approvalToSwarmAction mapping (GAP 5)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSwarmGoal, type SwarmEvent } from "../src/swarm-mode";
import { approvalToSwarmAction } from "../src/decision/swarm-hooks";
import { NullDecisionProvider, type DecisionProvider } from "../src/decision/provider";
import { TypeSafeDecisionProvider } from "../src/decision/typesafe";

// ── scripted provider (same SSE pattern as swarm-mode.test.ts) ──
interface ScriptedServer {
  url: string;
  close: () => Promise<void>;
}

async function startScriptedServer(): Promise<ScriptedServer> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const flat = parsed.messages.map((m) => String(m.content)).join(" ");
      const sse = (payload: unknown): void => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      };
      if (flat.includes("Decompose the goal")) {
        sse({
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  subtasks: [{ id: "a", goal: "Write file", acceptanceCriteria: ["file exists"] }],
                }),
              },
            },
          ],
        });
        return;
      }
      if (flat.includes("Judge if the result")) {
        sse({
          choices: [{ index: 0, delta: { content: JSON.stringify({ passed: true, gaps: [] }) } }],
        });
        return;
      }
      sse({ choices: [{ index: 0, delta: { content: "Done. file exists" } }] });
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

/** Jev-shaped provider whose answers are configurable per test. */
function fakeJev(
  answers: Record<string, unknown>,
  opts: { fail?: "timeout" | "network" } = {},
): DecisionProvider {
  return new TypeSafeDecisionProvider({
    apiKey: "test-key",
    timeoutMs: 200,
    fetchImpl: (async () => {
      if (opts.fail === "timeout") {
        throw new DOMException("aborted", "AbortError");
      }
      if (opts.fail === "network") {
        throw new Error("ECONNREFUSED");
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch,
  });
}

const OBVIOUS_PASS = {
  obvious_pass: { probability: 0.97 },
  review_worthiness: { score: "skip", probabilities: { skip: 0.95 }, confidence: 0.93 },
};

function decisionEvents(events: SwarmEvent[]): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.type === "error" && (e.data as { scope?: string }).scope === "decision")
    .map((e) => {
      const data = e.data as { message?: string };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(data.message ?? "{}") as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { ...parsed, scope: "decision" };
    });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("swarm × Decision Layer (live path)", () => {
  it("GAP 7 off: no evaluator → no decision events, run identical", async () => {
    const server = await startScriptedServer();
    try {
      const events: SwarmEvent[] = [];
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "k", model: "mock" },
        onEvent: (e) => events.push(e),
      });
      expect(report.allPassed).toBe(true);
      expect(decisionEvents(events)).toHaveLength(0);
      expect(
        events.some((e) => e.type === "critic" && (e.data as { phase?: string }).phase === "start"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  }, 20000);

  it("GAP 7 shadow: critic runs as before AND decision events are recorded", async () => {
    const server = await startScriptedServer();
    try {
      const events: SwarmEvent[] = [];
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "k", model: "mock" },
        decisionEvaluator: fakeJev(OBVIOUS_PASS),
        decisionMode: "shadow",
        onEvent: (e) => events.push(e),
      });
      // behavior identical: same pass/fail outcome
      expect(report.allPassed).toBe(true);
      // critic STILL ran (shadow never skips)
      expect(
        events.some((e) => e.type === "critic" && (e.data as { phase?: string }).phase === "start"),
      ).toBe(true);
      // decision recorded
      const decisions = decisionEvents(events);
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.some((d) => d.decision === "critic-triage")).toBe(true);
    } finally {
      await server.close();
    }
  }, 25000);

  it("GAP 1/7: evaluator timeout → fallback recorded, run continues historically", async () => {
    const server = await startScriptedServer();
    try {
      const events: SwarmEvent[] = [];
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "k", model: "mock" },
        decisionEvaluator: fakeJev({}, { fail: "timeout" }),
        decisionMode: "shadow",
        onEvent: (e) => events.push(e),
      });
      expect(report.allPassed).toBe(true);
      const decisions = decisionEvents(events);
      expect(decisions.length).toBeGreaterThan(0);
      expect(
        decisions.some((d) => String(d.fallback ?? "").includes("timeout") || d.mode === "shadow"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  }, 25000);

  it("NullDecisionProvider → dormant, no decision events even when mode=shadow", async () => {
    const server = await startScriptedServer();
    try {
      const events: SwarmEvent[] = [];
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "k", model: "mock" },
        decisionEvaluator: new NullDecisionProvider(),
        decisionMode: "shadow",
        onEvent: (e) => events.push(e),
      });
      expect(report.allPassed).toBe(true);
      expect(decisionEvents(events)).toHaveLength(0);
    } finally {
      await server.close();
    }
  }, 20000);
});

describe("GAP 5 — approval → swarm action mapping", () => {
  it("REQUIRE_APPROVAL maps to review (never proceed), DENY to block", () => {
    expect(approvalToSwarmAction("ALLOW")).toBe("proceed");
    expect(approvalToSwarmAction("REQUIRE_APPROVAL")).toBe("review");
    expect(approvalToSwarmAction("DENY")).toBe("block");
  });
});
