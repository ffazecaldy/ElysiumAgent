/**
 * CLI commands — demo, single task, orchestration.
 *
 * All core pieces come from the `@elysium/core` root barrel: `Agent`,
 * `Orchestrator`, `MockProvider`, `ToolRegistry`, `createBuiltinTools`.
 * The tool executor seam is wired here: the Agent never executes tools
 * itself, the host resolves calls through the ToolRegistry.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Agent,
  MockProvider,
  Orchestrator,
  ProviderInitializationError,
  RecoverableCliError,
  ToolRegistry,
  createBuiltinTools,
} from "@elysium/core";
import type {
  AgentMessage,
  LlmProvider,
  LlmRequest,
  OrchestrationPlan,
  StreamEvent,
  SubagentResult,
  SubagentTask,
  ToolCallPart,
  ToolResultMessage,
} from "@elysium/core";
import { loadConfig, describeConfig } from "./config";
import type { ProviderConfig } from "./config";

const SYSTEM_PROMPT =
  "You are the Elysium demo agent. Use the available tools when asked to access files.";

function makeToolExecutor(registry: ToolRegistry, cwd: string) {
  return async (call: ToolCallPart): Promise<ToolResultMessage> => {
    const tool = registry.get(call.name);
    if (tool === undefined) {
      return {
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: `unknown tool: ${call.name}`,
        isError: true,
      };
    }
    try {
      const result = await tool.execute(call.arguments, {
        cwd,
        signal: new AbortController().signal,
        emit: () => {},
      });
      return {
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        ...(result.details !== undefined ? { details: result.details } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: message,
        isError: true,
      };
    }
  };
}

function renderConversation(messages: AgentMessage[]): void {
  for (const message of messages) {
    if (message.role === "user") {
      process.stdout.write(`[user] ${message.content}\n`);
    } else if (message.role === "assistant") {
      if (message.text.length > 0) {
        process.stdout.write(`[assistant] ${message.text}\n`);
      }
      for (const call of message.toolCalls) {
        process.stdout.write(
          `[assistant tool_call] ${call.name}(${JSON.stringify(call.arguments)})\n`,
        );
      }
    } else {
      process.stdout.write(`[tool_result ${message.toolName}] ${message.content}\n`);
    }
  }
}

function renderUsage(label: string, inputTokens: number, outputTokens: number): void {
  process.stdout.write(`tokens: ${inputTokens} in / ${outputTokens} out (${label})\n`);
}

/**
 * Minimal OpenAI-compatible streaming chat-completions client.
 * Used only when the environment configures a real provider endpoint
 * (ELYSIUM_PROVIDER=openai-compatible with base URL and API key).
 */
function createOpenAiCompatibleProvider(config: ProviderConfig): LlmProvider {
  const baseUrl = config.baseUrl ?? "";
  const apiKey = config.apiKey ?? "";
  const model = config.model ?? "gpt-4o-mini";
  return {
    id: "openai-compatible",
    async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
      const body: Record<string, unknown> = {
        model,
        stream: true,
        messages: [
          { role: "system", content: request.systemPrompt },
          ...request.messages.map((message): Record<string, unknown> => {
            if (message.role === "user") {
              return { role: "user", content: message.content };
            }
            if (message.role === "assistant") {
              const entry: Record<string, unknown> = {
                role: "assistant",
                content: message.text.length > 0 ? message.text : null,
              };
              if (message.toolCalls.length > 0) {
                entry.tool_calls = message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                }));
              }
              return entry;
            }
            return {
              role: "tool",
              tool_call_id: message.toolCallId,
              content: message.content,
            };
          }),
        ],
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
      };
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok || response.body === null) {
        const detail = response.body === null ? "empty response body" : await response.text();
        throw new Error(`openai-compatible request failed: ${response.status} ${detail}`);
      }
      let text = "";
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice("data:".length).trim();
          if (payload === "[DONE]") {
            continue;
          }
          let parsed: {
            choices?: {
              delta?: {
                content?: string | null;
                tool_calls?: {
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
            }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            parsed = JSON.parse(payload) as typeof parsed;
          } catch {
            continue;
          }
          if (parsed.usage) {
            inputTokens = parsed.usage.prompt_tokens ?? inputTokens;
            outputTokens = parsed.usage.completion_tokens ?? outputTokens;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (delta === undefined) {
            continue;
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            text += delta.content;
            yield { type: "text_delta", delta: delta.content };
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
            toolCalls.set(index, {
              id: call.id ?? existing.id,
              name: existing.name + (call.function?.name ?? ""),
              arguments: existing.arguments + (call.function?.arguments ?? ""),
            });
          }
        }
      }
      const assembled = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          let argumentsParsed: Record<string, unknown> = {};
          try {
            const raw: unknown = JSON.parse(call.arguments);
            if (typeof raw === "object" && raw !== null) {
              argumentsParsed = raw as Record<string, unknown>;
            }
          } catch {
            argumentsParsed = {};
          }
          return {
            type: "tool_call" as const,
            id: call.id,
            name: call.name,
            arguments: argumentsParsed,
          };
        });
      yield {
        type: "done",
        message: {
          role: "assistant",
          text,
          toolCalls: assembled,
          stopReason: assembled.length > 0 ? "tool_use" : "end_turn",
          usage: { inputTokens, outputTokens },
        },
      };
    },
  };
}

/** Provider for a task run: configured endpoint if present, else a mock. */
function makeTaskProvider(config: ProviderConfig, task: string): LlmProvider {
  if (config.baseUrl && config.apiKey && config.provider !== "ollama") {
    try {
      return createOpenAiCompatibleProvider(config);
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : "provider initialization failed";
      throw new ProviderInitializationError(
        `openai-compatible provider init failed: ${message}`,
        "Check the provider endpoint and API key configuration",
      );
    }
  }
  return new MockProvider([{ text: `echo: ${task}` }]);
}

/**
 * End-to-end offline demo: creates a file in a temp dir, scripts a
 * MockProvider to read it with the `read` tool, runs the Agent loop and
 * prints the full conversation plus the usage summary.
 */
export async function runDemo(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "elysium-demo-"));
  const demoFile = path.join(dir, "hello.txt");
  await writeFile(demoFile, "Hello from the Elysium Harness demo!", "utf-8");

  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ allowedRoots: [dir] })) {
    registry.register(tool);
  }

  const provider = new MockProvider([
    {
      text: "I will read the demo file now.",
      toolCalls: [{ name: "read", arguments: { path: demoFile } }],
    },
    {
      text: "The demo file says: Hello from the Elysium Harness demo!",
    },
  ]);

  const agent = new Agent({
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: registry.list(),
    executeTool: makeToolExecutor(registry, dir),
  });

  process.stdout.write(`[demo] temp dir: ${dir}\n`);
  const result = await agent.run("Read the demo file and tell me what it says.");
  renderConversation(result.messages);
  renderUsage("demo", result.usage.inputTokens, result.usage.outputTokens);
}

/** Runs one task end-to-end with the configured provider. */
export async function runTask(task: string): Promise<void> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    throw new RecoverableCliError("task must not be empty", "Pass a non-empty task");
  }
  const config = loadConfig();
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ allowedRoots: [process.cwd()] })) {
    registry.register(tool);
  }
  const provider = makeTaskProvider(config, trimmed);
  const agent = new Agent({
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: registry.list(),
    executeTool: makeToolExecutor(registry, process.cwd()),
  });
  const result = await agent.run(trimmed);
  renderConversation(result.messages);
  renderUsage(config.provider, result.usage.inputTokens, result.usage.outputTokens);
}

/** Parses the orchestrate goals JSON: array of {id, goal}. */
function parseGoals(goalsJson: string): SubagentTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(goalsJson);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecoverableCliError(
      `invalid goals JSON: ${message}`,
      'Pass valid JSON like [{"id":"a","goal":"..."}]',
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new RecoverableCliError(
      "goals must be a non-empty JSON array of {id, goal}",
      'Pass an array like [{"id":"a","goal":"..."}]',
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new RecoverableCliError(
        `goals[${index}] must be an object with 'id' and 'goal'`,
        "Each entry needs string fields 'id' and 'goal'",
      );
    }
    const record = entry as { id?: unknown; goal?: unknown };
    if (typeof record.id !== "string" || record.id.trim().length === 0) {
      throw new RecoverableCliError(
        `goals[${index}].id must be a non-empty string`,
        "Set a unique non-empty 'id' for every entry",
      );
    }
    if (typeof record.goal !== "string" || record.goal.trim().length === 0) {
      throw new RecoverableCliError(
        `goals[${index}].goal must be a non-empty string`,
        "Set a non-empty 'goal' description for every entry",
      );
    }
    return { id: record.id, goal: record.goal };
  });
}

/**
 * Hierarchical orchestration run: spawns MockProvider-backed subagents for
 * each goal, executes the plan with the Orchestrator and prints the report.
 */
export async function runOrchestrate(goalsJson: string): Promise<void> {
  const subtasks = parseGoals(goalsJson);
  const plan: OrchestrationPlan = {
    goal: `orchestrate ${subtasks.length} goal(s)`,
    maxDepth: 2,
    subtasks,
  };

  const spawn = async (task: SubagentTask): Promise<SubagentResult> => {
    const provider = new MockProvider([{ text: `done: ${task.goal}` }]);
    const agent = new Agent({
      systemPrompt: "You are a focused subagent. Complete the given goal.",
      provider,
    });
    const result = await agent.run(task.goal);
    let summary = "";
    for (let i = result.messages.length - 1; i >= 0; i -= 1) {
      const message = result.messages[i];
      if (message && message.role === "assistant") {
        summary = message.text;
        break;
      }
    }
    return { taskId: task.id, status: "pass", summary, artifacts: [] };
  };

  const orchestrator = new Orchestrator({ spawn });
  const report = await orchestrator.execute(plan);

  process.stdout.write(`[orchestrate] goal: ${report.goal}\n`);
  for (const entry of report.subtasks) {
    process.stdout.write(`[${entry.result.status}] ${entry.task.id}: ${entry.result.summary}\n`);
  }
  process.stdout.write(
    `all passed: ${report.allPassed ? "yes" : "no"} (${report.totalDurationMs} ms)\n`,
  );
}
