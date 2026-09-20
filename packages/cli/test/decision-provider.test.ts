/** Decision Layer tests — provider adapter (no internet in tests). */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionQuestion } from "../src/decision/provider";
import {
  TypeSafeDecisionProvider,
  parseSystemOneAnswers,
  questionToWire,
} from "../src/decision/typesafe";

const QUESTIONS: Record<string, DecisionQuestion> = {
  destructive: { type: "noul", instructions: "Would this destroy data?" },
  risk: {
    type: "score",
    instructions: "How risky?",
    levels: ["low", "medium", "high", "critical"],
  },
  action: {
    type: "choice",
    instructions: "What to do?",
    criteria: { allow: "run it", ask: "ask the human", block: "refuse" },
  },
};

const OK_BODY = {
  answers: {
    destructive: { probability: 0.02 },
    risk: {
      score: "low",
      probabilities: { low: 0.8, medium: 0.15, high: 0.04, critical: 0.01 },
      confidence: 0.86,
    },
    action: {
      choice: "allow",
      probabilities: { allow: 0.9, ask: 0.08, block: 0.02 },
      confidence: 0.91,
    },
  },
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: env var must be unset, not set-to-undefined
  delete process.env.TYPESAFE_API_KEY;
});

describe("TypeSafeDecisionProvider", () => {
  it("is unavailable without an API key and never fetches", async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not set-to-undefined
    delete process.env.TYPESAFE_API_KEY;
    const fetchSpy = vi.fn();
    const provider = new TypeSafeDecisionProvider({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(provider.available()).toBe(false);
    const result = await provider.evaluate({ kind: "bash-command" }, QUESTIONS);
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("no-key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is available with a key and posts the wire-shaped request", async () => {
    const fetchSpy = vi.fn(async () => okResponse(OK_BODY));
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(provider.available()).toBe(true);
    const result = await provider.evaluate({ command: "npm test" }, QUESTIONS);
    expect(result.ok).toBe(true);
    expect(result.answers.destructive).toEqual({ kind: "noul", probability: 0.02 });
    expect(result.answers.risk).toMatchObject({ kind: "score", score: "low", confidence: 0.86 });
    expect(result.answers.action).toMatchObject({
      kind: "choice",
      choice: "allow",
      confidence: 0.91,
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      questions: Record<string, unknown>;
    };
    expect(body.model).toBe("jev-latest");
    expect(body.questions.destructive).toEqual({
      type: "noul",
      instructions: "Would this destroy data?",
    });
  });

  it("classifies HTTP errors without throwing", async () => {
    const provider = new TypeSafeDecisionProvider({
      apiKey: "k",
      fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    const result = await provider.evaluate({}, QUESTIONS);
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("http");
    expect(result.status).toBe(401);
  });

  it("classifies malformed bodies without throwing", async () => {
    const provider = new TypeSafeDecisionProvider({
      apiKey: "k",
      fetchImpl: (async () => okResponse({ unexpected: true })) as unknown as typeof fetch,
    });
    const result = await provider.evaluate({}, QUESTIONS);
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("malformed");
  });

  it("classifies timeouts (AbortError) without throwing", async () => {
    const provider = new TypeSafeDecisionProvider({
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })) as unknown as typeof fetch,
    });
    const result = await provider.evaluate({}, QUESTIONS);
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("timeout");
  });

  it("classifies network failures without throwing", async () => {
    const provider = new TypeSafeDecisionProvider({
      apiKey: "k",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const result = await provider.evaluate({}, QUESTIONS);
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("network");
  });

  it("short-circuits empty question sets", async () => {
    const fetchSpy = vi.fn();
    const provider = new TypeSafeDecisionProvider({
      apiKey: "k",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = await provider.evaluate({}, {});
    expect(result.ok).toBe(true);
    expect(result.answers).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("wire + parse helpers", () => {
  it("maps the three question types to the documented wire shape", () => {
    expect(questionToWire("d", QUESTIONS.destructive as DecisionQuestion)).toEqual({
      d: { type: "noul", instructions: "Would this destroy data?" },
    });
    expect(questionToWire("a", QUESTIONS.action as DecisionQuestion)).toEqual({
      a: {
        type: "choice",
        instructions: "What to do?",
        criteria: { allow: "run it", ask: "ask the human", block: "refuse" },
      },
    });
    expect(questionToWire("r", QUESTIONS.risk as DecisionQuestion)).toEqual({
      r: {
        type: "score",
        instructions: "How risky?",
        criteria: ["low", "medium", "high", "critical"],
      },
    });
  });

  it("throws a descriptive error on missing answers (caller converts to fallback)", () => {
    expect(() => parseSystemOneAnswers({ answers: {} }, QUESTIONS)).toThrow(/missing/);
    expect(() => parseSystemOneAnswers(null, QUESTIONS)).toThrow(/malformed/);
  });
});
