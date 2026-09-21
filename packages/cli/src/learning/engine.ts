/**
 * packages/cli/src/learning/engine.ts — deterministic aggregation engine.
 *
 * / Motore di aggregazione deterministico: fatti → metriche → pattern.
 *
 * No LLM at this level (by design): the profile is pure statistics over the
 * stored runs. Facts (RunRecord) and inferences (LearnedPattern) are distinct
 * types — a pattern never re-enters the store as a fact.
 */

import type {
  AgentPerformanceProfile,
  LearnedPattern,
  LearningStoreShape,
  PerformanceMetrics,
  RunRecord,
} from "./types";
import { MIN_SAMPLES_FOR_PROFILE } from "./types";

const TOP_PATTERNS = 8;

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rateOf(runs: RunRecord[], predicate: (r: RunRecord) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(predicate).length / runs.length;
}

/** Compute the separated, informative metric block. */
export function computeMetrics(runs: RunRecord[]): PerformanceMetrics {
  const verified = runs.filter((r) => r.outcome === "PASS" || r.outcome === "FALSE_SUCCESS");
  const confidences = runs
    .map((r) => r.confidence)
    .filter((c): c is number => typeof c === "number");
  // Calibration: among PASS runs, mean confidence (how much it "believed").
  const passRuns = runs.filter((r) => r.outcome === "PASS");
  const passConf = passRuns
    .map((r) => r.confidence)
    .filter((c): c is number => typeof c === "number");
  const withEvidence = runs.filter((r) => r.evidenceCount > 0);
  const postOk = runs.map((r) => r.score);
  return {
    verifiedSuccessRate: rateOf(runs, (r) => r.outcome === "PASS"),
    falseSuccessRate: rateOf(runs, (r) => r.outcome === "FALSE_SUCCESS"),
    // FALSE_FAILURE is not a runtime verdict in v1: proxy = FAIL with score >= 0.5
    // (verified half-good but concluded failed) — flagged as informative only.
    falseFailureRate: rateOf(runs, (r) => r.outcome === "FAIL" && r.score >= 0.5),
    postconditionSuccessRate: avg(postOk),
    averageScore: avg(postOk),
    averageConfidence: confidences.length > 0 ? avg(confidences) : null,
    confidenceCalibration: passConf.length > 0 ? avg(passConf) : null,
    retryRate: rateOf(runs, (r) => r.retryCount > 0),
    evidenceCompleteness: runs.length === 0 ? 0 : withEvidence.length / runs.length,
  };
}

/** Group runs by a string key and build patterns with share rates. */
function buildPatterns(
  runs: RunRecord[],
  keyOf: (r: RunRecord) => string | null,
  summarize: (r: RunRecord[], key: string) => string,
): LearnedPattern[] {
  const buckets = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const key = keyOf(run);
    if (key === null) continue;
    const list = buckets.get(key) ?? [];
    list.push(run);
    buckets.set(key, list);
  }
  const patterns: LearnedPattern[] = [];
  for (const [key, group] of buckets) {
    patterns.push({
      key,
      summary: summarize(group, key),
      sampleCount: group.length,
      rate: runs.length > 0 ? group.length / runs.length : 0,
      lastSeenAt: group[group.length - 1]?.at ?? new Date(0).toISOString(),
    });
  }
  return patterns.sort((a, b) => b.sampleCount - a.sampleCount).slice(0, TOP_PATTERNS);
}

/** Task-class pattern key: the leading verb-ish word of the goal, bounded. */
export function taskClassOf(goal: string): string {
  const word = String(goal ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0]
    ?.replace(/[^a-z0-9à-ú]/g, "");
  return word && word.length > 0 ? word.slice(0, 40) : "unknown";
}

/** Derive failure patterns: failed postcondition names, tools on FAIL runs. */
function failurePatterns(runs: RunRecord[]): LearnedPattern[] {
  const failedRuns = runs.filter((r) => r.outcome === "FAIL" || r.outcome === "FALSE_SUCCESS");
  const byPost = buildPatterns(
    failedRuns,
    (r) => r.failedPostconditions[0] ?? null,
    (group, key) => `failure pattern: postcondition '${key}' failed in ${group.length} run(s)`,
  );
  const byTool = buildPatterns(
    failedRuns,
    (r) => (r.tools.length > 0 ? `tool:${r.tools[0] ?? "?"}` : null),
    (group, key) => `failure pattern: ${key} present in ${group.length} failing run(s)`,
  );
  return [...byPost, ...byTool]
    .sort((a, b) => b.sampleCount - a.sampleCount)
    .slice(0, TOP_PATTERNS);
}

/**
 * Build the aggregate profile from the store. Deterministic, pure, no LLM.
 * `dataSufficient` gates interpretation — below MIN_SAMPLES the profile is
 * informational only.
 */
export function buildProfile(store: LearningStoreShape): AgentPerformanceProfile {
  const runs = store.runs;
  const taskPatterns = buildPatterns(
    runs,
    (r) => (r.taskClass.length > 0 ? `task-class:${r.taskClass}` : null),
    (group, key) =>
      `${key}: ${group.length} run(s) — ${group.filter((g) => g.outcome === "PASS").length} PASS, ` +
      `${group.filter((g) => g.outcome === "FALSE_SUCCESS").length} FALSE_SUCCESS`,
  );
  return {
    version: "perf-v1",
    generatedAt: new Date().toISOString(),
    sampleCount: runs.length,
    metrics: computeMetrics(runs),
    taskPatterns,
    failurePatterns: failurePatterns(runs),
    dataSufficient: runs.length >= MIN_SAMPLES_FOR_PROFILE,
    fallbackReason: null,
  };
}
