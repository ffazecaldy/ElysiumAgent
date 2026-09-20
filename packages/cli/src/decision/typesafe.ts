/**
 * packages/cli/src/decision/typesafe.ts — TypeSafe Jev (System One) adapter.
 *
 * Raw fetch against POST https://api.typesafe.ai/v1/systemone — no SDK
 * dependency. Key from env (TYPESAFE_API_KEY, never hardcoded). Every
 * failure mode (missing key, timeout, HTTP error, malformed body) resolves
 * to a typed DecisionEvaluation: evaluate() NEVER throws, the run NEVER
 * depends on Jev being reachable.
 *
 * API shape (docs.typesafe.ai): body { model, state, questions }; question
 * types noul/choice/score; answers carry probability / probabilities /
 * confidence per type.
 */

import type {
  ChoiceQuestion,
  DecisionAnswers,
  DecisionEvaluation,
  DecisionProvider,
  DecisionQuestion,
  NoulQuestion,
  ScoreQuestion,
} from "./provider";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 4000;

export interface TypeSafeProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  /** Injected fetch (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Question → API wire shape. Exported for deterministic tests. */
export function questionToWire(id: string, q: DecisionQuestion): Record<string, unknown> {
  if (q.type === "noul") {
    const noul: NoulQuestion = q;
    return { [id]: { type: "noul", instructions: noul.instructions } };
  }
  if (q.type === "choice") {
    const choice: ChoiceQuestion = q;
    return {
      [id]: {
        type: "choice",
        instructions: choice.instructions,
        criteria: choice.criteria,
      },
    };
  }
  const score: ScoreQuestion = q;
  return {
    [id]: {
      type: "score",
      instructions: score.instructions,
      criteria: score.levels,
    },
  };
}

/** Parse the API response body into typed answers. Throws on malformed. */
export function parseSystemOneAnswers(
  body: unknown,
  questions: Record<string, DecisionQuestion>,
): DecisionAnswers {
  if (typeof body !== "object" || body === null || !("answers" in body)) {
    throw new Error("malformed response: missing answers");
  }
  const raw = (body as { answers: unknown }).answers;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("malformed response: answers not an object");
  }
  const answers: DecisionAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    const entry = (raw as Record<string, unknown>)[id];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`malformed response: answer '${id}' missing`);
    }
    const rec = entry as Record<string, unknown>;
    if (question.type === "noul") {
      const p = rec.probability ?? rec.noul;
      if (typeof p !== "number" || !Number.isFinite(p)) {
        throw new Error(`malformed response: answer '${id}' probability`);
      }
      answers[id] = { kind: "noul", probability: p };
    } else {
      const probabilities: Record<string, number> = {};
      const rawDist = rec.probabilities;
      if (typeof rawDist === "object" && rawDist !== null) {
        for (const [k, v] of Object.entries(rawDist as Record<string, unknown>)) {
          if (typeof v === "number") probabilities[k] = v;
        }
      }
      const key = question.type === "choice" ? "choice" : "score";
      const value = rec[key];
      const confidence = rec.confidence;
      if (typeof value !== "string" || typeof confidence !== "number") {
        throw new Error(`malformed response: answer '${id}' ${key}/confidence`);
      }
      answers[id] =
        question.type === "choice"
          ? { kind: "choice", choice: value, probabilities, confidence }
          : { kind: "score", score: value, probabilities, confidence };
    }
  }
  return answers;
}

/** TypeSafe Jev provider (System One). Optional, feature-flagged by key. */
export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly id = "typesafe-jev";

  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: TypeSafeProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.endpoint = options.endpoint ?? process.env.TYPESAFE_API_BASE ?? DEFAULT_ENDPOINT;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
    this.now = options.now ?? Date.now;
  }

  /** True only when a key is configured. No key → provider dormant. */
  available(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async evaluate(
    state: Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionEvaluation> {
    const start = this.now();
    if (!this.available()) {
      return {
        ok: false,
        answers: {},
        errorClass: "no-key",
        latencyMs: 0,
        fallbackReason: "TYPESAFE_API_KEY not configured",
      };
    }
    const questionIds = Object.keys(questions);
    if (questionIds.length === 0) {
      return { ok: true, answers: {}, latencyMs: this.now() - start };
    }

    const wireQuestions: Record<string, unknown> = {};
    for (const id of questionIds) {
      Object.assign(wireQuestions, questionToWire(id, questions[id] as DecisionQuestion));
    }
    const body = JSON.stringify({ model: this.model, state, questions: wireQuestions });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey ?? ""}`,
        },
        body,
        signal: controller.signal,
      });
      const latencyMs = this.now() - start;
      if (!response.ok) {
        return {
          ok: false,
          answers: {},
          errorClass: "http",
          status: response.status,
          latencyMs,
          fallbackReason: `typesafe http ${response.status}`,
        };
      }
      let answers: ReturnType<typeof parseSystemOneAnswers>;
      try {
        answers = parseSystemOneAnswers(await response.json(), questions);
      } catch (err: unknown) {
        return {
          ok: false,
          answers: {},
          errorClass: "malformed",
          status: response.status,
          latencyMs,
          fallbackReason: `typesafe malformed response: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true, answers, status: response.status, latencyMs };
    } catch (err: unknown) {
      const latencyMs = this.now() - start;
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        answers: {},
        errorClass: aborted ? "timeout" : "network",
        latencyMs,
        fallbackReason: aborted
          ? `typesafe timeout after ${this.timeoutMs}ms`
          : `typesafe unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
