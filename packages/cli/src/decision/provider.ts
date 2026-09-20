/**
 * packages/cli/src/decision/provider.ts — DecisionProvider seam.
 *
 * The decision coprocessor abstraction: deterministic rules first, a
 * System-One-style semantic judgment second, Elysium policy last. The rest
 * of the harness depends on THIS interface, never on TypeSafe directly.
 * Providers are optional and must degrade gracefully: `available() === false`
 * → the harness keeps its historical behavior unchanged.
 */

/** A Noul question: "is this statement true?" → probability 0..1. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** A Choice question: pick one option from a closed set. */
export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<string, string>;
}

/** A Score question: place the state on an ordered rubric (2..10 levels). */
export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly levels: string[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Answers keyed by question id. */
export type DecisionAnswers = Record<string, DecisionAnswer>;

export type DecisionAnswer =
  | { kind: "noul"; probability: number }
  | { kind: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { kind: "score"; score: string; probabilities: Record<string, number>; confidence: number };

/** One evaluate() call outcome, with operational metadata for telemetry. */
export interface DecisionEvaluation {
  ok: boolean;
  answers: DecisionAnswers;
  /** Error class when ok === false: "no-key" | "timeout" | "http" | "malformed" | "network". */
  errorClass?: string;
  /** HTTP status when available. */
  status?: number;
  /** Round-trip latency in ms (measured even on failures). */
  latencyMs: number;
  /** Human-readable fallback reason for the decision record. */
  fallbackReason?: string;
}

/** The seam. Implementations MUST never throw from evaluate(). */
export interface DecisionProvider {
  readonly id: string;
  available(): Promise<boolean> | boolean;
  evaluate(
    state: Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionEvaluation>;
}

/** Always-unavailable provider: the harness fallback when no backend is set. */
export class NullDecisionProvider implements DecisionProvider {
  readonly id = "null";

  available(): boolean {
    return false;
  }

  async evaluate(): Promise<DecisionEvaluation> {
    return {
      ok: false,
      answers: {},
      errorClass: "no-key",
      latencyMs: 0,
      fallbackReason: "decision provider not configured",
    };
  }
}
