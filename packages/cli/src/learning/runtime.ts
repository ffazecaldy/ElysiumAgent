/**
 * packages/cli/src/learning/runtime.ts — the Learning Layer seam.
 *
 * / Seam del Learning Layer: ingest EvaluationRecords → memoria persistente.
 *
 * OBSERVE-ONLY: recordLearning() converts an EvaluationRecord into a
 * RunRecord and persists it; buildProfileFromDisk() folds history into an
 * AgentPerformanceProfile. Nothing here throws, blocks, or feeds back into
 * the agent loop — future adaptive layers must opt in explicitly.
 */

import type { EvaluationRecord } from "../evaluation";
import { buildProfile, taskClassOf } from "./engine";
import { appendRun, loadStore, saveStore } from "./store";
import type { AgentPerformanceProfile, LearningStoreShape, RunRecord } from "./types";

/** Where the learning memory lives inside a run root / project root. */
export const LEARNING_DIR = ".elysium/learning";

/** Tools worth tracking in the failure-pattern vocabulary. */
const TRACKED_TOOLS = new Set(["bash", "write", "edit", "read", "web_fetch", "web_search"]);

/**
 * Convert an EvaluationRecord into a bounded RunRecord. Pure. Derives the
 * task class from the goal text and the tool/postcondition names from the
 * evidence facts — observed facts only, no inference here.
 */
export function toRunRecord(
  record: EvaluationRecord,
  opts: { goal?: string; retryCount?: number; agentClaim?: string } = {},
): RunRecord {
  const toolsSet = new Set<string>();
  const failed: string[] = [];
  for (const item of record.evidence) {
    const tool = item.facts.tool;
    if (typeof tool === "string" && TRACKED_TOOLS.has(tool)) toolsSet.add(tool);
  }
  for (const p of record.postconditions) {
    if (p.ok === false) failed.push(p.name);
  }
  const tools = [...toolsSet];
  const verifiedPostconditions = record.postconditions.filter((p) => p.ok !== null).length;
  return {
    runId: record.runId,
    at: record.createdAt,
    goal: opts.goal ?? "",
    outcome: record.verdict,
    score: record.score,
    confidence: record.confidence,
    retryCount: opts.retryCount ?? 0,
    taskClass: taskClassOf(opts.goal ?? "", tools),
    tools,
    failedPostconditions: failed,
    evidenceCount: record.evidence.length,
    verifiedPostconditions,
    totalPostconditions: record.postconditions.length,
    ...(opts.agentClaim !== undefined ? { agentClaim: opts.agentClaim } : {}),
  };
}

/**
 * Learning handle bound to a storage dir. All methods are best-effort:
 * corrupted state degrades to empty, persistence failures are silent.
 */
export interface LearningEngine {
  /** Ingest one evaluated run into the persistent memory. */
  recordLearning(
    record: EvaluationRecord,
    opts?: { goal?: string; retryCount?: number; agentClaim?: string },
  ): void;
  /** Load the raw store (facts only). */
  loadStore(): LearningStoreShape;
  /** Fold the whole history into an aggregate profile (deterministic). */
  profile(): AgentPerformanceProfile;
}

/** Re-validation verdict for one strategy against post-strategy history. */
export interface RevalidationVerdict {
  strategyId: string;
  /** New observed failure rate within the strategy's scope. */
  failureRate: number;
  sampleCount: number;
  /** still-reliable | degraded (below policy, watch) | invalidated (contradicted). */
  verdict: "still-reliable" | "degraded" | "invalidated";
  reason: string;
}

export function createLearningEngine(storageRoot: string): LearningEngine {
  const dir = ((): string => {
    try {
      const p = storageRoot.includes(LEARNING_DIR) ? storageRoot : `${storageRoot}/${LEARNING_DIR}`;
      return p.replace(/\\/g, "/");
    } catch {
      return storageRoot;
    }
  })();

  return {
    recordLearning(
      record: EvaluationRecord,
      opts?: { goal?: string; retryCount?: number; agentClaim?: string },
    ): void {
      try {
        const store = loadStore(dir);
        const run = toRunRecord(record, opts);
        saveStore(dir, appendRun(store, run));
      } catch {
        // learning is informative only — never propagate
      }
    },
    loadStore(): LearningStoreShape {
      return loadStore(dir);
    },
    profile(): AgentPerformanceProfile {
      try {
        return buildProfile(loadStore(dir));
      } catch {
        return buildProfile({ version: 1, runs: [], taskClassCounts: {} });
      }
    },
  };
}

/**
 * POST-STRATEGY REVALIDATION (closes the feedback loop): after a strategy has
 * been applied, the runs made SINCE the strategy was approved are re-checked
 * against the strategy's claim. Runs are filtered by `since` timestamp and —
 * when provided — task class. Verdicts:
 * - still-reliable: failure rate in scope is at or below the policy maximum;
 * - degraded:       above the maximum (watch — refresh() will stale it);
 * - invalidated:    claimed failure pattern vanished (no matching failures).
 * Pure over the store; the caller decides what to do with the verdict.
 */
export function revalidateStrategy(
  store: LearningStoreShape,
  input: {
    strategyId: string;
    pattern: string;
    since: string;
    taskClass?: string;
    policy: { maximumConflictRate: number; minimumSamples: number };
  },
): RevalidationVerdict {
  const sinceMs = Date.parse(input.since);
  const inScope = store.runs.filter((r) => {
    const atMs = Date.parse(r.at);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(atMs) || atMs < sinceMs) return false;
    if (input.taskClass !== undefined && r.taskClass !== input.taskClass) return false;
    return true;
  });
  const failing = inScope.filter(
    (r) =>
      r.outcome === "FAIL" ||
      r.outcome === "FALSE_SUCCESS" ||
      r.outcome === "FALSE_FAILURE" ||
      r.score < 1,
  );
  const failureRate = inScope.length > 0 ? failing.length / inScope.length : 0;
  const base = {
    strategyId: input.strategyId,
    failureRate,
    sampleCount: inScope.length,
  };
  if (inScope.length < input.policy.minimumSamples) {
    return {
      ...base,
      verdict: "still-reliable",
      reason: `insufficient post-strategy samples (${inScope.length} < ${input.policy.minimumSamples}) — no re-judgement yet`,
    };
  }
  if (failing.length === 0) {
    return {
      ...base,
      verdict: "invalidated",
      reason: `pattern vanished: ${inScope.length} post-strategy runs, zero matching failures — the strategy's premise no longer holds`,
    };
  }
  if (failureRate > input.policy.maximumConflictRate) {
    return {
      ...base,
      verdict: "degraded",
      reason: `post-strategy failure rate ${failureRate.toFixed(2)} exceeds maximum ${input.policy.maximumConflictRate} — strategy is not paying off`,
    };
  }
  return {
    ...base,
    verdict: "still-reliable",
    reason: `post-strategy failure rate ${failureRate.toFixed(2)} within policy`,
  };
}
