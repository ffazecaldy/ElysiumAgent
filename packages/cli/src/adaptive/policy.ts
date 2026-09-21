/**
 * packages/cli/src/adaptive/policy.ts — the deterministic Reliability Gate.
 *
 * / Reliability Gate deterministico e revisionabile: nessuna soglia nascosta.
 *
 * Pure function over (PatternCandidate, StrategyReliabilityPolicy). No LLM,
 * no hidden thresholds: every requirement and its outcome are returned so
 * the audit trail can show WHY a strategy passed or was rejected.
 */

import type { PatternCandidate, StrategyReliabilityPolicy } from "./types";

export interface ReliabilityVerdict {
  reliable: boolean;
  /** 0..1 deterministic blend (pattern rate + evidence completeness). */
  score: number;
  reasons: string[];
}

/**
 * Gate a candidate pattern against the policy. One single run is never a
 * reliable strategy; a conflicting pattern is never approved.
 */
export function evaluateReliability(
  candidate: PatternCandidate,
  policy: StrategyReliabilityPolicy,
): ReliabilityVerdict {
  const reasons: string[] = [];
  let ok = true;

  if (candidate.sampleCount < policy.minimumSamples) {
    ok = false;
    reasons.push(
      `samples ${candidate.sampleCount} < minimum ${policy.minimumSamples} (one run is never a strategy)`,
    );
  }
  if (candidate.patternRate < policy.minimumPatternRate) {
    ok = false;
    reasons.push(
      `pattern rate ${candidate.patternRate.toFixed(2)} < minimum ${policy.minimumPatternRate}`,
    );
  }
  if (candidate.meanConfidence !== null && candidate.meanConfidence < policy.minimumConfidence) {
    ok = false;
    reasons.push(
      `mean confidence ${candidate.meanConfidence.toFixed(2)} < minimum ${policy.minimumConfidence}`,
    );
  }
  if (candidate.evidenceCompleteness < policy.minimumEvidenceCompleteness) {
    ok = false;
    reasons.push(
      `evidence completeness ${candidate.evidenceCompleteness.toFixed(2)} < minimum ${policy.minimumEvidenceCompleteness}`,
    );
  }
  if (candidate.conflictRate > policy.maximumConflictRate) {
    ok = false;
    reasons.push(
      `conflict rate ${candidate.conflictRate.toFixed(2)} > maximum ${policy.maximumConflictRate} (conflicting pattern)`,
    );
  }

  // Deterministic blend — informative, the decision is the threshold list above.
  const score = Number(
    Math.min(1, candidate.patternRate * 0.7 + candidate.evidenceCompleteness * 0.3).toFixed(3),
  );
  return { reliable: ok, score, reasons };
}
