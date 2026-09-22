/**
 * benchmarks/capability/mock-llm-server.ts — deterministic scripted LLM.
 *
 * A REAL localhost HTTP server speaking the OpenAI Chat-Completions SSE
 * protocol. runSwarmGoal constructs its own OpenAICompatibleProvider from
 * SwarmProviderConfig; pointing that config at this server exercises the
 * REAL provider→Agent→tools→critic→evaluation→learning→adaptive stack with
 * zero network and zero flakiness. Script authoring uses MockProvider's
 * ScriptedTurn (same shape as the vitest suites) — the HTTP layer is the
 * only thing this module adds.
 */
import http from "node:http";
import { MockProvider } from "../../packages/core/src/providers/mock-provider";
import type { LlmRequest, ScriptedTurn } from "../../packages/core/src/types/provider";

export interface MockSwarmServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** Turn counter (planner, builders, critics all draw from the script). */
  served: () => number;
  /** Replace the builder script queue (per-task, called before each run). */
  setBuilderTurns: (turns: ScriptedTurn[]) => void;
}

/** Heuristic turn classifier — decides which script queue serves a request. */
function classify(prompt: string): "planner" | "builder" | "critic" {
  if (prompt.startsWith("Decompose the goal into")) return "planner";
  if (prompt.startsWith("Judge if the result satisfies")) return "critic";
  return "builder";
}

/** Split a long text into several assistant turns (builder continuation). */
function textTurns(text: string, chunkWords = 40): ScriptedTurn[] {
  const words = text.split(/\s+/).filter(Boolean);
  const turns: ScriptedTurn[] = [];
  for (let i = 0; i < words.length; i += chunkWords) {
    turns.push({ text: `${words.slice(i, i + chunkWords).join(" ")} ` });
  }
  return turns;
}

export function startMockSwarmServer(): Promise<MockSwarmServer> {
  const queues: Record<"planner" | "builder" | "critic", ScriptedTurn[]> = {
    planner: [],
    builder: [],
    critic: [],
  };
  let servedCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      servedCount += 1;
      let parsed: {
        messages?: Array<{ role: string; content?: string }>;
      } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* treated as empty */
      }
      const messages = parsed.messages ?? [];
      const userTexts = messages
        .filter((m) => m.role === "user")
        .map((m) => String(m.content ?? ""));
      const prompt = userTexts[userTexts.length - 1] ?? "";
      const kind = classify(prompt);

      let turn: ScriptedTurn | undefined;
      if (queues[kind].length > 0) {
        turn = queues[kind].shift();
      } else if (kind === "critic") {
        turn = { text: '{"passed": true, "gaps": []}' };
      } else if (kind === "planner") {
        // Generic single-subtask plan from the goal text (appears in prompt).
        const goalLine = prompt.split("\n").find((l) => l.includes("GOAL:"));
        const goal = goalLine ? prompt.slice(prompt.indexOf(goalLine) + 6).trim() : prompt;
        turn = {
          text: JSON.stringify({
            subtasks: [{ id: "task-1", goal, acceptanceCriteria: ["the task goal is achieved"] }],
          }),
        };
      } else {
        turn = { text: "Done." };
      }

      const provider = new MockProvider([turn ?? { text: "Done." }]);
      void (async () => {
        const chunks: string[] = [];
        for await (const ev of provider.stream({
          systemPrompt: "You output only valid JSON. No markdown fences, no commentary.",
          messages: [{ role: "user", content: prompt }],
          tools: [],
        } as LlmRequest)) {
          if (ev.type === "text_delta") {
            chunks.push(sseFrame({ choices: [{ delta: { content: ev.delta } }] }));
          } else if (ev.type === "tool_call_start") {
            chunks.push(
              sseFrame({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: ev.id, function: { name: ev.name, arguments: "" } },
                      ],
                    },
                  },
                ],
              }),
            );
          } else if (ev.type === "tool_call_delta") {
            chunks.push(
              sseFrame({
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: 0, function: { arguments: ev.argumentsDelta } }],
                    },
                  },
                ],
              }),
            );
          } else if (ev.type === "done") {
            chunks.push(
              sseFrame({
                choices: [
                  {
                    delta: {},
                    finish_reason: ev.message.toolCalls.length > 0 ? "tool_calls" : "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 10 },
              }),
            );
          } else if (ev.type === "error") {
            chunks.push(sseFrame({ choices: [{ delta: {} }], finish_reason: "stop" }));
          }
        }
        chunks.push("data: [DONE]\n\n");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end(chunks.join(""));
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        served: () => servedCount,
        setBuilderTurns: (turns) => {
          queues.builder = [...turns];
        },
      });
    });
  });
}

function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export { textTurns };
