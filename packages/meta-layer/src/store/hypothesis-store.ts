/**
 * Queryable hypothesis store: append-only JSONL, one Hypothesis per line.
 * Same pattern as TelemetryStore: load on construction, append on change.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidChange } from "../hypotheses/engine";
import type { Hypothesis } from "../types";

export interface HypothesisStoreOptions {
  filePath: string;
}

function isHypothesis(value: unknown): value is Hypothesis {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.observation === "object" &&
    h.observation !== null &&
    typeof (h.observation as Record<string, unknown>).metric === "string" &&
    typeof h.change === "object" &&
    h.change !== null &&
    isValidChange(h.change as Hypothesis["change"]) &&
    typeof h.expectedEffect === "string" &&
    (h.status === "proposed" ||
      h.status === "applied" ||
      h.status === "promoted" ||
      h.status === "rejected") &&
    (h.delta === null || typeof h.delta === "number")
  );
}

export class HypothesisStore {
  private readonly filePath: string;
  private hypotheses: Hypothesis[] = [];

  constructor(options: HypothesisStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, "utf-8");
    let lineNum = 0;
    for (const line of raw.split(/\r\n|\n/)) {
      lineNum += 1;
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isHypothesis(parsed)) {
          process.stderr.write(
            `[hypothesis-store] skipping invalid hypothesis line ${lineNum} in ${this.filePath}\n`,
          );
          continue;
        }
        this.hypotheses.push(parsed);
      } catch {
        process.stderr.write(
          `[hypothesis-store] skipping malformed line ${lineNum} in ${this.filePath}\n`,
        );
      }
    }
  }

  private persist(hypothesis: Hypothesis): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(hypothesis)}\n`, "utf-8");
  }

  /** Persist a newly proposed hypothesis. */
  append(hypothesis: Hypothesis): void {
    this.hypotheses.push({ ...hypothesis });
    this.persist(hypothesis);
  }

  /** Persist a status/delta transition by appending the updated record. */
  update(hypothesis: Hypothesis): void {
    const existing = this.hypotheses.find((h) => h.id === hypothesis.id);
    if (!existing) {
      process.stderr.write(`[hypothesis-store] update ignored, unknown id: ${hypothesis.id}\n`);
      return;
    }
    this.hypotheses = this.hypotheses.map((h) => (h.id === hypothesis.id ? { ...hypothesis } : h));
    this.persist(hypothesis);
  }

  all(): Hypothesis[] {
    return [...this.hypotheses];
  }

  size(): number {
    return this.hypotheses.length;
  }
}
