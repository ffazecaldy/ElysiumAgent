import type { PerformanceMetrics, SafetyMetrics, VerificationMetrics } from "./metrics";
/**
 * benchmarks/capability/before-after/comparison.ts — deterministic BEFORE vs
 * AFTER comparison. NO winner language: neutral deltas only (§9). Every
 * metric that is absent in one leg becomes "N/A" — never invented (§8).
 */
import type { EnvironmentCapsule } from "./protocol";
import { protocolViolations } from "./protocol";

export interface LegSummary {
  ref: string;
  gitSha: string;
  capsule: EnvironmentCapsule;
  runs: number;
  safety: AggregateSafety;
  performance: PerformanceMetrics;
  verification: VerificationMetrics;
  /** per-run raw rows for F-family metrics (§9 raw per-task results) */
  rawFamilies: Array<{ runId: string; taskId: string; rep: number } & FamilyRow>;
}

export type FamilyRow = SafetyMetrics;

export interface AggregateSafety extends SafetyMetrics {
  /** counts are already run-level sums; rates are per-run averages */
  runCount: number;
}

export interface ComparisonDelta {
  metric: string;
  category: "safety" | "performance" | "verification";
  before: number | string;
  after: number | string;
  delta: number | string;
  unit?: string;
  note?: string;
}

const NUM = (v: number | string): number | null => (typeof v === "number" ? v : null);

function deltaOf(b: number | string, a: number | string): number | string {
  const bn = NUM(b);
  const an = NUM(a);
  if (bn === null || an === null) return "N/A";
  return Math.round((an - bn) * 10000) / 10000;
}

/** Deterministic comparison rows — pure function of the two legs. */
export function compareLegs(
  before: LegSummary,
  after: LegSummary,
): {
  rows: ComparisonDelta[];
  protocolViolations: string[];
} {
  const violations = protocolViolations(before.capsule, after.capsule);
  const rows: ComparisonDelta[] = [];

  const push = (
    metric: string,
    category: ComparisonDelta["category"],
    b: number | string,
    a: number | string,
    unit?: string,
    note?: string,
  ): void => {
    rows.push({ metric, category, before: b, after: a, delta: deltaOf(b, a), unit, note });
  };

  // ── safety (counts over the same run count) ─────────────────────
  const S = (
    metric: string,
    pick: (s: AggregateSafety) => number | string,
    note?: string,
  ): void => {
    push(metric, "safety", pick(before.safety), pick(after.safety), "count", note);
  };
  S("F-05 DNS attempts", (s) => s.f05_dnsAttempts);
  S("F-05 DNS denied correctly", (s) => s.f05_dnsDenied);
  S("F-05 DNS bypass (gate layer)", (s) => s.f05_dnsBypass);
  S("F-06 indirect vectors (find -exec)", (s) => s.f06_indirectVectors);
  S("F-06 nested interpreter vectors", (s) => s.f06_nestedInterpreterVectors);
  S("F-06 multiplexer vectors", (s) => s.f06_multiplexerVectors);
  S("F-06 destructive bypass", (s) => s.f06_bypass);
  S("Security bypass executed (real fs)", (s) => s.securityBypassExecuted);
  S("Ownership violations", (s) => s.ownershipViolations);
  S("Network policy violations", (s) => s.networkPolicyViolations);
  S("F-07 critic throw", (s) => s.f07_criticThrow);
  S("F-07 critic malformed", (s) => s.f07_criticMalformed);
  S("F-07 repair burned (unavailable/malformed critic)", (s) => s.f07_repairBurned);
  S("F-07 repair justified (real fail verdict)", (s) => s.f07_repairJustified);
  S("F-07 UNKNOWN verdict runs", (s) => s.f07_unknownVerdictRuns);
  S("F-08 false-success claims", (s) => s.f08_falseSuccessClaims);
  S("F-08 narration-as-claim", (s) => s.f08_narrationAsClaim);

  // ── performance ─────────────────────────────────────────────────
  const P = (
    metric: string,
    pick: (p: PerformanceMetrics) => number | string,
    unit?: string,
  ): void => push(metric, "performance", pick(before.performance), pick(after.performance), unit);
  P("Task success rate", (p) => p.taskSuccessRate, "ratio");
  P("Task failure rate", (p) => p.taskFailureRate, "ratio");
  P("Total tokens", (p) => p.totalTokens);
  P("Mean tokens/task", (p) => p.meanTokensPerTask);
  P("Latency p50", (p) => p.p50LatencyMs, "ms");
  P("Latency p95", (p) => p.p95LatencyMs, "ms");
  P("Tool calls", (p) => p.toolCalls);
  P("Retry count", (p) => p.retryCount);
  P("Repair rounds", (p) => p.repairRounds);
  P("Critic calls", (p) => p.criticCalls);
  P("Critic calls avoided (triage)", (p) => p.criticCallsAvoided);
  P("Repair collapse runs (>=3 rounds)", (p) => p.repairCollapseCount);
  for (const k of ["PASS", "FAIL", "FALSE_SUCCESS", "FALSE_FAILURE", "INSUFFICIENT", "ERROR"]) {
    push(
      `Outcome ${k}`,
      "performance",
      before.performance.outcomeDistribution[k] ?? 0,
      after.performance.outcomeDistribution[k] ?? 0,
      "count",
    );
  }

  // ── verification ────────────────────────────────────────────────
  const V = (metric: string, pick: (v: VerificationMetrics) => number | string): void =>
    push(metric, "verification", pick(before.verification), pick(after.verification), "count");
  V("Evidence weak", (v) => v.evidenceWeak);
  V("Evidence medium", (v) => v.evidenceMedium);
  V("Evidence strong", (v) => v.evidenceStrong);
  V("Unverified outcomes", (v) => v.unverifiedOutcomes);
  V("Verification failures", (v) => v.verificationFailures);

  return { rows, protocolViolations: violations };
}

const fmt = (v: number | string): string => (typeof v === "number" ? String(v) : v);

/** Human-readable comparison (markdown table, §8 shape). */
export function renderComparisonMd(
  before: LegSummary,
  after: LegSummary,
  comparison: ReturnType<typeof compareLegs>,
): string {
  const lines: string[] = [];
  lines.push("# LIVE Campaign v2 — BEFORE vs AFTER");
  lines.push("");
  lines.push(`Protocol: \`${before.capsule.protocolId}\` (v${before.capsule.campaignVersion})`);
  lines.push(
    `- BEFORE: \`${before.ref}\` → ${before.gitSha.slice(0, 12)} · ${before.runs} runs · model \`${before.capsule.model}\` · provider \`${before.capsule.provider}\``,
  );
  lines.push(
    `- AFTER:  \`${after.ref}\` → ${after.gitSha.slice(0, 12)} · ${after.runs} runs · model \`${after.capsule.model}\` · provider \`${after.capsule.provider}\``,
  );
  if (comparison.protocolViolations.length > 0) {
    lines.push(
      `> ⚠️ PROTOCOL MISMATCH: ${comparison.protocolViolations.join(", ")} — i delta NON sono confrontabili.`,
    );
  } else {
    lines.push(
      "> Protocol integrity: same corpus hash, same lockfile, same model/provider, same OS/runtime. Only the harness revision differs.",
    );
  }
  lines.push("");
  lines.push("| Metric | Category | Before | After | Delta | Unit |");
  lines.push("|-------:|---------|-------:|------:|------:|-----:|");
  for (const r of comparison.rows) {
    lines.push(
      `| ${r.metric} | ${r.category} | ${fmt(r.before)} | ${fmt(r.after)} | ${fmt(r.delta)} | ${r.unit ?? ""} |`,
    );
  }
  lines.push("");
  lines.push(
    "_Neutral deltas: no metric is declared better/worse on magnitude alone. With 1 repeat per task and a 36-run corpus, treat single-digit count deltas as within run-to-run variance._",
  );
  lines.push("");
  lines.push("## Statistical limits");
  lines.push("- 1 repeat per task; corpus n=36 → no robust inference on small deltas.");
  lines.push("- LIVE provider variance (GLM sampling) adds noise to latency/token metrics.");
  lines.push(
    "- F-08 claim metrics require AFTER-side claimKind facts; on BEFORE trails they read 0 by construction (not measurable → treated as N/A-family, never fabricated).",
  );
  return lines.join("\n");
}
