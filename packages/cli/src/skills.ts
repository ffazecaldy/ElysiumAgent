/**
 * Skill loader for the Elysium agent.
 *
 * A "skill" is a directory containing a SKILL.md with YAML-lite frontmatter:
 *
 *   ---
 *   name: my-skill
 *   description: Use when ...
 *   ---
 *   (markdown instructions)
 *
 * The loader only BUILDS AN INDEX (name + description + absolute path).
 * The index is injected into the agent's system prompt; the agent reads the
 * full SKILL.md with the builtin `read` tool when a task matches. No new
 * tool, no core change: skills ride entirely on the existing filesystem
 * tools and PathPolicy (skills/ lives under allowed roots).
 *
 * Scan roots (in order, first root wins on name clash):
 *   1. $ELYSIUM_SKILLS_DIR — path-delimiter-separated explicit override
 *   2. <projectRoot>/skills — repo-shipped skills
 *   3. <cwd>/skills         — per-project skills
 *
 * Skills are trusted operator-provided content: only point the scan roots
 * at directories you control. Discovery is synchronous and startup-only —
 * tiny directory reads, no watchers, no background work.
 */

import fs from "node:fs";
import path from "node:path";

/** One indexed skill. `file` is the absolute SKILL.md path the agent reads. */
export interface SkillEntry {
  name: string;
  description: string;
  file: string;
}

/** Prompt-size guards: the index must stay cheap in tokens. */
const MAX_SKILLS = 32;
const MAX_DESCRIPTION_CHARS = 120;

/**
 * Extracts `name`/`description` from a `---` delimited frontmatter block.
 * Tolerant: missing or malformed frontmatter yields nulls, never throws.
 */
export function parseFrontmatter(text: string): {
  name: string | null;
  description: string | null;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return { name: null, description: null };
  let name: string | null = null;
  let description: string | null = null;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (m === null) continue;
    const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value.length === 0) continue;
    if (m[1] === "name" && name === null) name = value;
    if (m[1] === "description" && description === null) description = value;
  }
  return { name, description };
}

/** Reads one SKILL.md into an index entry; returns null when unreadable. */
function readSkillFile(file: string, fallbackName: string): SkillEntry | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return null; // missing/unreadable file: skip silently
  }
  const { name, description } = parseFrontmatter(text);
  let desc = description ?? "";
  if (desc.length === 0) {
    // Fall back to the first non-heading, non-empty body line.
    const line = text
      .replace(/^---[\s\S]*?---/, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    desc = line ?? "";
  }
  if (desc.length > MAX_DESCRIPTION_CHARS) {
    desc = `${desc.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  }
  return { name: (name ?? fallbackName).trim(), description: desc, file: path.resolve(file) };
}

/**
 * Collects skill entries from the given root directories (each skill is
 * `<root>/<dir>/SKILL.md`). Deduped by name — earlier roots win. Sorted
 * alphabetically and capped at {@link MAX_SKILLS}. Missing or unreadable
 * roots are skipped, never thrown.
 */
export function collectSkills(roots: string[]): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root missing: nothing to add
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const skill = readSkillFile(file, entry.name);
      if (skill === null || skill.name.length === 0) continue;
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
}

/**
 * Scan roots for skill discovery: the env override first, then the project
 * root and the cwd `skills/` directories. Deduped, order preserved.
 */
export function skillRoots(projectRoot: string, cwd: string = process.cwd()): string[] {
  const roots: string[] = [];
  const env = process.env.ELYSIUM_SKILLS_DIR;
  if (env !== undefined && env.trim().length > 0) {
    roots.push(
      ...env
        .split(path.delimiter)
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );
  }
  roots.push(path.join(projectRoot, "skills"));
  roots.push(path.join(cwd, "skills"));
  return [...new Set(roots)];
}

/**
 * Renders the system-prompt block for the skill index. Returns an empty
 * string when no skills exist so the prompt stays byte-identical to before.
 */
export function skillsPromptBlock(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "",
    "",
    "SKILLS: reusable instruction packs on disk. When the user's task matches a skill's description, FIRST read its SKILL.md file with the `read` tool, then follow it exactly.",
    "",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description} → ${skill.file}`);
  }
  return `${lines.join("\n")}\n`;
}
