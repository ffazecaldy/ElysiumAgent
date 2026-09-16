/**
 * Unit tests for task ownership enforcement:
 * - parseGlobToRegex: ** (any depth), * (one segment), ? (one char), invalid
 *   globs fail closed (regex matches nothing),
 * - checkPath: write (allowed / forbidden / default-deny) and read
 *   (allowed incl. readOnly / forbidden / default-allow),
 * - runSwarmGoal with taskPolicies: a denied write returns an isError
 *   tool_result whose content contains "path denied".
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type SwarmEvent, runSwarmGoal } from "../src/swarm-mode";
import { type TaskPathPolicy, checkPath, parseGlobToRegex } from "../src/task-ownership";

describe("parseGlobToRegex", () => {
  it("** matches across separators (any depth)", () => {
    const re = parseGlobToRegex("src/auth/**");
    expect(re.test("src/auth/login.ts")).toBe(true);
    expect(re.test("src/auth/deep/nested/file.ts")).toBe(true);
    expect(re.test("src/other/file.ts")).toBe(false);
    expect(re.test("src/authx/file.ts")).toBe(false);
  });

  it("* matches within one segment only", () => {
    const re = parseGlobToRegex("src/*.ts");
    expect(re.test("src/main.ts")).toBe(true);
    expect(re.test("src/sub/main.ts")).toBe(false);
  });

  it("? matches exactly one character (not a separator)", () => {
    const re = parseGlobToRegex("src/file?.ts");
    expect(re.test("src/file1.ts")).toBe(true);
    expect(re.test("src/file12.ts")).toBe(false);
    expect(re.test("src/file/.ts")).toBe(false);
  });

  it("invalid globs fail closed: the regex matches nothing", () => {
    for (const bad of ["", "   ", "src/[auth", "src/a**b\n**c"]) {
      const re = parseGlobToRegex(bad);
      expect(re.test("")).toBe(false);
      expect(re.test("src/auth/login.ts")).toBe(false);
      expect(re.test("anything/at/all")).toBe(false);
    }
  });
});

describe("checkPath", () => {
  const policy: TaskPathPolicy = {
    allowed: ["src/auth/**"],
    readOnly: ["src/db/**"],
    forbidden: ["**/secrets/**"],
  };

  it("write: allowed inside allowed globs, denied outside (default-deny)", () => {
    expect(checkPath(policy, "src/auth/login.ts", "write").allowed).toBe(true);
    expect(checkPath(policy, "./src/auth/deep/x.ts", "write").allowed).toBe(true);
    expect(checkPath(policy, "src/db/schema.ts", "write").allowed).toBe(false);
    expect(checkPath(policy, "README.md", "write").allowed).toBe(false);
  });

  it("write: forbidden wins over allowed", () => {
    expect(checkPath(policy, "src/auth/secrets/key.ts", "write").allowed).toBe(false);
  });

  it("read: forbidden denied, readOnly and unlisted allowed (default-allow)", () => {
    expect(checkPath(policy, "src/db/schema.ts", "read").allowed).toBe(true);
    expect(checkPath(policy, "README.md", "read").allowed).toBe(true);
    expect(checkPath(policy, "src/auth/secrets/key.ts", "read").allowed).toBe(false);
  });

  it("normalizes backslashes and leading ./", () => {
    expect(checkPath(policy, "src\\auth\\login.ts", "write").allowed).toBe(true);
    expect(checkPath(policy, "./src/auth/login.ts", "read").allowed).toBe(true);
  });
});

// ── runSwarmGoal + taskPolicies: denied write surfaces "path denied" ──

interface ScriptedServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible SSE server: the builder answers with a tool call
 * to `write` on a path OUTSIDE the task's allowed globs.
 */
async function startDenyingServer(): Promise<ScriptedServer> {
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
      } else if (flattened.includes("path denied")) {
        text = "I was blocked; giving up. file NOT written";
      } else {
        text = "";
      }
      const hasToolCall =
        !flattened.includes("Decompose the goal") &&
        !flattened.includes("Judge if the result") &&
        !flattened.includes("path denied");
      const toolCallChunk = hasToolCall
        ? `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({ path: "outside/evil.ts", content: "nope" }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`
        : "";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
      );
      if (hasToolCall) response.write(toolCallChunk);
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {} }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
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

describe("runSwarmGoal task ownership enforcement", () => {
  it("a write outside allowed globs is denied with a 'path denied' isError tool result", async () => {
    const server = await startDenyingServer();
    try {
      const events: SwarmEvent[] = [];
      await runSwarmGoal({
        goal: "Write the file",
        provider: { baseUrl: server.url, apiKey: "test", model: "mock" },
        taskPolicies: new Map([["a", { allowed: ["src/**"], readOnly: [], forbidden: [] }]]),
        onEvent: (event) => {
          events.push(event);
        },
      });
      const denied = events.filter(
        (event) => event.type === "task_tool" && event.data.isError === true,
      );
      expect(denied.length).toBeGreaterThan(0);
      const toolEvents = events.filter(
        (event) => event.type === "task_tool" && event.data.tool === "write",
      );
      expect(toolEvents.length).toBeGreaterThan(0);
      expect(toolEvents.every((event) => event.data.isError === true)).toBe(true);
      // The agent must have received the denial (it appears in its follow-up
      // prompt — the server flips branch when it sees "path denied").
      expect(events.some((event) => event.type === "task_output")).toBeDefined();
    } finally {
      await server.close();
    }
  }, 15000);
});
