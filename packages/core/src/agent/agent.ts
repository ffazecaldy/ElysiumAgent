/**
 * Agent loop — VARIANT B (lean event-callback).
 *
 * Same public seam as Variant A, optimized for minimal per-turn allocation:
 * - Conversation messages live in one array that is grown in place and handed
 *   to the provider directly (no per-turn copy).
 * - Tool definitions are derived once per `setTools()` call, not per turn.
 * - The small `LlmRequest` envelope is the only object rebuilt each turn,
 *   giving the per-turn snapshot semantics required by docs/architecture.md
 *   §2: config changes made mid-turn apply to the next turn, never the one
 *   already in flight.
 * - Streaming consumers get deltas through the optional `onEvent` callback —
 *   no event-bus subscription required.
 */

import type { ToolCallPart } from "../types/content";
import type {
  AgentMessage,
  AssistantMessage,
  StopReason,
  TokenUsage,
  ToolResultMessage,
} from "../types/messages";
import type { LlmProvider, LlmRequest, ToolDefinition } from "../types/provider";
import type { Tool } from "../types/tools";

/** Lifecycle moments surfaced through `AgentOptions.onEvent`. */
export type AgentEventKind = "turn_start" | "text_delta" | "tool_result" | "turn_end";

/**
 * Lean callback event. `data` is kind-specific:
 * - `turn_start`  → `{ turn: number }`
 * - `text_delta`  → `{ delta: string }`
 * - `tool_result` → `{ message: ToolResultMessage }`
 * - `turn_end`    → `{ turn: number; stopReason: StopReason }`
 */
export interface AgentEvent {
  kind: AgentEventKind;
  data: unknown;
}

/** Options for constructing an `Agent`. */
export interface AgentOptions {
  systemPrompt: string;
  provider: LlmProvider;
  tools?: Tool[];
  /** Maximum provider turns per `run()`; further turns throw. Default 8. */
  maxTurns?: number;
  /** External cancellation signal; aborting it ends the run with `aborted`. */
  signal?: AbortSignal;
  /**
   * Tool execution seam. Called sequentially, once per requested tool call.
   * Default behavior when omitted: throws `no tool executor configured`.
   */
  executeTool?: (call: ToolCallPart, ctx: { signal: AbortSignal }) => Promise<ToolResultMessage>;
  /** Optional streaming callback; invoked synchronously at each lifecycle moment. */
  onEvent?: (e: AgentEvent) => void;
}

/** Outcome of one `Agent.run()` call. */
export interface TurnResult {
  /** Full conversation: the prompt, every assistant turn, every tool result. */
  messages: AgentMessage[];
  stopReason: StopReason;
  /** Number of provider turns executed. */
  turns: number;
  /** Cumulative token usage across all turns. */
  usage: TokenUsage;
}

const DEFAULT_MAX_TURNS = 8;

/** Outcome of executing a batch of tool calls within one turn. */
type ToolExecutionOutcome = "completed" | "aborted";

/** Outcome of streaming one provider turn. */
type StreamedTurn =
  | { kind: "done"; message: AssistantMessage }
  | { kind: "aborted"; partialText: string };

export class Agent {
  #systemPrompt: string;
  readonly #provider: LlmProvider;
  #toolDefinitions: ToolDefinition[];
  readonly #maxTurns: number;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #executeTool: AgentOptions["executeTool"];
  readonly #onEvent: AgentOptions["onEvent"];
  #steerQueue: string[];
  #activeController: AbortController | null;

  constructor(options: AgentOptions) {
    if (typeof options.systemPrompt !== "string" || options.systemPrompt.length === 0) {
      throw new Error("systemPrompt must be a non-empty string");
    }
    if (options.provider === undefined || typeof options.provider.stream !== "function") {
      throw new Error("provider with a stream() method is required");
    }
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new Error("maxTurns must be a positive integer");
    }
    this.#systemPrompt = options.systemPrompt;
    this.#provider = options.provider;
    this.#maxTurns = maxTurns;
    this.#externalSignal = options.signal;
    this.#executeTool = options.executeTool;
    this.#onEvent = options.onEvent;
    this.#toolDefinitions = [];
    this.#steerQueue = [];
    this.#activeController = null;
    this.#rebuildToolDefinitions(options.tools);
  }

  /** Replaces the system prompt; applies from the next turn (snapshot semantics). */
  setSystemPrompt(systemPrompt: string): void {
    if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
      throw new Error("systemPrompt must be a non-empty string");
    }
    this.#systemPrompt = systemPrompt;
  }

  /**
   * Replaces the tool set. Tool definitions are derived once here and reused
   * for every subsequent turn; applies from the next turn (snapshot semantics).
   */
  setTools(tools?: Tool[]): void {
    if (tools !== undefined && !Array.isArray(tools)) {
      throw new Error("tools must be an array or undefined");
    }
    this.#rebuildToolDefinitions(tools);
  }

  /**
   * Queues a user message to be injected between turns. Messages queued during
   * a turn are drained at the start of the next one; a queue non-empty at an
   * `end_turn` keeps the run going so the model answers the new input.
   */
  steer(message: string): void {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error("steer message must be a non-empty string");
    }
    this.#steerQueue.push(message);
  }

  /** Aborts the active run (if any) with stop reason `aborted`. No-op otherwise. */
  abort(): void {
    this.#activeController?.abort();
  }

  /**
   * Runs the agent loop for one prompt.
   *
   * When `options.history` is provided, those messages are COPIED and prepended
   * to the conversation (the caller's array is never mutated), so the provider
   * receives `[...history, userPrompt]`. Everything else is unchanged: `turns`
   * and `usage` count only the turns executed by THIS run, and the per-turn
   * request snapshot semantics stay intact.
   */
  async run(prompt: string, options?: { history?: AgentMessage[] }): Promise<TurnResult> {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error("prompt must be a non-empty string");
    }

    // Internal controller per run: abort() works even without an external
    // signal, and an aborted external signal is bridged onto it.
    const controller = new AbortController();
    this.#activeController = controller;
    const signal = controller.signal;
    const external = this.#externalSignal;
    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (external !== undefined) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    // Single conversation array, grown in place and shared with the provider:
    // no per-turn copying. The request envelope is the per-turn snapshot.
    // Optional history is COPIED in (never aliased), prepended to the prompt.
    const history = options?.history;
    const messages: AgentMessage[] =
      history === undefined
        ? [{ role: "user", content: prompt }]
        : [...history, { role: "user", content: prompt }];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let turns = 0;
    let stopReason: StopReason = "end_turn";

    try {
      while (true) {
        if (signal.aborted) {
          stopReason = "aborted";
          break;
        }
        if (turns >= this.#maxTurns) {
          throw new Error("max turns exceeded");
        }

        // Steering drained between turns (also covers pre-run steer() calls).
        this.#drainSteerQueue(messages);

        turns += 1;
        this.#emit("turn_start", { turn: turns });

        // Per-turn snapshot: built once from the current config; mid-turn
        // config changes cannot mutate this object and apply to the next turn.
        const request: LlmRequest = {
          systemPrompt: this.#systemPrompt,
          messages,
          tools: this.#toolDefinitions,
          signal,
        };

        const streamed = await this.#streamTurn(request, signal, usage);
        if (streamed.kind === "aborted") {
          if (streamed.partialText.length > 0) {
            const partial: AssistantMessage = {
              role: "assistant",
              text: streamed.partialText,
              toolCalls: [],
              stopReason: "aborted",
            };
            messages.push(partial);
          }
          stopReason = "aborted";
          this.#emit("turn_end", { turn: turns, stopReason });
          break;
        }

        const assistant = streamed.message;
        messages.push(assistant);

        if (assistant.toolCalls.length > 0) {
          const outcome = await this.#executeToolCalls(assistant.toolCalls, signal, messages);
          if (outcome === "aborted") {
            stopReason = "aborted";
            this.#emit("turn_end", { turn: turns, stopReason });
            break;
          }
          this.#emit("turn_end", { turn: turns, stopReason: "tool_use" });
          continue;
        }

        if (assistant.stopReason === "end_turn" && this.#steerQueue.length > 0) {
          // steer() arrived during the final turn: run one more turn so the
          // queued input is drained and answered (still bounded by maxTurns).
          this.#emit("turn_end", { turn: turns, stopReason: "end_turn" });
          continue;
        }

        stopReason = assistant.stopReason;
        this.#emit("turn_end", { turn: turns, stopReason });
        break;
      }
    } finally {
      if (external !== undefined) {
        external.removeEventListener("abort", onExternalAbort);
      }
      this.#activeController = null;
    }

    return { messages, stopReason, turns, usage };
  }

  /**
   * Streams one provider turn. Terminal `done` carries the authoritative
   * assembled message, so incremental tool-call accumulation is skipped —
   * only text deltas are consumed (forwarded via `onEvent`).
   */
  async #streamTurn(
    request: LlmRequest,
    signal: AbortSignal,
    usage: TokenUsage,
  ): Promise<StreamedTurn> {
    let text = "";
    let doneMessage: AssistantMessage | null = null;
    try {
      for await (const event of this.#provider.stream(request)) {
        if (signal.aborted) {
          break;
        }
        if (event.type === "text_delta") {
          text += event.delta;
          this.#emit("text_delta", { delta: event.delta });
        } else if (event.type === "done") {
          doneMessage = event.message;
        } else if (event.type === "error") {
          throw event.error;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return { kind: "aborted", partialText: text };
      }
      throw error;
    }
    if (doneMessage === null) {
      if (signal.aborted) {
        return { kind: "aborted", partialText: text };
      }
      throw new Error(`provider "${this.#provider.id}" ended the stream without a done event`);
    }
    if (doneMessage.usage !== undefined) {
      usage.inputTokens += doneMessage.usage.inputTokens;
      usage.outputTokens += doneMessage.usage.outputTokens;
    }
    return { kind: "done", message: doneMessage };
  }

  /** Executes requested tool calls strictly sequentially via the `executeTool` seam. */
  async #executeToolCalls(
    calls: ToolCallPart[],
    signal: AbortSignal,
    messages: AgentMessage[],
  ): Promise<ToolExecutionOutcome> {
    const executor = this.#executeTool;
    if (executor === undefined) {
      throw new Error("no tool executor configured");
    }
    for (const call of calls) {
      if (signal.aborted) {
        return "aborted";
      }
      let result: ToolResultMessage;
      try {
        result = await executor(call, { signal });
      } catch (error) {
        // An executor rejection caused by our own abort ends the run cleanly;
        // any other failure propagates (errors are never swallowed).
        if (signal.aborted) {
          return "aborted";
        }
        throw error;
      }
      messages.push(result);
      this.#emit("tool_result", { message: result });
    }
    return "completed";
  }

  #drainSteerQueue(messages: AgentMessage[]): void {
    while (this.#steerQueue.length > 0) {
      const content = this.#steerQueue.shift();
      if (content === undefined) {
        break;
      }
      const steerMessage: AgentMessage = { role: "user", content };
      messages.push(steerMessage);
    }
  }

  #rebuildToolDefinitions(tools: Tool[] | undefined): void {
    if (tools === undefined) {
      this.#toolDefinitions = [];
      return;
    }
    const definitions: ToolDefinition[] = [];
    for (const tool of tools) {
      definitions.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    this.#toolDefinitions = definitions;
  }

  #emit(kind: AgentEventKind, data: unknown): void {
    const handler = this.#onEvent;
    if (handler !== undefined) {
      handler({ kind, data });
    }
  }
}
