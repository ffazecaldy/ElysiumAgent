/**
 * packages/cli/src/redacting-evidence.ts — evidence boundary.
 *
 * Wraps {@link EvidenceChain} so that nothing reaches evidence with an
 * unredacted secret: `add()` redacts summary (redactText) and data
 * (redactObject) BEFORE delegating. Same surface as the wrapped chain.
 */

import {
  type EvidenceChain,
  type EvidenceEntry,
  type EvidenceKind,
  redactObject,
  redactText,
} from "@elysium/core";

/** Redacting decorator over an EvidenceChain (read methods pass through). */
export class RedactingEvidenceChain {
  private readonly inner: EvidenceChain;
  private readonly extraValues: string[];

  constructor(inner: EvidenceChain, extraValues: string[] = []) {
    this.inner = inner;
    this.extraValues = extraValues;
  }

  /** Redacts, then records on the inner chain. */
  add(
    kind: EvidenceKind,
    taskId: string,
    summary: string,
    data?: Record<string, unknown>,
  ): EvidenceEntry {
    const safeSummary = redactText(summary, this.extraValues);
    const safeData =
      data === undefined
        ? undefined
        : (redactObject(data, this.extraValues) as Record<string, unknown>);
    return this.inner.add(kind, taskId, safeSummary, safeData);
  }

  /** Chronological copy of the entries. */
  entries(): EvidenceEntry[] {
    return this.inner.entries();
  }

  /** Entries for one task. */
  byTask(taskId: string): EvidenceEntry[] {
    return this.inner.byTask(taskId);
  }

  /** JSON shape of the inner chain. */
  toJSON(): { runId: string; entries: EvidenceEntry[] } {
    return this.inner.toJSON();
  }
}

/** Convenience factory. */
export function wrapEvidenceChain(
  chain: EvidenceChain,
  extraValues: string[] = [],
): RedactingEvidenceChain {
  return new RedactingEvidenceChain(chain, extraValues);
}
