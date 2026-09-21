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

/** Text that counts as a success claim (same vocabulary as the evaluator). */
const SUCCESS_CLAIM_RE = /success|succeeded|ok|completato/i;

const TOP_PATTERNS = 8;

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rateOf(runs: RunRecord[], predicate: (r: RunRecord) => boolean): number {
  if (runs.length === 0) return 0;
  return runs.filter(predicate).length / runs.length;
}

/**
 * Claim-vs-outcome classification (the operator's definition):
 * - falseSuccess: the agent CLAIMED success but a verified postcondition failed;
 * - falseFailure: the agent claimed failure/insufficiency but every
 *   verifiable postcondition actually passed.
 * A claim is read from evidence kind='claim' (success language) or from
 * critic passed=true; when no claim exists the run is unclassified and
 * counts in NEITHER rate — no arbitrary thresholds.
 */
export function claimVsOutcome(runs: RunRecord[]): {
  falseSuccess: number;
  falseFailure: number;
  unclassified: number;
} {
  let falseSuccess = 0;
  let falseFailure = 0;
  let unclassified = 0;
  for (const run of runs) {
    const verified = run.verifiedPostconditions;
    const claimedFailure =
      run.outcome === "FAIL" ||
      run.outcome === "INSUFFICIENT" ||
      (run.agentClaim !== undefined && !SUCCESS_CLAIM_RE.test(run.agentClaim));
    if (claimedFailure) {
      if (verified > 0 && verified === run.totalPostconditions) falseFailure += 1;
      else unclassified += 1;
    } else if (run.outcome === "FALSE_SUCCESS") {
      falseSuccess += 1;
    } else if (run.outcome === "PASS") {
      unclassified += 1; // claim + outcome agree — nothing to flag
    } else {
      unclassified += 1;
    }
  }
  return { falseSuccess, falseFailure, unclassified };
}

/** Compute the separated, informative metric block. */
export function computeMetrics(runs: RunRecord[]): PerformanceMetrics {
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
  const classified = claimVsOutcome(runs);
  const total = runs.length;
  return {
    verifiedSuccessRate: rateOf(runs, (r) => r.outcome === "PASS"),
    falseSuccessRate: total > 0 ? classified.falseSuccess / total : 0,
    falseFailureRate: total > 0 ? classified.falseFailure / total : 0,
    postconditionSuccessRate: avg(postOk),
    averageScore: avg(postOk),
    averageConfidence: confidences.length > 0 ? avg(confidences) : null,
    confidenceCalibration: passConf.length > 0 ? avg(passConf) : null,
    retryRate: rateOf(runs, (r) => r.retryCount > 0),
    evidenceCompleteness: total === 0 ? 0 : withEvidence.length / total,
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

/**
 * Deterministic task taxonomy (campaign 3 lesson: first-word classification
 * was too coarse). The class combines the leading verb with the operation
 * surfaced by the evidence tools — still no LLM, just a closed vocabulary.
 */
const TASK_TAXONOMY: Array<{ match: RegExp; klass: string }> = [
  { match: /\b(crea|create|scrivi|write|genera|generate|add)\b/i, klass: "create" },
  { match: /\b(fix|correggi|risolvi|repair|resolve|bug)\b/i, klass: "fix" },
  { match: /\b(test|verifica|verify|copertura|coverage)\b/i, klass: "test" },
  { match: /\b(refactor|riorganizza|sposta|move|rename|rinomina)\b/i, klass: "refactor" },
  { match: /\b(explain|spiega|analizza|analyze|documenta|document)\b/i, klass: "analyze" },
  { match: /\b(rimuovi|remove|delete|elimina|clean|pulisci)\b/i, klass: "remove" },
  { match: /\b(aggiorna|update|modifica|edit|change|cambia)\b/i, klass: "update" },
];

/**
 * Deterministic task class from goal + evidence tools (NO LLM). The leading
 * verb maps through a closed taxonomy; a write/edit tool on a verb-less goal
 * implies "create"; unknown goals degrade to "unknown".
 */
export function taskClassOf(goal: string, tools: string[] = []): string {
  const text = String(goal ?? "");
  for (const entry of TASK_TAXONOMY) {
    if (entry.match.test(text)) return entry.klass;
  }
  const has = (name: string): boolean => tools.includes(name);
  if (has("write") || has("edit")) return "create";
  if (has("web_fetch") || has("web_search")) return "analyze";
  return "unknown";
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
    // Cumulative ingestion counter: lives OUTSIDE the pruned run list, so it
    // can legitimately exceed sampleCount after pruning (documented).
    totalRunsIngested: Math.max(
      runs.length,
      store.taskClassCounts ? Object.values(store.taskClassCounts).reduce((a, b) => a + b, 0) : 0,
    ),
    metrics: computeMetrics(runs),
    taskPatterns,
    failurePatterns: failurePatterns(runs),
    dataSufficient: runs.length >= MIN_SAMPLES_FOR_PROFILE,
    fallbackReason: null,
  };
}
