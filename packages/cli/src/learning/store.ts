/**
 * packages/cli/src/learning/store.ts — bounded, versioned, fail-safe store.
 *
 * / Store locale persistente e fail-safe: mai throw, mai crescita infinita.
 *
 * Same guarantees as the rest of the harness (progress.ts atomic writes,
 * evaluation bounds): writes are tmp+rename, reads tolerate corruption by
 * degrading to an empty store, the run list is capped at MAX_STORED_RUNS.
 */

import fs from "node:fs";
import path from "node:path";
import {
  LEARNING_STORE_VERSION,
  type LearningStoreShape,
  MAX_STORED_RUNS,
  type RunRecord,
} from "./types";

/** Bounded copy of one run record (strings capped, lists truncated). */
function boundRun(run: RunRecord): RunRecord {
  const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[capped]` : s);
  return {
    runId: cap(String(run.runId ?? ""), 120),
    at: cap(String(run.at ?? ""), 40),
    goal: cap(String(run.goal ?? ""), 300),
    outcome: run.outcome,
    score: typeof run.score === "number" && Number.isFinite(run.score) ? run.score : 0.5,
    confidence:
      typeof run.confidence === "number" && Number.isFinite(run.confidence) ? run.confidence : null,
    retryCount:
      typeof run.retryCount === "number" && Number.isFinite(run.retryCount)
        ? Math.max(0, Math.trunc(run.retryCount))
        : 0,
    taskClass: cap(String(run.taskClass ?? "unknown"), 60),
    tools: (Array.isArray(run.tools) ? run.tools : []).slice(0, 8).map((t) => cap(String(t), 60)),
    failedPostconditions: (Array.isArray(run.failedPostconditions) ? run.failedPostconditions : [])
      .slice(0, 8)
      .map((t) => cap(String(t), 80)),
    evidenceCount:
      typeof run.evidenceCount === "number" && Number.isFinite(run.evidenceCount)
        ? Math.max(0, Math.trunc(run.evidenceCount))
        : 0,
    verifiedPostconditions:
      typeof run.verifiedPostconditions === "number" && Number.isFinite(run.verifiedPostconditions)
        ? Math.max(0, Math.trunc(run.verifiedPostconditions))
        : 0,
    totalPostconditions:
      typeof run.totalPostconditions === "number" && Number.isFinite(run.totalPostconditions)
        ? Math.max(0, Math.trunc(run.totalPostconditions))
        : 0,
    ...(typeof run.agentClaim === "string" ? { agentClaim: cap(String(run.agentClaim), 200) } : {}),
  };
}

/** Empty store at the current version. */
export function emptyStore(): LearningStoreShape {
  return { version: LEARNING_STORE_VERSION, runs: [], taskClassCounts: {} };
}

/**
 * Load the store from `dir/learning-store.json`. Corrupt/truncated/wrong-
 * version files degrade to an empty store (fail-safe), never throw.
 */
export function loadStore(dir: string): LearningStoreShape {
  try {
    const file = path.join(dir, "learning-store.json");
    if (!fs.existsSync(file)) return emptyStore();
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return emptyStore();
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== LEARNING_STORE_VERSION) return emptyStore(); // unknown shape → reset
    if (!Array.isArray(raw.runs)) return emptyStore();
    const runs = raw.runs
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .slice(-MAX_STORED_RUNS)
      .map((r) => boundRun(r as unknown as RunRecord));
    const counts: Record<string, number> = {};
    if (typeof raw.taskClassCounts === "object" && raw.taskClassCounts !== null) {
      for (const [k, v] of Object.entries(raw.taskClassCounts as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) counts[k.slice(0, 60)] = v;
      }
    }
    return { version: LEARNING_STORE_VERSION, runs, taskClassCounts: counts };
  } catch {
    return emptyStore();
  }
}

/**
 * Atomically persist the store (tmp + rename, progress.ts contract). Oldest
 * runs beyond MAX_STORED_RUNS are pruned. Never throws — persistence is
 * best-effort by contract (the caller is OBSERVE-ONLY).
 */
export function saveStore(dir: string, store: LearningStoreShape): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const pruned: LearningStoreShape = {
      ...store,
      version: LEARNING_STORE_VERSION,
      runs: store.runs.slice(-MAX_STORED_RUNS).map(boundRun),
    };
    const file = path.join(dir, "learning-store.json");
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    // persistence failure degrades silently — memory is informative only
  }
}

/** Cumulative ingestion counter (survives pruning; documented: ≥ runs.length). */
export interface CumulativeCounts {
  totalRunsIngested: number;
}

/** Append one run (dedup by runId: re-ingesting the same run is a no-op). */
export function appendRun(
  store: LearningStoreShape,
  run: RunRecord,
  cumulative: CumulativeCounts = { totalRunsIngested: 0 },
): LearningStoreShape & { cumulative: CumulativeCounts } {
  const isNew = !store.runs.some((r) => r.runId === run.runId);
  const bounded = boundRun(run);
  const counts = { ...store.taskClassCounts };
  if (isNew) counts[bounded.taskClass] = (counts[bounded.taskClass] ?? 0) + 1;
  return {
    ...store,
    runs: isNew ? [...store.runs, bounded].slice(-MAX_STORED_RUNS) : store.runs,
    taskClassCounts: counts,
    cumulative: {
      totalRunsIngested: cumulative.totalRunsIngested + (isNew ? 1 : 0),
    },
  };
}
