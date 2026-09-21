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
  recordLearning(record: EvaluationRecord, opts?: { goal?: string; retryCount?: number }): void;
  /** Load the raw store (facts only). */
  loadStore(): LearningStoreShape;
  /** Fold the whole history into an aggregate profile (deterministic). */
  profile(): AgentPerformanceProfile;
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
    recordLearning(record: EvaluationRecord, opts?: { goal?: string; retryCount?: number }): void {
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
