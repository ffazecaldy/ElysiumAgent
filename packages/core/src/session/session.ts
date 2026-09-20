/**
 * Session & state manager: append-only JSONL entry tree.
 * History is never rewritten — branch, checkpoint, and compaction are
 * all leaf operations over an immutable log.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "../types/messages";
import type {
  Checkpoint,
  CompactionOptions,
  CompactionResult,
  SessionEntry,
  SessionEntryData,
} from "../types/session";

export interface SessionOptions {
  filePath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function entryId(counter: number): string {
  return `e${String(counter).padStart(6, "0")}`;
}

function messageOf(data: SessionEntryData): AgentMessage | null {
  if (data.kind === "user" || data.kind === "assistant" || data.kind === "tool_result") {
    return data.message;
  }
  return null;
}

export class Session {
  private readonly filePath: string;
  private log: SessionEntry[] = [];
  private leaf: string | null = null;
  private counter = 0;

  constructor(options: SessionOptions) {
    this.filePath = path.resolve(options.filePath);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, "utf-8");
    const lines = raw.split(/\r\n|\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as SessionEntry;
        this.log.push(parsed);
        this.leaf = parsed.id;
      } catch {
        throw new Error(`corrupted session line ${i + 1} in ${this.filePath}`);
      }
    }
    // Restore durable leaf pointer from the latest leaf: meta entry.
    for (let i = this.log.length - 1; i >= 0; i--) {
      const e = this.log[i];
      if (e && e.data.kind === "meta" && e.data.label.startsWith("leaf:")) {
        const restored = e.data.label.slice(5); // "leaf:<id>" -> id
        // A bare "leaf:" marker is an explicit null leaf (restore(null)).
        this.leaf = restored.length > 0 ? restored : null;
        break;
      }
    }
    // Counter = MAX over every parseable entry id (not just the last line):
    // a hand-edited log must never yield duplicate ids on append.
    let maxId = 0;
    for (const e of this.log) {
      const num = Number.parseInt(e.id.slice(1), 10);
      if (Number.isSafeInteger(num) && num > maxId) maxId = num;
    }
    if (maxId > 0) {
      this.counter = maxId;
    } else if (this.log.length > 0) {
      this.counter = this.log.length;
    }
  }

  private persist(entry: SessionEntry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  private append(data: SessionEntryData): SessionEntry {
    this.counter += 1;
    const entry: SessionEntry = {
      id: entryId(this.counter),
      parentId: this.leaf,
      timestamp: nowIso(),
      data,
    };
    this.log.push(entry);
    this.leaf = entry.id;
    this.persist(entry);
    return entry;
  }

  entries(): SessionEntry[] {
    return [...this.log];
  }

  leafId(): string | null {
    return this.leaf;
  }

  appendUser(content: string): SessionEntry {
    return this.append({ kind: "user", message: { role: "user", content } });
  }

  appendAssistant(message: AssistantMessage): SessionEntry {
    return this.append({ kind: "assistant", message });
  }

  appendToolResult(message: ToolResultMessage): SessionEntry {
    return this.append({ kind: "tool_result", message });
  }

  appendSummary(text: string, coversEntryIds: string[]): SessionEntry {
    return this.append({ kind: "summary", text, coversEntryIds: [...coversEntryIds] });
  }

  appendMeta(label: string, data?: unknown): SessionEntry {
    return data === undefined
      ? this.append({ kind: "meta", label })
      : this.append({ kind: "meta", label, data });
  }

  setLeaf(entryIdStr: string): void {
    const found = this.log.find((e) => e.id === entryIdStr);
    if (!found) {
      throw new Error(`entry not found: ${entryIdStr}`);
    }
    this.leaf = entryIdStr;
    this.persistLeafMarker(entryIdStr);
  }

  /** Persist the leaf pointer as a meta entry for durability across reloads. */
  private persistLeafMarker(target: string | null): void {
    this.counter += 1;
    const marker: SessionEntry = {
      id: entryId(this.counter),
      parentId: target,
      timestamp: nowIso(),
      data: { kind: "meta", label: `leaf:${target ?? ""}` },
    };
    this.log.push(marker);
    this.persist(marker);
  }

  checkpoint(): Checkpoint {
    return { entryId: this.leaf, entryCount: this.log.length };
  }

  restore(cp: Checkpoint): void {
    if (cp.entryCount > this.log.length) {
      throw new Error(
        `checkpoint entryCount ${cp.entryCount} exceeds current log size ${this.log.length}`,
      );
    }
    if (cp.entryId !== null) {
      this.setLeaf(cp.entryId);
    } else {
      this.leaf = null;
      // Persist the null leaf too, so a reload stays on the empty branch.
      this.persistLeafMarker(null);
    }
  }

  /** Active branch, root → leaf order. */
  private branch(): SessionEntry[] {
    const byId = new Map(this.log.map((e) => [e.id, e]));
    const chain: SessionEntry[] = [];
    let cursor = this.leaf;
    while (cursor !== null) {
      const entry = byId.get(cursor);
      if (!entry) throw new Error(`broken parent chain at entry '${cursor}'`);
      chain.push(entry);
      cursor = entry.parentId;
    }
    chain.reverse();
    return chain;
  }

  buildContext(options?: { includeMeta?: boolean }): AgentMessage[] {
    const includeMeta = options?.includeMeta ?? false;
    const branch = this.branch();
    const branchIds = new Set(branch.map((e) => e.id));
    // Map: summary entry -> first covered entry id present in the branch.
    const summaryAnchor = new Map<string, string>();
    const summariesByAnchor = new Map<string, SessionEntry>();
    for (const e of branch) {
      if (e.data.kind !== "summary") continue;
      const covered = e.data.coversEntryIds.filter((id) => branchIds.has(id));
      if (covered.length === 0) {
        // Nothing covered in this branch: project in place.
        summaryAnchor.set(e.id, e.id);
        summariesByAnchor.set(e.id, e);
        continue;
      }
      const first = covered.reduce((a, b) => (a < b ? a : b));
      summaryAnchor.set(e.id, first);
      summariesByAnchor.set(first, e);
    }
    const emitted = new Set<string>();
    const coveredIds = new Set<string>();
    for (const e of branch) {
      if (e.data.kind === "summary") {
        for (const id of e.data.coversEntryIds) coveredIds.add(id);
      }
    }
    const messages: AgentMessage[] = [];
    for (const e of branch) {
      const anchor = summariesByAnchor.get(e.id);
      if (anchor !== undefined && e.data.kind !== "summary") {
        // First covered position of a summary: emit the summary here.
        const summary = anchor;
        if (summary.data.kind === "summary" && !emitted.has(summary.id)) {
          emitted.add(summary.id);
          messages.push({ role: "user", content: `[compacted] ${summary.data.text}` });
        }
      }
      if (e.data.kind === "summary") {
        // Summary emits at its anchor position, not here (unless it anchors to itself).
        if (summaryAnchor.get(e.id) === e.id && !emitted.has(e.id)) {
          emitted.add(e.id);
          messages.push({ role: "user", content: `[compacted] ${e.data.text}` });
        }
        continue;
      }
      if (coveredIds.has(e.id)) continue;
      if (e.data.kind === "meta") {
        if (includeMeta) {
          messages.push({ role: "user", content: `[meta:${e.data.label}]` });
        }
        continue;
      }
      const m = messageOf(e.data);
      if (m) messages.push(m);
    }
    return messages;
  }

  async compact(options?: CompactionOptions): Promise<CompactionResult> {
    const keep = options?.keepMessages ?? 4;
    const branch = this.branch();
    const messageEntries = branch.filter((e) => messageOf(e.data) !== null);
    if (messageEntries.length <= keep) {
      return { summaryEntryId: "", coveredCount: 0 };
    }
    const toCompact = messageEntries.slice(0, messageEntries.length - keep);
    const toCompactIds = new Set(toCompact.map((e) => e.id));
    let text: string;
    if (options?.summarizer) {
      const msgs = toCompact
        .map((e) => messageOf(e.data))
        .filter((m): m is AgentMessage => m !== null);
      text = await options.summarizer(msgs);
    } else {
      text = `[compacted] ${toCompact.length} messages`;
    }
    const entry = this.appendSummary(text, [...toCompactIds]);
    return { summaryEntryId: entry.id, coveredCount: toCompact.length };
  }
}
