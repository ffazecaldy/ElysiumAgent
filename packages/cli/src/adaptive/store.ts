/**
 * packages/cli/src/adaptive/store.ts — persistent, bounded strategy store.
 *
 * / Store strategie separato dal learning-store: atomico, versionato, safe.
 *
 * Same guarantees as the learning store: tmp+rename writes, corruption →
 * fallback (mode disabled, no strategies), hard cap with oldest-disabled
 * pruning, dedup by strategy id. Never throws.
 */

import fs from "node:fs";
import path from "node:path";
import type { AdaptiveMode, Strategy, StrategyStatus, StrategyStoreShape } from "./types";

export const STRATEGY_STORE_VERSION = 1;
/** Hard cap on stored strategies (bounded — no infinite growth). */
export const MAX_STRATEGIES = 100;

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[capped]` : s);

function boundStrategy(s: unknown): Strategy | null {
  if (typeof s !== "object" || s === null) return null;
  const r = s as Record<string, unknown>;
  const id = typeof r.id === "string" ? cap(r.id, 120) : null;
  const action = (typeof r.action === "object" && r.action !== null ? r.action : {}) as Record<
    string,
    unknown
  >;
  const condition = (
    typeof r.condition === "object" && r.condition !== null ? r.condition : {}
  ) as Record<string, unknown>;
  const reliability = (
    typeof r.reliability === "object" && r.reliability !== null ? r.reliability : {}
  ) as Record<string, unknown>;
  if (
    id === null ||
    typeof action.kind !== "string" ||
    typeof condition.pattern !== "string" ||
    typeof r.sourcePattern !== "string"
  ) {
    return null;
  }
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const iso = (v: unknown): string =>
    typeof v === "string" && v.length > 0 ? cap(v, 40) : new Date(0).toISOString();
  return {
    id,
    version: 1,
    condition: {
      pattern: cap(condition.pattern, 160),
      ...(typeof condition.taskClass === "string"
        ? { taskClass: cap(condition.taskClass, 60) }
        : {}),
      ...(typeof condition.tool === "string" ? { tool: cap(condition.tool, 60) } : {}),
    },
    action: {
      kind: action.kind as Strategy["action"]["kind"],
      ...(typeof action.postcondition === "string"
        ? { postcondition: cap(action.postcondition, 120) }
        : {}),
      ...(typeof action.note === "string" ? { note: cap(action.note, 300) } : {}),
    },
    sourcePattern: cap(r.sourcePattern, 160),
    sampleCount: num(r.sampleCount, 0),
    reliability: {
      score: num(reliability.score, 0),
      sampleCount: num(reliability.sampleCount, 0),
      patternRate: num(reliability.patternRate, 0),
      conflictRate: num(reliability.conflictRate, 0),
      evidenceCompleteness: num(reliability.evidenceCompleteness, 0),
      policyVersion: num(reliability.policyVersion, 0),
    },
    createdAt: iso(r.createdAt),
    lastValidatedAt: iso(r.lastValidatedAt),
    status: (typeof r.status === "string" ? r.status : "disabled") as StrategyStatus,
  };
}

export function emptyStrategyStore(mode: AdaptiveMode = "disabled"): StrategyStoreShape {
  return { version: STRATEGY_STORE_VERSION, mode, strategies: [] };
}

/** Load strategies; corruption → disabled fallback (fail-safe direction). */
export function loadStrategyStore(dir: string): StrategyStoreShape {
  try {
    const file = path.join(dir, "strategies.json");
    if (!fs.existsSync(file)) return emptyStrategyStore();
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return emptyStrategyStore();
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== STRATEGY_STORE_VERSION) return emptyStrategyStore();
    const mode: AdaptiveMode = (
      ["disabled", "observe", "suggest", "apply"].includes(String(raw.mode)) ? raw.mode : "disabled"
    ) as AdaptiveMode;
    const strategies = (Array.isArray(raw.strategies) ? raw.strategies : [])
      .slice(-MAX_STRATEGIES)
      .map(boundStrategy)
      .filter((s): s is Strategy => s !== null);
    return { version: STRATEGY_STORE_VERSION, mode, strategies };
  } catch {
    // Corrupted store → safe fallback: layer off, zero strategies.
    return emptyStrategyStore();
  }
}

/** Atomically persist (tmp + rename). Best-effort, never throws. */
export function saveStrategyStore(dir: string, store: StrategyStoreShape): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const pruned: StrategyStoreShape = {
      version: STRATEGY_STORE_VERSION,
      mode: store.mode,
      strategies: store.strategies.slice(-MAX_STRATEGIES).map((s) => boundStrategy(s) ?? s),
    };
    const file = path.join(dir, "strategies.json");
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    // persistence is best-effort by contract
  }
}

/** Upsert by id (dedup: same id → replaces, keeps insertion order otherwise). */
export function upsertStrategy(store: StrategyStoreShape, strategy: Strategy): StrategyStoreShape {
  const idx = store.strategies.findIndex((s) => s.id === strategy.id);
  const strategies = [...store.strategies];
  if (idx >= 0) strategies[idx] = strategy;
  else strategies.push(strategy);
  return { ...store, strategies: strategies.slice(-MAX_STRATEGIES) };
}
