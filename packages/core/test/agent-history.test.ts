/**
 * Unit tests: `Agent.run()` optional history parameter.
 *
 * When `options.history` is provided, the agent COPIES it and prepends it to
 * the initial conversation, so the provider sees [...history, userPrompt].
 * The caller's array is never mutated, and `turns` / `usage` still count only
 * the turns executed by this run.
 */
import {
  Agent,
  type AgentMessage,
  type LlmProvider,
  type LlmRequest,
  type StreamEvent,
} from "@elysium/core";
import { describe, expect, it } from "vitest";

/** Provider stub that records every request it receives. */
function makeCapturingProvider(): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    id: "capturing-stub",
    stream(request: LlmRequest): AsyncIterable<StreamEvent> {
      // The conversation array is shared and grown in place: snapshot what the
      // provider received at call time.
      requests.push({ ...request, messages: [...request.messages] });
      // Single end_turn turn, no tool calls.
      return (async function* () {
        yield {
          type: "done",
          message: {
            role: "assistant",
            text: "ok",
            toolCalls: [],
            stopReason: "end_turn",
          },
        } satisfies StreamEvent;
      })();
    },
  };
  return { provider, requests };
}

describe("Agent.run with history", () => {
  it("prepends history before the prompt, in order", async () => {
    const { provider, requests } = makeCapturingProvider();
    const agent = new Agent({ systemPrompt: "sys", provider });

    const history: AgentMessage[] = [
      { role: "user", content: "vecchia" },
      { role: "assistant", text: "risposta", toolCalls: [], stopReason: "end_turn" },
    ];

    const result = await agent.run("ciao", { history });

    // Provider received exactly 3 messages in order: history then the prompt.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toHaveLength(3);
    expect(requests[0]?.messages[0]).toEqual({ role: "user", content: "vecchia" });
    expect(requests[0]?.messages[1]).toEqual({
      role: "assistant",
      text: "risposta",
      toolCalls: [],
      stopReason: "end_turn",
    });
    expect(requests[0]?.messages[2]).toEqual({ role: "user", content: "ciao" });

    // The returned transcript contains the 3 messages above, in order, plus
    // the assistant turn produced by this run.
    expect(result.messages).toHaveLength(4);
    expect(result.messages.slice(0, 3).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(result.messages[2]).toEqual({ role: "user", content: "ciao" });
  });

  it("does not mutate or alias the caller's history array", async () => {
    const { provider } = makeCapturingProvider();
    const agent = new Agent({ systemPrompt: "sys", provider });

    const history: AgentMessage[] = [{ role: "user", content: "vecchia" }];
    const snapshot: AgentMessage[] = [...history];

    await agent.run("ciao", { history });

    // The caller's array is untouched by the run.
    expect(history).toEqual(snapshot);
  });

  it("counts turns and usage only for the new turns", async () => {
    const requests: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: "usage-stub",
      stream(request: LlmRequest): AsyncIterable<StreamEvent> {
        requests.push(request);
        return (async function* () {
          yield {
            type: "done",
            message: {
              role: "assistant",
              text: "ok",
              toolCalls: [],
              stopReason: "end_turn",
              usage: { inputTokens: 5, outputTokens: 2 },
            },
          } satisfies StreamEvent;
        })();
      },
    };
    const agent = new Agent({ systemPrompt: "sys", provider });

    const history: AgentMessage[] = [
      { role: "user", content: "vecchia" },
      { role: "assistant", text: "risposta", toolCalls: [], stopReason: "end_turn" },
    ];

    const result = await agent.run("ciao", { history });

    // Exactly ONE provider turn executed by this run (history is not replayed).
    expect(result.turns).toBe(1);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it("behaves identically to the original signature when history is omitted", async () => {
    const { provider, requests } = makeCapturingProvider();
    const agent = new Agent({ systemPrompt: "sys", provider });

    const result = await agent.run("ciao");

    expect(requests[0]?.messages).toEqual([{ role: "user", content: "ciao" }]);
    expect(result.messages).toEqual([
      { role: "user", content: "ciao" },
      { role: "assistant", text: "ok", toolCalls: [], stopReason: "end_turn" },
    ]);
    expect(result.turns).toBe(1);
  });
});
