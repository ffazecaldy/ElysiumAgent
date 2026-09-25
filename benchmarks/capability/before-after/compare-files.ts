import type { SwarmEvent } from "../../../packages/cli/src/swarm-mode";
import {
  type AggregateSafety,
  type ComparisonDelta,
  type FamilyRow,
  type LegSummary,
  compareLegs,
  renderComparisonMd,
} from "./comparison";
import { performanceMetricsOf, safetyMetricsOf, verificationMetricsOf } from "./metrics";
/**
 * benchmarks/capability/before-after/compare-files.ts — aggregates the two
 * per-revision result files into LegSummary objects and produces the
 * deterministic comparison (json + md). Pure functions; no provider calls;
 * used by both the orchestrator (runtime) and the vitest suite (offline).
 */
import type { EnvironmentCapsule } from "./protocol";

export interface RevisionRunFile {
  protocolId: string;
  harnessRoot: string;
  filter: string | null;
  reps: number;
  provider: string;
  model: string;
  corpusId: string;
  startedAt: string;
  runs: Array<Record<string, unknown>>;
}

/** Loose input shape accepted by buildLegSummary (files may come from older
 * revisions with fewer fields). */
export type RevisionRunFileInput = Partial<RevisionRunFile> & { runs?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Malformed run rows are skipped (counted), never crash the comparison. */
export function buildLegSummary(
  ref: string,
  capsule: EnvironmentCapsule,
  file: RevisionRunFileInput,
): { summary: LegSummary; malformedRuns: number } {
  const safetyAgg: AggregateSafety = {
    runCount: 0,
    f05_dnsAttempts: 0,
    f05_dnsDenied: 0,
    f05_dnsBypass: 0,
    f06_indirectVectors: 0,
    f06_nestedInterpreterVectors: 0,
    f06_multiplexerVectors: 0,
    f06_bypass: 0,
    f07_criticThrow: 0,
    f07_criticMalformed: 0,
    f07_repairBurned: 0,
    f07_repairJustified: 0,
    f07_unknownVerdictRuns: 0,
    f08_falseSuccessClaims: 0,
    f08_narrationAsClaim: 0,
    securityBypassExecuted: 0,
    ownershipViolations: 0,
    networkPolicyViolations: 0,
  };
  const perfRows: Array<Record<string, unknown>> = [];
  const rawFamilies: Array<{ runId: string; taskId: string; rep: number } & FamilyRow> = [];
  let malformed = 0;

  const eventsByRun = new Map<string, SwarmEvent[]>();
  const recs: Array<Record<string, unknown>> = [];

  for (const run of Array.isArray(file.runs) ? file.runs : []) {
    if (!isRecord(run) || typeof run.runId !== "string") {
      malformed += 1;
      continue;
    }
    recs.push(run);
    const events = Array.isArray(run.events) ? (run.events as SwarmEvent[]) : [];
    eventsByRun.set(run.runId, events);
    const fam = safetyMetricsOf(
      {
        securityAction: String(run.securityAction ?? "N/A"),
        failedPostconditions: String(run.failedPostconditions ?? ""),
      } as never,
      events,
    );
    rawFamilies.push({
      runId: run.runId,
      taskId: String(run.taskId ?? "?"),
      rep: typeof run.rep === "number" ? run.rep : 0,
      ...fam,
    });
    safetyAgg.f05_dnsAttempts += fam.f05_dnsAttempts;
    safetyAgg.f05_dnsDenied += fam.f05_dnsDenied;
    safetyAgg.f05_dnsBypass += fam.f05_dnsBypass;
    safetyAgg.f06_indirectVectors += fam.f06_indirectVectors;
    safetyAgg.f06_nestedInterpreterVectors += fam.f06_nestedInterpreterVectors;
    safetyAgg.f06_multiplexerVectors += fam.f06_multiplexerVectors;
    safetyAgg.f06_bypass += fam.f06_bypass;
    safetyAgg.f07_criticThrow += fam.f07_criticThrow;
    safetyAgg.f07_criticMalformed += fam.f07_criticMalformed;
    safetyAgg.f07_repairBurned += fam.f07_repairBurned;
    safetyAgg.f07_repairJustified += fam.f07_repairJustified;
    safetyAgg.f07_unknownVerdictRuns += fam.f07_unknownVerdictRuns;
    safetyAgg.f08_falseSuccessClaims += fam.f08_falseSuccessClaims;
    safetyAgg.f08_narrationAsClaim += fam.f08_narrationAsClaim;
    safetyAgg.securityBypassExecuted += fam.securityBypassExecuted;
    safetyAgg.ownershipViolations += fam.ownershipViolations;
    safetyAgg.networkPolicyViolations += fam.networkPolicyViolations;
  }
  safetyAgg.runCount = recs.length;

  const perfRecs = recs.map((run) => ({
    finalOutcome: String(run.finalOutcome ?? "N/A"),
    durationMs: typeof run.durationMs === "number" ? run.durationMs : 0,
    toolCallCount: typeof run.toolCallCount === "number" ? run.toolCallCount : 0,
    retryCount: typeof run.retryCount === "number" ? run.retryCount : 0,
    tokens: typeof run.tokens === "number" ? run.tokens : 0,
    confidence: run.confidence ?? "N/A",
    evaluationVerdict: String(run.evaluationVerdict ?? "MISSING"),
    postconditionsFailed:
      typeof run.postconditionsFailed === "number" ? run.postconditionsFailed : 0,
  })) as never as Array<Parameters<typeof verificationMetricsOf>[0][number]>;

  // performance metrics from the normalized rows (tokens come from the run
  // row directly — both revisions persist them identically)
  const performance = performanceFromRows(recs);
  const verification = verificationMetricsOf(perfRecs);
  void perfRecs;

  return {
    summary: {
      ref,
      gitSha: capsule.gitSha,
      capsule,
      runs: recs.length,
      safety: safetyAgg,
      performance,
      verification,
      rawFamilies,
    },
    malformedRuns: malformed,
  };
}

function performanceFromRows(recs: Array<Record<string, unknown>>): LegSummary["performance"] {
  const n = recs.length;
  const dist: Record<string, number> = {};
  const latencies: number[] = [];
  let totalTokens = 0;
  let toolCalls = 0;
  let retries = 0;
  let criticCalls = 0;
  let criticAvoided = 0;
  let repairCollapse = 0;
  let tokensKnown = false;
  for (const run of recs) {
    const outcome = String(run.finalOutcome ?? "N/A");
    dist[outcome] = (dist[outcome] ?? 0) + 1;
    latencies.push(typeof run.durationMs === "number" ? run.durationMs : 0);
    // tokens: run row first, fall back to the event trail (older rows)
    let toks = typeof run.tokens === "number" ? run.tokens : 0;
    const events = Array.isArray(run.events) ? (run.events as SwarmEvent[]) : [];
    if (toks === 0) {
      for (const e of events) {
        if (isRecord(e) && e.type === "task_ended" && isRecord(e.data.tokens)) {
          const t = e.data.tokens as { inputTokens?: unknown; outputTokens?: unknown };
          toks += typeof t.inputTokens === "number" ? t.inputTokens : 0;
          toks += typeof t.outputTokens === "number" ? t.outputTokens : 0;
        }
      }
    }
    if (toks > 0) tokensKnown = true;
    totalTokens += toks;
    toolCalls += typeof run.toolCallCount === "number" ? run.toolCallCount : 0;
    retries += typeof run.retryCount === "number" ? run.retryCount : 0;
    criticCalls += events.filter(
      (e) => isRecord(e) && e.type === "critic" && (e.data as { phase?: unknown }).phase === "end",
    ).length;
    criticAvoided += events.filter(
      (e) => isRecord(e) && e.type === "critic" && (e.data as { phase?: unknown }).phase === "skip",
    ).length;
    if (events.filter((e) => isRecord(e) && e.type === "repair").length >= 3) repairCollapse += 1;
  }
  latencies.sort((a, b) => a - b);
  const round4 = (x: number): number => Math.round(x * 10000) / 10000;
  const pctl = (p: number): number => {
    if (latencies.length === 0) return 0;
    const idx = Math.min(
      latencies.length - 1,
      Math.max(0, Math.ceil((p / 100) * latencies.length) - 1),
    );
    const v = latencies[idx];
    return typeof v === "number" ? v : 0;
  };
  return {
    taskSuccessRate: n === 0 ? "N/A" : round4((dist.PASS ?? 0) / n),
    taskFailureRate: n === 0 ? "N/A" : round4(((dist.FAIL ?? 0) + (dist.ERROR ?? 0)) / n),
    outcomeDistribution: dist,
    totalTokens: tokensKnown ? totalTokens : "N/A",
    meanTokensPerTask: tokensKnown && n > 0 ? Math.round(totalTokens / n) : "N/A",
    p50LatencyMs: n ? pctl(50) : "N/A",
    p95LatencyMs: n ? pctl(95) : "N/A",
    toolCalls,
    retryCount: retries,
    repairRounds: retries,
    criticCalls,
    criticCallsAvoided: criticAvoided > 0 ? criticAvoided : "N/A",
    repairCollapseCount: repairCollapse,
  };
}

export function compareLegsFromFiles(
  before: {
    leg: string;
    dir: string;
    ref: string;
    runs: RevisionRunFileInput;
    capsule: EnvironmentCapsule;
  },
  after: {
    leg: string;
    dir: string;
    ref: string;
    runs: RevisionRunFileInput;
    capsule: EnvironmentCapsule;
  },
): { json: Record<string, unknown>; md: string } {
  const beforeFile = before.runs as RevisionRunFileInput;
  const afterFile = after.runs as RevisionRunFileInput;
  const b = buildLegSummary(before.ref, before.capsule, beforeFile);
  const a = buildLegSummary(after.ref, after.capsule, afterFile);
  const comparison = compareLegs(b.summary, a.summary);
  const md = renderComparisonMd(b.summary, a.summary, comparison);
  return {
    json: {
      protocol: {
        beforeRef: before.ref,
        afterRef: after.ref,
        protocolViolations: comparison.protocolViolations,
      },
      before: {
        gitSha: b.summary.gitSha,
        runs: b.summary.runs,
        malformedRuns: b.malformedRuns,
        safety: b.summary.safety,
        performance: b.summary.performance,
        verification: b.summary.verification,
      },
      after: {
        gitSha: a.summary.gitSha,
        runs: a.summary.runs,
        malformedRuns: a.malformedRuns,
        safety: a.summary.safety,
        performance: a.summary.performance,
        verification: a.summary.verification,
      },
      rows: comparison.rows as unknown as ComparisonDelta[],
      rawFamilies: { before: b.summary.rawFamilies, after: a.summary.rawFamilies },
    },
    md,
  };
}
