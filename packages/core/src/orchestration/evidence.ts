/**
 * Append-only evidence chain for an orchestration run.
 *
 * Every observable step of a subtask lifecycle (spawn attempt, critic verdict,
 * gate outcome, task end, checkpoint) can be recorded as an {@link EvidenceEntry}
 * with a progressive, kind-scoped id (`<runId>:A-1`, `<runId>:V-1`, …). Counters
 * are independent per kind, so ids stay stable and greppable while the chain
 * itself preserves strict chronological insertion order.
 */

/** The kind of evidence recorded; each kind owns an independent id counter. */
export type EvidenceKind = "attempt" | "critic" | "gate" | "task_ended" | "checkpoint";

/** One recorded step of an orchestration run. */
export interface EvidenceEntry {
  /** Progressive, kind-scoped id: `${runId}:A-1`, `${runId}:V-2`, … */
  id: string;
  kind: EvidenceKind;
  runId: string;
  taskId: string;
  /** ISO-8601 timestamp captured at insertion time. */
  timestamp: string;
  summary: string;
  data?: Record<string, unknown>;
}

/** Id prefix per evidence kind; counters are independent per kind. */
const KIND_PREFIX: Record<EvidenceKind, string> = {
  attempt: "A",
  critic: "V",
  gate: "R",
  task_ended: "T",
  checkpoint: "C",
};

/** Serializable snapshot of a chain. */
export interface EvidenceChainJSON {
  runId: string;
  entries: EvidenceEntry[];
}

/**
 * Append-only, in-memory evidence chain scoped to a single run id.
 * Entries are returned in chronological (insertion) order.
 */
export class EvidenceChain {
  private readonly runId: string;
  private readonly entries_: EvidenceEntry[] = [];
  /** Independent progressive counter per kind. */
  private readonly counters: Record<EvidenceKind, number> = {
    attempt: 0,
    critic: 0,
    gate: 0,
    task_ended: 0,
    checkpoint: 0,
  };

  constructor(runId: string) {
    this.runId = runId;
  }

  /** Records a new entry and returns it. Ids are progressive per kind. */
  add(
    kind: EvidenceKind,
    taskId: string,
    summary: string,
    data?: Record<string, unknown>,
  ): EvidenceEntry {
    this.counters[kind] += 1;
    const entry: EvidenceEntry = {
      id: `${this.runId}:${KIND_PREFIX[kind]}-${this.counters[kind]}`,
      kind,
      runId: this.runId,
      taskId,
      timestamp: new Date().toISOString(),
      summary,
      ...(data === undefined ? {} : { data }),
    };
    this.entries_.push(entry);
    return entry;
  }

  /** All entries in chronological (insertion) order. */
  entries(): EvidenceEntry[] {
    return [...this.entries_];
  }

  /** Entries for one task, in chronological order. */
  byTask(taskId: string): EvidenceEntry[] {
    return this.entries_.filter((entry) => entry.taskId === taskId);
  }

  /** Serializable snapshot: run id plus the full entry list. */
  toJSON(): EvidenceChainJSON {
    return { runId: this.runId, entries: this.entries() };
  }
}
