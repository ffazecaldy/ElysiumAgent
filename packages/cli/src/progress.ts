/**
 * Durable progress file — the memory that survives a crash and a resume.
 *
 * Long runs accumulate hundreds of tool calls; without a persistent
 * progress note a resumed builder has to reconstruct its own state from
 * transcripts. This module owns `<runDir>/progress.md`, a small markdown
 * file with standard sections (Goal / Completed / Current / Known failures
 * / Next / Do not repeat) that the builder updates as it works and re-reads
 * on resume.
 *
 * Every write is ATOMIC (unique tmp file + rename, same contract as
 * run-state): a crash mid-save can never leave a torn file behind.
 * `updateProgressSection` creates the file via `initProgress` when missing,
 * and replaces only the requested section body.
 *
 * Integration note (implemented by the parent, NOT here): at resume the
 * builder prompt embeds `renderProgressInline(runDir)` so the agent picks
 * up where the previous attempt left off without replaying its history.
 *
 * No external dependencies; sync fs only.
 */

import fs from "node:fs";
import path from "node:path";

/** Name of the progress file inside a run directory. */
export const PROGRESS_FILE = "progress.md";

/** Sections the builder may rewrite via {@link updateProgressSection}. */
export type ProgressSection = "Completed" | "Current" | "Known failures" | "Next" | "Do not repeat";

/** All rewritable sections, in on-disk order (after the fixed Goal section). */
export const PROGRESS_SECTIONS: readonly ProgressSection[] = [
  "Completed",
  "Current",
  "Known failures",
  "Next",
  "Do not repeat",
];

/** Matches any `## <name>` markdown header line. */
const SECTION_HEADER_RE = /^##\s+(.+?)\s*$/;

/** Returns the progress file path for a run directory. */
function progressPath(runDir: string): string {
  return path.join(runDir, PROGRESS_FILE);
}

/**
 * Atomically persists `text` to `<runDir>/progress.md`: writes a uniquely
 * named tmp sibling first, then renames it over the target.
 * Returns the target path.
 */
function persistAtomic(runDir: string, text: string): string {
  fs.mkdirSync(runDir, { recursive: true });
  const file = progressPath(runDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Tmp already gone — nothing extra to clean up.
    }
    throw error;
  }
  return file;
}

/**
 * Creates a fresh `<runDir>/progress.md` with the standard sections and
 * `goal` under `## Goal`. Returns the file path.
 */
export function initProgress(runDir: string, goal: string): string {
  const goalText = goal.trim().length > 0 ? goal.trim() : "(not set)";
  const lines = [
    "# Progress",
    "",
    "## Goal",
    goalText,
    "",
    "## Completed",
    "",
    "## Current",
    "",
    "## Known failures",
    "",
    "## Next",
    "",
    "## Do not repeat",
    "",
  ];
  return persistAtomic(runDir, lines.join("\n"));
}

/**
 * Reads the raw progress file for `runDir`.
 * Returns `null` when the file is absent or unreadable.
 */
export function readProgress(runDir: string): string | null {
  try {
    const file = progressPath(runDir);
    if (!fs.statSync(file).isFile()) {
      return null;
    }
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Replaces the body of `section` (between its `## <name>` header and the
 * next header) with `content`, leaving every other section untouched.
 * Creates the file via {@link initProgress} when missing. Returns the file
 * path. The write is atomic (tmp + rename).
 */
export function updateProgressSection(
  runDir: string,
  section: ProgressSection,
  content: string,
): string {
  let current = readProgress(runDir);
  if (current === null) {
    initProgress(runDir, "(not set)");
    current = readProgress(runDir) ?? "";
  }
  return persistAtomic(runDir, spliceSection(current, section, content));
}

/**
 * Returns `text` with the body of `section` swapped for `content` (trimmed;
 * empty content leaves the section header with an empty body). A missing
 * section header is appended at the end. Unknown `##` lines inside content
 * are treated as new sections by readers — callers should not start body
 * lines with `## `.
 */
function spliceSection(text: string, section: ProgressSection, content: string): string {
  const lines = text.split(/\r?\n/);
  const header = `## ${section}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === header) {
      start = i;
      break;
    }
  }
  const body = content.trim();
  const bodyLines = body.length > 0 ? body.split(/\r?\n/) : [];
  if (start === -1) {
    return [...lines, header, ...bodyLines, ""].join("\n");
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start + 1), ...bodyLines, "", ...lines.slice(end)].join("\n");
}

/**
 * Compact, size-capped rendering of the progress file for injection into a
 * resume prompt. Sections with empty bodies are skipped; the result is
 * capped at `maxChars` (default 2500) with a `[truncated]` note when cut.
 * Returns `null` when there is no progress file (or nothing to render).
 */
export function renderProgressInline(runDir: string, maxChars = 2500): string | null {
  const text = readProgress(runDir);
  if (text === null) {
    return null;
  }
  const out: string[] = [];
  let header: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    const joined = body.join("\n").trim();
    if (header !== null && joined.length > 0) {
      out.push(header, joined);
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const match = SECTION_HEADER_RE.exec(line);
    if (match) {
      flush();
      header = (match[1] ?? "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  if (out.length === 0) {
    return null;
  }
  return capWithNote(out.join("\n"), maxChars);
}

/** Caps `text` at `maxChars`, appending a `[truncated]` note when cut. */
function capWithNote(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const note = "\n[truncated]";
  const head = text.slice(0, Math.max(0, maxChars - note.length));
  return `${head}${note}`.slice(0, Math.max(1, maxChars));
}
