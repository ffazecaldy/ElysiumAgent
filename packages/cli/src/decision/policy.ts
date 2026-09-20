/**
 * packages/cli/src/decision/policy.ts — DecisionPolicy.
 *
 * The authority boundary: DETERMINISTIC decisions always win; the semantic
 * provider (Jev) is evidence, never authority. Combine rules are explicit,
 * thresholds come from config (never hardcoded magic numbers in paths).
 *
 *   HARD/DETERMINISTIC DENY        → DENY                (Jev cannot touch it)
 *   deterministic ALLOW + Jev low  → historical behavior (ALLOW)
 *   deterministic ALLOW + Jev unc. → REQUIRE_APPROVAL    (conservative)
 *   deterministic ALLOW + Jev high → REQUIRE_APPROVAL
 *   Jev unavailable                → historical behavior (fail-open)
 */

import type { DecisionEvaluation } from "./provider";

/** Verdicts mirror bash-policy semantics so the gate can adopt them directly. */
export type DecisionVerdict = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

/** Modes: off → provider never consulted; shadow → record only; enforce → policy applies. */
export type DecisionMode = "off" | "shadow" | "enforce";

export interface DecisionPolicyConfig {
  /** Risk score (0..1) at/above which an ALLOW is escalated to approval. */
  escalateAtRisk: number;
  /** Confidence below which the semantic signal is treated as uncertain. */
  uncertainBelow: number;
  /** Noul probability of "obvious pass" at/above which critic triage may skip. */
  skipCriticObviousPass: number;
  /** Confidence required on the triage answers before skipping the critic. */
  skipCriticConfidence: number;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicyConfig = {
  escalateAtRisk: 0.7,
  uncertainBelow: 0.5,
  skipCriticObviousPass: 0.9,
  skipCriticConfidence: 0.8,
};

/** Deterministic risk levels in escalation order (never steps down). */
const LEVEL_ORDER = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof LEVEL_ORDER)[number];

/** Step a deterministic risk level UP (never down) — semantic may only escalate. */
export function escalateRiskLevel(level: RiskLevel): RiskLevel {
  const idx = LEVEL_ORDER.indexOf(level);
  return LEVEL_ORDER[Math.min(idx + 1, LEVEL_ORDER.length - 1)] ?? "high";
}

/** Resolved outcome for one gated decision. */
export interface DecisionOutcome {
  verdict: DecisionVerdict;
  /** Which layer produced it: deterministic always beats semantic. */
  source: "deterministic" | "semantic" | "fallback";
  reason: string;
}

/** Numeric risk distilled from answers (noul probability or score mapping). */
const SCORE_RISK: Record<string, number> = {
  low: 0.15,
  skip: 0.1,
  weak: 0.7,
  moderate: 0.45,
  strong: 0.2,
  very_strong: 0.1,
};

function semanticRiskSignal(
  answers: DecisionEvaluation["answers"],
  config: DecisionPolicyConfig,
): { risk: number; uncertain: boolean } | null {
  const risk = answers.risk;
  const destructive = answers.destructive;
  let signal: number | null = null;
  let confidence = 1;
  if (destructive !== undefined && destructive.kind === "noul") {
    signal = destructive.probability;
  }
  if (risk !== undefined && risk.kind === "score") {
    const mapped = SCORE_RISK[risk.score] ?? 0.5;
    signal = signal === null ? mapped : Math.max(signal, mapped);
    confidence = risk.confidence;
  }
  if (signal === null) return null;
  return { risk: signal, uncertain: confidence < config.uncertainBelow };
}

/**
 * Combine a deterministic verdict with the semantic evaluation.
 * `deterministic` is the historical verdict from BashPolicy/E4/E8 code —
 * DENY from that layer is FINAL. In shadow mode callers pass mode="shadow":
 * the returned outcome equals the deterministic verdict, the semantic
 * outcome rides along in `shadowSemantic` for telemetry only.
 */
export function combineDecision(
  deterministic: DecisionVerdict,
  evaluation: DecisionEvaluation | null,
  mode: DecisionMode,
  config: DecisionPolicyConfig = DEFAULT_DECISION_POLICY,
): { outcome: DecisionOutcome; shadowSemantic: DecisionOutcome | null } {
  // (1) Deterministic DENY is untouchable — in every mode.
  if (deterministic === "DENY") {
    return {
      outcome: {
        verdict: "DENY",
        source: "deterministic",
        reason: "deterministic deny (semantic layer not consulted for the verdict)",
      },
      shadowSemantic: null,
    };
  }
  // (2) No provider / provider failed / mode off → historical behavior.
  if (evaluation === null || !evaluation.ok || mode === "off") {
    return {
      outcome: {
        verdict: deterministic,
        source: "fallback",
        reason:
          evaluation && !evaluation.ok
            ? (evaluation.fallbackReason ?? evaluation.errorClass ?? "provider unavailable")
            : "semantic layer off",
      },
      shadowSemantic: null,
    };
  }

  // (3) Semantic signal exists → compute what it WOULD say.
  const signal = semanticRiskSignal(evaluation.answers, config);
  let semantic: DecisionOutcome;
  if (signal === null) {
    semantic = {
      verdict: deterministic,
      source: "fallback",
      reason: "no semantic answer for this decision type",
    };
  } else if (signal.uncertain) {
    semantic = {
      verdict: deterministic === "ALLOW" ? "REQUIRE_APPROVAL" : deterministic,
      source: "semantic",
      reason: "semantic confidence uncertain → conservative",
    };
  } else if (signal.risk >= config.escalateAtRisk) {
    semantic = {
      verdict: "REQUIRE_APPROVAL",
      source: "semantic",
      reason: `semantic risk ${signal.risk.toFixed(2)} ≥ ${config.escalateAtRisk}`,
    };
  } else {
    semantic = {
      verdict: "ALLOW",
      source: "semantic",
      reason: `semantic risk ${signal.risk.toFixed(2)} < ${config.escalateAtRisk}`,
    };
  }

  // (4) Shadow mode: deterministic verdict wins, semantic recorded alongside.
  if (mode === "shadow") {
    return {
      outcome: {
        verdict: deterministic,
        source: "deterministic",
        reason: "shadow mode: historical behavior preserved",
      },
      shadowSemantic: semantic,
    };
  }

  // (5) Enforce: semantic can only ESCALATE, never relax a deterministic verdict.
  if (
    deterministic === "ALLOW" &&
    (semantic.verdict === "REQUIRE_APPROVAL" || semantic.verdict === "DENY")
  ) {
    return {
      outcome: {
        ...semantic,
        verdict: semantic.verdict === "DENY" ? "REQUIRE_APPROVAL" : semantic.verdict,
        reason: `${semantic.reason} (semantic may only escalate)`,
      },
      shadowSemantic: semantic,
    };
  }
  if (deterministic === "REQUIRE_APPROVAL" && semantic.verdict === "ALLOW") {
    return {
      outcome: {
        verdict: "REQUIRE_APPROVAL",
        source: "deterministic",
        reason: "deterministic approval requirement stands (semantic said allow)",
      },
      shadowSemantic: semantic,
    };
  }
  return { outcome: semantic, shadowSemantic: semantic };
}
