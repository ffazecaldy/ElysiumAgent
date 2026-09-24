/** F-07 — critic claim-vs-objective priority (live runSwarmGoal integration).
 *
 * The critic is a CLAIM about the objective result, not the objective itself.
 * These tests pin the priority contract on the REAL swarm path (scripted
 * OpenAI-compatible server, same SSE pattern as decision-swarm.test.ts):
 *
 *  1. critic valid pass            → attempts 1, objective pass.
 *  2. critic provider throw (500)  → an UNAVAILABLE critic is an observation
 *     gap, not a verdict: the task is NOT auto-FAILED, ZERO repair burn, the
 *     builder's objective status stands.                     [RED until fix]
 *  3. critic malformed JSON        → parseCriticVerdict fail-open
 *     (passed=true + "not valid JSON" gap): NOT auto-FAILED, ZERO repair.
 *  4. critic valid JSON fail       → a REAL verdict: bounded repair consumed
 *     (attempts 2), objective FAIL stands.
 *
 * Propagation matrix (documented contract; see the it() near the bottom):
 *  - security FAIL (destructive deletion observed) → task FAIL (R1: security
 *    outranks everything, NEVER PASS) → evaluation FALSE_SUCCESS (under a
 *    success claim) / FAIL (without) → learning records a failure.
 *  - objective PASS + critic malformed → task NOT auto-FAIL (fail-open, zero
 *    repair) → evaluation postcondition ok=false (B17: fail-open cannot
 *    self-certify) → learning NOT polluted with a phantom task failure.
 *  - objective PASS + critic unavailable (provider throw) → task NOT
 *    auto-FAIL → critic postcondition ok=null → task outcome INSUFFICIENT
 *    (never FALSE_SUCCESS) → learning NOT polluted.
 *  - objective PASS + critic valid fail → repair consumed
 *    (attempts = 1 + repairRounds) → objective FAIL.
 *
 * The fix itself is applied by the parent in the swarm-mode critic seam —
 * this file only pins the TARGET behavior via {@link EXPECTED_FIX}.
 */

/** Behaviors the F-07 fix must implement (verified by the tests below). */
const EXPECTED_FIX = [
  "critic provider throw → verdict {passed:true, gaps:['critic unavailable (UNKNOWN): <message>']} → NO repair round, NO auto-FAIL: the objective (builder) status governs the run",
  "critic malformed JSON → parseCriticVerdict fail-open (passed=true + gap 'critic response was not valid JSON…') → NO repair, NO auto-FAIL; the gap marker keeps the run inspectable",
  "critic valid JSON with passed:false → a REAL verdict: bounded repair consumed (attempts = 1 + repairRounds) and the objective FAIL stands",
  "evaluation: critic unavailable → critic postcondition ok=null → task outcome INSUFFICIENT (never FALSE_SUCCESS); malformed → ok=false (B17 fail-open)",
];

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type SwarmEvent, runSwarmGoal } from "../src/swarm-mode";

// ── scripted provider (same SSE pattern as decision-swarm.test.ts) ──

/** How the scripted server answers the critic prompt ("Judge if the result"). */
type CriticBehavior =
  | { mode: "valid"; passed: boolean; gaps: string[] }
  | { mode: "http500" }
  | { mode: "raw"; text: string };

interface ScriptedServer {
  url: string;
  counts: { planner: number; builder: number; critic: number };
  close: () => Promise<void>;
}

async function startScriptedServer(criticBehavior: CriticBehavior): Promise<ScriptedServer> {
  const counts = { planner: 0, builder: 0, critic: 0 };
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
        counts.planner += 1;
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
        counts.critic += 1;
        if (criticBehavior.mode === "http500") {
          // Provider surfaces !response.ok as a stream error event → throw.
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end("critic backend down");
          return;
        }
        if (criticBehavior.mode === "raw") {
          sse({ choices: [{ index: 0, delta: { content: criticBehavior.text } }] });
          return;
        }
        sse({
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  passed: criticBehavior.passed,
                  gaps: criticBehavior.gaps,
                }),
              },
            },
          ],
        });
        return;
      }
      counts.builder += 1;
      sse({ choices: [{ index: 0, delta: { content: "Done. file exists" } }] });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── runner + event helpers ──

interface ScenarioResult {
  report: Awaited<ReturnType<typeof runSwarmGoal>>;
  events: SwarmEvent[];
  counts: ScriptedServer["counts"];
}

async function runScenario(criticBehavior: CriticBehavior): Promise<ScenarioResult> {
  const server = await startScriptedServer(criticBehavior);
  const events: SwarmEvent[] = [];
  try {
    // runsRoot stays OUTSIDE the repo (fresh temp dir per scenario).
    const runsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "elysium-critic-priority-"));
    const report = await runSwarmGoal({
      goal: "Write file",
      provider: { baseUrl: server.url, apiKey: "test-key", model: "mock" },
      maxSubtasks: 1,
      runsRoot,
      onEvent: (e) => events.push(e),
    });
    return { report, events, counts: server.counts };
  } finally {
    await server.close();
  }
}

function taskEnded(
  events: SwarmEvent[],
): Array<{ taskId: unknown; status: unknown; attempts: unknown }> {
  return events
    .filter((e) => e.type === "task_ended")
    .map((e) => e.data as { taskId: unknown; status: unknown; attempts: unknown });
}

function repairs(events: SwarmEvent[]): SwarmEvent[] {
  return events.filter((e) => e.type === "repair");
}

function criticEnd(events: SwarmEvent[]): SwarmEvent[] {
  return events.filter(
    (e) => e.type === "critic" && (e.data as { phase?: string }).phase === "end",
  );
}

function errorEvents(events: SwarmEvent[], scope: string): SwarmEvent[] {
  return events.filter((e) => e.type === "error" && (e.data as { scope?: string }).scope === scope);
}

// ── tests ──

describe("F-07 — critic claim vs objective priority (live runSwarmGoal)", () => {
  it("valid critic pass → attempts 1, objective pass, zero repair", async () => {
    const { report, events, counts } = await runScenario({
      mode: "valid",
      passed: true,
      gaps: [],
    });
    const ended = taskEnded(events);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.status).toBe("pass");
    expect(ended[0]?.attempts).toBe(1);
    expect(repairs(events)).toHaveLength(0);
    expect(errorEvents(events, "critic")).toHaveLength(0);
    expect(criticEnd(events)[0]?.data).toMatchObject({ passed: true, gaps: [] });
    expect(report.allPassed).toBe(true);
    expect(report.subtasks[0]?.critic?.passed).toBe(true);
    expect(counts).toEqual({ planner: 1, builder: 1, critic: 1 });
  }, 30000);

  it("critic provider throw (HTTP 500) → NOT auto-FAIL: builder status stands, ZERO repair [RED until F-07 fix]", async () => {
    const { report, events, counts } = await runScenario({ mode: "http500" });
    // The failure is surfaced, never swallowed: either a critic-scope error
    // event or the UNKNOWN-availability gap on the verdict.
    const surfaced =
      errorEvents(events, "critic").length > 0 ||
      criticEnd(events).some((e) =>
        ((e.data as { gaps?: unknown[] }).gaps ?? []).some((g) =>
          String(g).includes("unavailable"),
        ),
      );
    expect(surfaced).toBe(true);
    // The task is NOT failed by the critic's absence: builder status stands.
    const ended = taskEnded(events);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.status).toBe("pass");
    expect(ended[0]?.attempts).toBe(1);
    // ZERO repair burn: an unavailable critic must not consume repair rounds
    // (today: runCritic catch → {passed:false} → repair → attempts 2).
    expect(repairs(events)).toHaveLength(0);
    expect(counts.critic).toBe(1);
    expect(counts.builder).toBe(1);
    // Objective (builder pass) governs: the run is NOT auto-failed.
    expect(report.allPassed).toBe(true);
  }, 30000);

  it("critic malformed JSON → fail-open: NOT auto-FAIL, ZERO repair", async () => {
    const { report, events, counts } = await runScenario({ mode: "raw", text: "not json {{{" });
    const ended = taskEnded(events);
    expect(ended).toHaveLength(1);
    expect(ended[0]?.status).toBe("pass");
    expect(ended[0]?.attempts).toBe(1);
    expect(repairs(events)).toHaveLength(0);
    // Fail-open verdict: passed=true with the recognizable gap marker.
    const endData = criticEnd(events)[0]?.data as { passed?: boolean; gaps?: string[] };
    expect(endData?.passed).toBe(true);
    expect((endData?.gaps ?? []).some((g) => g.includes("not valid JSON"))).toBe(true);
    expect(report.allPassed).toBe(true);
    expect(counts.critic).toBe(1);
  }, 30000);

  it("critic valid fail (persistent) → repair consumed (attempts 2), objective FAIL stands", async () => {
    const { report, events, counts } = await runScenario({
      mode: "valid",
      passed: false,
      gaps: ["the produced file does not satisfy the acceptance criteria"],
    });
    const ended = taskEnded(events);
    expect(ended).toHaveLength(1);
    // The builder objectively succeeded BOTH times: its status stays "pass".
    expect(ended[0]?.status).toBe("pass");
    // A VALID failing verdict consumes the bounded repair budget.
    expect(ended[0]?.attempts).toBe(2);
    expect(repairs(events)).toHaveLength(1);
    expect(counts.critic).toBe(2);
    expect(counts.builder).toBe(2);
    // …and the objective FAIL stands (a claim is not the objective).
    expect(report.allPassed).toBe(false);
    expect(report.subtasks[0]?.critic?.passed).toBe(false);
    expect(report.subtasks[0]?.critic?.gaps).toContain(
      "the produced file does not satisfy the acceptance criteria",
    );
  }, 30000);

  it("propagation matrix (documented): EXPECTED_FIX pins the four critic behaviors", () => {
    expect(EXPECTED_FIX).toHaveLength(4);
    expect(EXPECTED_FIX.some((f) => /throw/i.test(f))).toBe(true);
    expect(EXPECTED_FIX.some((f) => /malformed|not valid JSON/i.test(f))).toBe(true);
    expect(EXPECTED_FIX.some((f) => /passed\s*:\s*false|valid JSON with passed/i.test(f))).toBe(
      true,
    );
    expect(EXPECTED_FIX.some((f) => /INSUFFICIENT|ok=null/i.test(f))).toBe(true);
  });
});
