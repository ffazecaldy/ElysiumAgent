/**
 * Deterministic failure-cause taxonomy for repair loops.
 *
 * `classifyFailure` maps raw failure text (test output, build logs, compiler
 * stderr) onto a closed set of {@link FailureCause} categories using ordered
 * regular expressions. It never throws and never depends on I/O, so it is
 * safe to call on arbitrary log fragments.
 */

/** Closed set of recognized failure causes. */
export type FailureCause =
  | "TEST_FAILURE"
  | "BUILD_FAILURE"
  | "TYPE_ERROR"
  | "MISSING_DEPENDENCY"
  | "SCOPE_VIOLATION"
  | "TOOL_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "ASSERTION_WEAKNESS"
  | "UNKNOWN";

/** Result of classifying a failure text. */
export interface FailureClassification {
  /** Matched cause category. */
  cause: FailureCause;
  /** 0..1 confidence: 1.0 for specific matches, lower on generic fallbacks. */
  confidence: number;
}

interface CauseRule {
  cause: FailureCause;
  regex: RegExp;
  /** Confidence assigned when the rule matches. */
  confidence: number;
}

/**
 * Ordered rules: earlier entries are more specific and win over later
 * generic fallbacks. Confidence degrades from 1.0 (unambiguous signals) to
 * 0.5 (generic "failed"/"error" fallback) and 0.0 (no match => UNKNOWN).
 */
const RULES: readonly CauseRule[] = [
  {
    cause: "MISSING_DEPENDENCY",
    regex:
      /cannot find module|modulenotfounderror|no module named|module not found|unresolved import|peer dep(i|missing)/i,
    confidence: 1.0,
  },
  {
    cause: "SCOPE_VIOLATION",
    regex:
      /outside (of )?(the )?(allowed|permitted|project|workspace|repo(sitory)?) (dir(ectory)?|scope|root)|scope violation|path traversal|file changed outside/i,
    confidence: 1.0,
  },
  {
    cause: "TOOL_FAILURE",
    regex:
      /tool call failed|tool (execution )?error|invalid tool|mcp error|tool_use_error|command not found/i,
    confidence: 1.0,
  },
  {
    cause: "ENVIRONMENT_FAILURE",
    regex:
      /econnrefused|econnreset|etimedout|enotfound|eacces|eperm|enoent|network (error|unreachable)|connection refused|rate limit/i,
    confidence: 1.0,
  },
  {
    cause: "TYPE_ERROR",
    regex:
      /typeerror|type error|mismatched types|ts\d{4,}:|property .* does not exist|not assignable/i,
    confidence: 1.0,
  },
  {
    cause: "BUILD_FAILURE",
    regex:
      /compilation failed|build failed|failed to compile|webpack|bundler? error|linker error|syntaxerror/i,
    confidence: 1.0,
  },
  {
    cause: "ASSERTION_WEAKNESS",
    regex:
      /assertionerror|expect\(|assert true|assertion (failed|error)|expected .* (but )?(got|to be)/i,
    confidence: 0.9,
  },
  {
    cause: "TEST_FAILURE",
    regex: /\d+ (tests? )?(failed|failing)|test(s)? failed|failing tests?/i,
    confidence: 0.9,
  },
  { cause: "TEST_FAILURE", regex: /\b(failed|error)\b/i, confidence: 0.5 },
];

/**
 * Classify raw failure text deterministically.
 *
 * @param text - Raw failure output (log fragment, compiler stderr, ...).
 * @returns The matched cause with a confidence score; `UNKNOWN` with
 * confidence 0 when no rule matches. Empty/blank input also yields `UNKNOWN`.
 */
export function classifyFailure(text: string): FailureClassification {
  if (!text || text.trim().length === 0) {
    return { cause: "UNKNOWN", confidence: 0 };
  }
  for (const rule of RULES) {
    if (rule.regex.test(text)) {
      return { cause: rule.cause, confidence: rule.confidence };
    }
  }
  return { cause: "UNKNOWN", confidence: 0 };
}
