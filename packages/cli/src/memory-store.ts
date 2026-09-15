/**
 * Persistent operator memory — a flat markdown note file the human operator
 * curates and the agent must respect. Stored at `<root>/.elysium/memory.md`,
 * one `- ` entry per line, capped to the most recent MAX_ENTRIES notes.
 * No external dependencies; sync fs; never throws on a missing file.
 */
import fs from "node:fs";
import path from "node:path";

/** Maximum number of remembered entries; oldest are dropped beyond this. */
export const MAX_ENTRIES = 50;

/** Returns the path of the memory file for a project root. */
function memoryFile(projectRoot: string): string {
  return path.join(projectRoot, ".elysium", "memory.md");
}

/**
 * Loads operator memory entries from `<root>/.elysium/memory.md`.
 * Only lines starting with `- ` count as entries; blank lines and
 * markdown headers are ignored. Returns `[]` when the file is absent.
 */
export function loadMemory(projectRoot: string): string[] {
  const file = memoryFile(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

/**
 * Appends an entry to operator memory, creating `.elysium/` as needed.
 * When the store exceeds MAX_ENTRIES the oldest entries are discarded.
 * Returns the full list of retained entries (newest last).
 */
export function addMemoryEntry(projectRoot: string, entry: string): string[] {
  fs.mkdirSync(path.join(projectRoot, ".elysium"), { recursive: true });
  const entries = [...loadMemory(projectRoot), entry];
  const retained = entries.slice(Math.max(0, entries.length - MAX_ENTRIES));
  fs.writeFileSync(
    memoryFile(projectRoot),
    `${retained.map((e) => `- ${e}`).join("\n")}\n`,
    "utf-8",
  );
  return retained;
}

/**
 * Deletes the memory file for a project root. No-op when it does not exist.
 */
export function clearMemory(projectRoot: string): void {
  try {
    fs.unlinkSync(memoryFile(projectRoot));
  } catch {
    // Absent file is fine — clearing an empty memory is a no-op.
  }
}

/**
 * Renders memory entries as a prompt block. Returns an empty string when
 * there are no entries, otherwise a header plus one `- entry` per line.
 */
export function memoryPromptBlock(entries: string[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `\n\nMEMORY (operator notes — respect them):\n${entries.map((e) => `- ${e}`).join("\n")}`;
}
