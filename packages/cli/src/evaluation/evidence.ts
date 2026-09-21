/**
 * packages/cli/src/evaluation/evidence.ts — evidence bounds + id counter.
 *
 * / Bounding delle evidenze e contatore id monotono (stesso stile di
 * / decision/fingerprint.ts makeDecisionId).
 *
 * Everything entering an EvaluationRecord passes through here first: facts
 * are projected with a WeakSet depth/cycle guard (same approach as
 * decision/sanitize.ts projectValue), strings capped at MAX_STRING, evidence
 * lists capped at MAX_EVIDENCE. The layer is OBSERVE-ONLY: bounding never
 * throws, it degrades.
 */

import type { EvidenceItem } from "./types";

/** Hard cap on evidence items carried per evaluation record. */
export const MAX_EVIDENCE = 64;
/** Hard cap per string field (chars). */
export const MAX_STRING = 2000;
/** Hard cap on list items inside facts. */
const MAX_LIST = 32;
// Facts recursion budget, aligned with the sanitize.ts projection.
const MAX_DEPTH = 8;
/** Depth tracking set (counts entries; WeakSet has no .size — this does). */
const depthSeen = new Set<object>();

/** Cap a string deterministically; overflow is marked, not dropped. */
export function capString(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[capped]` : value;
}

/**
 * Project an arbitrary facts object into a bounded, cycle-safe plain record.
 * Cyclic references are dropped (probe B7 lesson: never recurse into a cycle),
 * strings capped, lists truncated, depth flattened. Deterministic: same input
 * → same output, key order preserved.
 */
export function projectFacts(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return capString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return undefined;
    if (depthSeen.size >= MAX_DEPTH) return "[max-depth]";
    seen.add(value);
    depthSeen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, MAX_LIST).map((item) => projectFacts(item, seen));
      }
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const projected = projectFacts(v, seen);
        if (projected !== undefined) rec[k] = projected;
      }
      return rec;
    } finally {
      seen.delete(value);
      depthSeen.delete(value);
    }
  }
  // symbol / function / undefined facts are not evidence — drop silently
  return undefined;
}

/** Bounded copy of a facts record (never throws, never returns undefined). */
export function boundFacts(facts: Record<string, unknown>): Record<string, unknown> {
  const projected = projectFacts(facts, new WeakSet());
  return typeof projected === "object" && projected !== null
    ? (projected as Record<string, unknown>)
    : {};
}

const seenIds = new Set<string>();

/**
 * Monotonic `EV-<runId>-<n>` — same convention as decision/fingerprint.ts
 * makeDecisionId: per-run counter, collision-safe within the process.
 */
export function makeEvaluationId(runId: string): string {
  let n = 1;
  let id = `EV-${runId}-${n}`;
  while (seenIds.has(id)) {
    n += 1;
    id = `EV-${runId}-${n}`;
  }
  seenIds.add(id);
  return id;
}

/** Reset the id counter (tests). */
export function resetEvaluationIds(): void {
  seenIds.clear();
}

/** Bounded copy of an evidence item (facts bounded, claim capped). */
export function boundEvidence(item: EvidenceItem): EvidenceItem {
  const bounded: EvidenceItem = {
    id: item.id,
    kind: item.kind,
    at: item.at,
    source: item.source,
    facts: boundFacts(item.facts),
  };
  if (item.claim !== undefined) bounded.claim = capString(item.claim);
  return bounded;
}

/** Keep the last MAX_EVIDENCE items (oldest dropped — newest facts win). */
export function boundEvidenceList(items: EvidenceItem[]): EvidenceItem[] {
  return items.length > MAX_EVIDENCE ? items.slice(items.length - MAX_EVIDENCE) : items;
}
