/**
 * packages/cli/test/before-after-comparison.test.ts — offline tests for the
 * LIVE Campaign v2 comparison layer. NO provider calls: runs/events are
 * synthetic fixtures exercising the metric extraction, protocol integrity
 * checks, delta math and malformed-input handling.
 */
import { describe, expect, it } from "vitest";
import {
  buildLegSummary,
  compareLegsFromFiles,
} from "../../../benchmarks/capability/before-after/compare-files";
import type { EnvironmentCapsule } from "../../../benchmarks/capability/before-after/protocol";
import { protocolViolations } from "../../../benchmarks/capability/before-after/protocol";

function capsule(overrides: Partial<EnvironmentCapsule> = {}): EnvironmentCapsule {
  return {
    campaignVersion: 2,
    protocolId: "live-campaign-v2",
    os: { platform: "win32", release: "10", arch: "x64" },
    runtime: { node: "v24.0.0" },
    packageManager: { name: "pnpm", version: "12.3.4" },
    lockfileHash: "lock-A",
    corpusHash: "corpus-A",
    configHash: "cfg-A",
    gitSha: "0".repeat(40),
    gitRef: "a9060f3",
    harnessRevision: "a9060f3",
    model: "glm-5.3-flash",
    provider: "live",
    startedAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

/** Synthetic trail events for one run. */
function events(
  opts: {
    dnsAttempt?: boolean;
    dnsBlocked?: boolean;
    criticThrow?: boolean;
    criticMalformed?: boolean;
    criticFail?: boolean;
    repairs?: number;
    tokens?: [number, number];
  } = {},
): unknown[] {
  const out: unknown[] = [];
  if (opts.dnsAttempt === true) {
    out.push({
      type: "custom",
      data: {
        kind: "security_event",
        source: "policy",
        facts: {
          tool: "nslookup",
          blocked: opts.dnsBlocked === true,
          reason: "DNS command not allowed: nslookup",
        },
      },
    });
  }
  if (opts.criticThrow === true) {
    out.push({ type: "error", data: { scope: "critic", message: "critic LLM call failed: 500" } });
    out.push({
      type: "critic",
      data: {
        taskId: "t1",
        phase: "end",
        passed: true,
        gaps: ["critic unavailable (UNKNOWN): 500"],
      },
    });
  }
  if (opts.criticMalformed === true) {
    out.push({
      type: "critic",
      data: {
        taskId: "t1",
        phase: "end",
        passed: true,
        gaps: ["critic response was not valid JSON"],
      },
    });
  }
  if (opts.criticFail === true) {
    out.push({ type: "critic", data: { taskId: "t1", phase: "end", passed: false, gaps: [] } });
  }
  for (let i = 0; i < (opts.repairs ?? 0); i += 1)
    out.push({ type: "repair", data: { taskId: "t1", round: i + 1 } });
  if (opts.tokens !== undefined) {
    out.push({
      type: "task_ended",
      data: { taskId: "t1", tokens: { inputTokens: opts.tokens[0], outputTokens: opts.tokens[1] } },
    });
  }
  out.push({ type: "done", data: { allPassed: true } });
  return out;
}

function runFile(runs: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    protocolId: "live-campaign-v2",
    harnessRoot: "x",
    filter: null,
    reps: 1,
    provider: "live",
    model: "glm-5.3-flash",
    corpusId: "taskdefs@candidate",
    startedAt: "2026-09-24T10:00:00.000Z",
    runs,
  };
}

const baseRun = {
  runId: "cap-a01-r1",
  taskId: "T-A01",
  rep: 1,
  category: "simple",
  finalOutcome: "PASS",
  agentClaim: "done, tests pass",
  evaluationVerdict: "PASS",
  score: 1,
  confidence: 0.9,
  evidenceCount: 3,
  postconditionsPassed: 2,
  postconditionsFailed: 0,
  failedPostconditions: "",
  toolCallCount: 4,
  durationMs: 1200,
  tokens: 0,
  securityAction: "NONE",
  securityBlocked: false,
};

describe("before-after comparison layer (offline)", () => {
  it("capsule integrity: identical capsules pass, corpus/model drift is flagged", () => {
    const a = capsule();
    const b = capsule();
    expect(protocolViolations(a, b)).toEqual([]);
    expect(protocolViolations(a, capsule({ corpusHash: "corpus-B" }))).toEqual(["corpusHash"]);
    expect(protocolViolations(a, capsule({ model: "other" }))).toEqual(["model"]);
    expect(protocolViolations(a, capsule({ lockfileHash: "lock-B" }))).toContain("lockfileHash");
  });

  it("F-05 metrics: DNS attempt blocked vs unblocked counted from trail facts", () => {
    const blocked = buildLegSummary(
      "a9060f3",
      capsule(),
      runFile([
        { ...baseRun, runId: "r1", events: events({ dnsAttempt: true, dnsBlocked: true }) },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(blocked.summary.safety.f05_dnsAttempts).toBe(1);
    expect(blocked.summary.safety.f05_dnsDenied).toBe(1);
    expect(blocked.summary.safety.f05_dnsBypass).toBe(0);

    const bypassed = buildLegSummary(
      "a9060f3",
      capsule(),
      runFile([
        { ...baseRun, runId: "r1", events: events({ dnsAttempt: true, dnsBlocked: false }) },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(bypassed.summary.safety.f05_dnsBypass).toBe(1);
  });

  it("F-07 metrics: critic throw with repair = burned; real fail verdict = justified", () => {
    const burned = buildLegSummary(
      "a9060f3",
      capsule(),
      runFile([
        { ...baseRun, runId: "r1", events: events({ criticThrow: true, repairs: 1 }) },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(burned.summary.safety.f07_criticThrow).toBe(1);
    expect(burned.summary.safety.f07_repairBurned).toBe(1);
    expect(burned.summary.safety.f07_repairJustified).toBe(0);

    const justified = buildLegSummary(
      "a9060f3",
      capsule(),
      runFile([
        { ...baseRun, runId: "r1", events: events({ criticFail: true, repairs: 1 }) },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(justified.summary.safety.f07_repairJustified).toBe(1);
    expect(justified.summary.safety.f07_repairBurned).toBe(0);
  });

  it("F-08 metrics: narration-as-claim and false-success claim counters", () => {
    const leg = buildLegSummary(
      "15228f8",
      capsule(),
      runFile([
        {
          ...baseRun,
          runId: "r1",
          events: [
            {
              type: "custom",
              data: {
                kind: "claim",
                facts: { claimKind: "SUCCESS", claimSource: "status", status: "fail" },
              },
            },
          ],
        },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(leg.summary.safety.f08_falseSuccessClaims).toBe(1);
    expect(leg.summary.safety.f08_narrationAsClaim).toBe(1);
  });

  it("deterministic deltas: before/after rows computed identically across invocations", () => {
    const beforeFile = runFile([
      {
        ...baseRun,
        runId: "r1",
        events: events({
          dnsAttempt: true,
          dnsBlocked: false,
          criticThrow: true,
          repairs: 2,
          tokens: [100, 50],
        }),
      },
    ] as never as Array<Record<string, unknown>>);
    const afterFile = runFile([
      {
        ...baseRun,
        runId: "r1",
        events: events({ dnsAttempt: true, dnsBlocked: true, repairs: 0, tokens: [80, 40] }),
      },
    ] as never as Array<Record<string, unknown>>);
    const args = {
      before: {
        leg: "before",
        dir: "d",
        ref: "a9060f3",
        runs: beforeFile,
        capsule: capsule({ gitRef: "a9060f3" }),
      },
      after: {
        leg: "after",
        dir: "d",
        ref: "15228f8",
        runs: afterFile,
        capsule: capsule({ gitRef: "15228f8", gitSha: "1".repeat(40), harnessRevision: "15228f8" }),
      },
    };
    const r1 = compareLegsFromFiles(args.before, args.after);
    const r2 = compareLegsFromFiles(args.before, args.after);
    expect(r1.json).toEqual(r2.json); // deterministic
    const rows = r1.json.rows as Array<{
      metric: string;
      before: number | string;
      after: number | string;
      delta: number | string;
    }>;
    const dns = rows.find((r) => r.metric === "F-05 DNS bypass (gate layer)");
    expect(dns?.before).toBe(1);
    expect(dns?.after).toBe(0);
    expect(dns?.delta).toBe(-1);
    const tokens = rows.find((r) => r.metric === "Total tokens");
    expect(tokens?.before).toBe(150);
    expect(tokens?.after).toBe(120);
    // same corpus+model → no protocol violations despite different git refs
    expect((r1.json.protocol as { protocolViolations: string[] }).protocolViolations).toEqual([]);
  });

  it("missing metric → N/A (no invented values)", () => {
    const legNoTokens = runFile([
      { ...baseRun, runId: "r1", tokens: 0, events: [] },
    ] as never as Array<Record<string, unknown>>);
    const legTokens = runFile([
      { ...baseRun, runId: "r1", tokens: 500, events: [] },
    ] as never as Array<Record<string, unknown>>);
    const r = compareLegsFromFiles(
      { leg: "before", dir: "d", ref: "b", runs: legNoTokens, capsule: capsule() },
      {
        leg: "after",
        dir: "d",
        ref: "a",
        runs: legTokens,
        capsule: capsule({ gitSha: "1".repeat(40) }),
      },
    );
    const rows = r.json.rows as Array<{ metric: string; before: number | string }>;
    expect(rows.find((row) => row.metric === "Total tokens")?.before).toBe("N/A");
  });

  it("malformed run rows are skipped and counted, not fatal", () => {
    const leg = buildLegSummary(
      "x",
      capsule(),
      runFile([
        null,
        { noRunId: true },
        { ...baseRun, runId: "r-ok", events: [] },
      ] as never as Array<Record<string, unknown>>),
    );
    expect(leg.malformedRuns).toBe(2);
    expect(leg.summary.runs).toBe(1);
  });

  it("no data mixing: separate legs keep separate rawFamilies", () => {
    const r = compareLegsFromFiles(
      {
        leg: "before",
        dir: "d",
        ref: "b",
        runs: runFile([
          {
            ...baseRun,
            runId: "b1",
            taskId: "T-SEC03",
            events: events({ dnsAttempt: true, dnsBlocked: false }),
          },
        ]),
        capsule: capsule(),
      },
      {
        leg: "after",
        dir: "d",
        ref: "a",
        runs: runFile([
          {
            ...baseRun,
            runId: "a1",
            taskId: "T-SEC03",
            events: events({ dnsAttempt: true, dnsBlocked: true }),
          },
        ]),
        capsule: capsule({ gitSha: "1".repeat(40) }),
      },
    );
    const raw = r.json.rawFamilies as {
      before: Array<{ runId: string }>;
      after: Array<{ runId: string }>;
    };
    expect(raw.before.map((x) => x.runId)).toEqual(["b1"]);
    expect(raw.after.map((x) => x.runId)).toEqual(["a1"]);
  });

  it("markdown report renders the required table with both legs", () => {
    const r = compareLegsFromFiles(
      {
        leg: "before",
        dir: "d",
        ref: "b",
        runs: runFile([{ ...baseRun, runId: "b1", events: [] }]),
        capsule: capsule(),
      },
      {
        leg: "after",
        dir: "d",
        ref: "a",
        runs: runFile([{ ...baseRun, runId: "a1", events: [] }]),
        capsule: capsule({ gitSha: "1".repeat(40) }),
      },
    );
    const md = r.md;
    expect(md).toContain("| Metric | Category | Before | After | Delta | Unit |");
    expect(md).toContain("F-05 DNS attempts");
    expect(md).toContain("F-06");
    expect(md).toContain("F-07");
    expect(md).toContain("F-08");
    expect(md).toContain("Statistical limits");
  });
});
