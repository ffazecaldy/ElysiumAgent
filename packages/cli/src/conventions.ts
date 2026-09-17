/**
 * Project conventions loader — scoped rules from AGENTS.md / CLAUDE.md.
 *
 * Discovery is deliberately shallow (max 2 levels): the root-level
 * `AGENTS.md` and `CLAUDE.md`, plus non-recursive `*.md` files directly
 * inside `<root>/.elysium/conventions/`. Nothing deeper is scanned, so a
 * huge repo costs at most a handful of stats and reads.
 *
 * A file may contain multiple scoped sections. Each section starts at a
 * line `## scope: <glob>` (or `## scope: default` for always-valid rules)
 * and ends at the next scope header or end of file. Lines before the first
 * scope header belong to scope `default`.
 *
 * Nothing here ever throws: unreadable or non-file paths are skipped, so a
 * broken conventions tree can never take a run down.
 *
 * Integration note (implemented by the parent, NOT here): in swarm-mode the
 * builder's system prompt gets a conventions block via
 * `buildConventionsBlock(root, task.filesTouched)` so each subagent only
 * sees rules relevant to the files its task touches.
 *
 * No external dependencies; sync fs only.
 */

import fs from "node:fs";
import path from "node:path";

/** One scoped convention rule extracted from a conventions file. */
export interface ConventionRule {
  /** Scope glob (`default` for rules that always apply). */
  scope: string;
  /** Source file, relative to the discovered root (e.g. `AGENTS.md`). */
  source: string;
  /** Rule body: all lines of the section, trimmed. */
  body: string;
}

/** Root-level marker files scanned for conventions (level 1). */
const ROOT_FILES = ["AGENTS.md", "CLAUDE.md"];

/** Directory whose direct `*.md` children are scanned (level 2, non-recursive). */
const CONVENTIONS_DIR = ".elysium/conventions";

/** Matches a scope header line: `## scope: <glob>`. */
const SCOPE_HEADER_RE = /^##\s+scope:\s*(.*?)\s*$/;

/**
 * Reads a text file, returning `null` instead of throwing when the path is
 * missing, unreadable, or not a regular file.
 */
function readTextFile(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) {
      return null;
    }
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Splits one conventions file into scoped rules. Lines before the first
 * `## scope:` header form a `default` rule; each header starts a new
 * section that runs until the next header or end of file. Sections with an
 * empty body are dropped.
 */
function parseConventionFile(relSource: string, text: string): ConventionRule[] {
  const rules: ConventionRule[] = [];
  let scope = "default";
  let body: string[] = [];
  const flush = (): void => {
    const joined = body.join("\n").trim();
    if (joined.length > 0) {
      rules.push({ scope, source: relSource, body: joined });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const match = SCOPE_HEADER_RE.exec(line);
    const scopeName = (match?.[1] ?? "").trim();
    if (match && scopeName.length > 0) {
      flush();
      scope = scopeName;
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return rules;
}

/**
 * Discovers convention rules under `root` (max 2 levels deep):
 * `<root>/AGENTS.md`, `<root>/CLAUDE.md`, and every direct `*.md` inside
 * `<root>/.elysium/conventions/`. Never throws; unreadable entries are
 * skipped.
 */
export function discoverConventions(root: string): ConventionRule[] {
  const rules: ConventionRule[] = [];
  for (const name of ROOT_FILES) {
    const text = readTextFile(path.join(root, name));
    if (text !== null) {
      rules.push(...parseConventionFile(name, text));
    }
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(root, CONVENTIONS_DIR));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const relSource = `${CONVENTIONS_DIR}/${entry}`;
    const text = readTextFile(path.join(root, relSource));
    if (text !== null) {
      rules.push(...parseConventionFile(relSource, text));
    }
  }
  return rules;
}

/**
 * Compiles a minimal glob into a RegExp: `**` matches anything (any
 * depth), `*` matches within a single path segment, everything else is
 * literal (regex-escaped).
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if ((glob[i + 1] ?? "") === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Simple glob matching against a forward-slash path: globs containing `*`
 * are compiled (`**` any depth, `*` one segment); a bare glob without
 * wildcards matches the path exactly or as a directory prefix.
 */
function matchGlob(glob: string, filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const g = glob.replace(/\\/g, "/").trim();
  if (g.length === 0) {
    return false;
  }
  if (g === "**") {
    return true;
  }
  if (g.includes("*")) {
    return globToRegExp(g).test(p);
  }
  const prefix = g.endsWith("/") ? g : `${g}/`;
  return p === g || p.startsWith(prefix);
}

/**
 * Filters rules down to what is relevant for `paths`: every `default` rule
 * plus each scoped rule whose glob matches at least one of the paths.
 */
export function rulesForPaths(rules: ConventionRule[], paths: string[]): ConventionRule[] {
  return rules.filter(
    (rule) => rule.scope === "default" || paths.some((p) => matchGlob(rule.scope, p)),
  );
}

/**
 * Discovers, filters, and renders the conventions block for a task.
 *
 * Parent wiring (documented, not implemented here): in swarm-mode the
 * builder's system prompt embeds `buildConventionsBlock(root,
 * task.filesTouched)` so the agent sees only the project conventions that
 * apply to the files its task touches.
 *
 * Format:
 * ```
 * ## Project conventions (relevant rules)
 * <scope>: <body>
 * ```
 * Bodies are collapsed to a single line. Returns `null` when no rules
 * apply. The block is capped at `maxChars` (default 4000); when capped, a
 * `[truncated]` note is appended.
 */
export function buildConventionsBlock(
  root: string,
  taskPaths: string[],
  maxChars = 4000,
): string | null {
  const rules = rulesForPaths(discoverConventions(root), taskPaths);
  if (rules.length === 0) {
    return null;
  }
  const lines = rules.map((rule) => `${rule.scope}: ${rule.body.replace(/\s+/g, " ").trim()}`);
  const block = `## Project conventions (relevant rules)\n${lines.join("\n")}`;
  return capWithNote(block, maxChars);
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
