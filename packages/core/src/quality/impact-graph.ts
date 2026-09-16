/**
 * Change Impact Graph — file-level blast radius for a set of changed files.
 *
 * Zero dependencies, no AST: importers are discovered with a simple
 * import/require text scan (TS/JS/Python) over the workspace's source files.
 * All I/O is injected (`readFile`/`listFiles`) so the computation is fully
 * deterministic and testable against an in-memory workspace.
 */

/** Extensions scanned for import references. */
const SOURCE_EXT = /\.(ts|js|py)$/i;

/**
 * Default test-file convention, mirroring common JS and Python layouts:
 `*.test.*`, `*.spec.*`, `test*.*`, `*_test.*` and any `test(s)/` directory.
 */
const DEFAULT_TEST_CONVENTION = /\.(test|spec)\.|test_|_test\.|(^|\/)tests?\//;

/** Quoted module specifiers in TS/JS: `import ... from 'x'`, `import 'x'`, `require('x')`, `export ... from 'x'`. */
const JS_SPECIFIER =
  /(?:\bimport\s+(?:[\s\S]{0,200}?\sfrom\s+)?|\bexport\s+[\s\S]{0,200}?\sfrom\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;

/** Python `from module import a, b` and `import module` statements. */
const PY_FROM = /(?:^|\n)\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/g;
const PY_IMPORT = /(?:^|\n)\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)/g;

/** Result of the impact analysis for one change set. */
export interface ImpactGraph {
  /** Normalized (posix, workspace-relative) paths of the changed files. */
  changedFiles: string[];
  /** For each changed file, every source file whose imports reference it. */
  importers: Record<string, string[]>;
  /** Test files among (importers ∪ changed) matching the test convention. */
  affectedTests: string[];
  /** Deterministic blast-radius score on the same 0-10 scale as risk-score. */
  riskScore: { score: number; level: "low" | "medium" | "high" };
}

/** Injected I/O plus inputs for {@link buildImpactGraph}. */
export interface ImpactGraphOptions {
  /** Files whose blast radius should be computed (absolute or relative). */
  changedFiles: string[];
  /** Workspace root the paths are relative to. */
  workspaceRoot: string;
  /** Injected file reader; returns null for unreadable/missing files. */
  readFile: (p: string) => string | null;
  /** Injected directory lister returning the direct children of `dir`. */
  listFiles: (dir: string) => string[];
  /** Optional override of the test-file convention. */
  testConvention?: RegExp;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripExt(p: string): string {
  return p.replace(/\.[^./]+$/, "");
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Normalizes a path to a posix, workspace-relative key. */
function normalizeKey(p: string, workspaceRoot: string): string {
  const posix = toPosix(p);
  const root = `${toPosix(workspaceRoot).replace(/\/+$/, "")}/`;
  const relative = posix.startsWith(root) ? posix.slice(root.length) : posix;
  return relative.replace(/^\.\//, "");
}

/** Joins a listed entry onto its directory, honoring absolute entries. */
function joinPath(dir: string, entry: string): string {
  if (/^(?:[a-zA-Z]:)?\//.test(entry)) return toPosix(entry).replace(/\/+$/, "");
  return `${dir}/${toPosix(entry).replace(/\/+$/, "")}`;
}

/** Recursively collects source files under the workspace root (cycle-safe). */
function collectSourceFiles(opts: ImpactGraphOptions): string[] {
  const files = new Set<string>();
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    const key = dir.replace(/\/+$/, "");
    if (visited.has(key)) return;
    visited.add(key);
    for (const entry of opts.listFiles(key)) {
      const child = joinPath(key, entry);
      if (SOURCE_EXT.test(child)) files.add(child);
      else walk(child);
    }
  };
  walk(toPosix(opts.workspaceRoot).replace(/\/+$/, ""));
  return [...files].sort();
}

/**
 * Extracts every module specifier referenced by import/require/from
 * statements in `content`. Python relative modules (`from . import x`) are
 * resolved to bare names; `from pkg import x` yields both `pkg` and `pkg.x`.
 */
function extractSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  for (const match of content.matchAll(JS_SPECIFIER)) {
    const spec = match[2];
    if (spec) specs.add(spec);
  }
  for (const match of content.matchAll(PY_FROM)) {
    const module = match[1];
    const names = match[2];
    if (!module || !names) continue;
    const mod = module.replace(/^[.]+/, "");
    specs.add(mod);
    for (const name of names.split(",")) {
      const trimmed = name.trim().replace(/\s+as\s+\w+$/, "");
      if (/^\w+$/.test(trimmed)) specs.add(`${mod}.${trimmed}`);
    }
  }
  for (const match of content.matchAll(PY_IMPORT)) {
    const modules = match[1];
    if (!modules) continue;
    for (const mod of modules.split(",")) specs.add(mod.trim());
  }
  return [...specs];
}

/** True when any extracted specifier references the target's path or basename. */
function referencesTarget(content: string, target: string): boolean {
  const base = stripExt(baseName(target));
  const candidates = new Set([
    target,
    stripExt(target),
    baseName(target),
    base,
    stripExt(target).replace(/\//g, "."),
  ]);
  for (const raw of extractSpecifiers(content)) {
    const spec = raw.replace(/^\.\//, "");
    const specCandidates = new Set([spec, stripExt(spec)]);
    for (const candidate of specCandidates) {
      if (candidates.has(candidate)) return true;
      if (candidate.endsWith(`/${stripExt(target)}`) || candidate.endsWith(`/${base}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Builds the change impact graph for `opts.changedFiles`:
 * 1. scans every workspace source file for import/require references to each
 *    changed file's basename or relative path (plain regex, no AST);
 * 2. collects the test files among importers and changed files;
 * 3. scores the blast radius internally —
 *    `score = round(min(10, changed + 0.5 * importersTotal + 0.5 * tests))`,
 *    with the same low/medium/high thresholds as risk-score
 *    (`<=3` low, `<=6` medium, otherwise high).
 */
export function buildImpactGraph(opts: ImpactGraphOptions): ImpactGraph {
  const changedFiles = opts.changedFiles.map((f) => normalizeKey(f, opts.workspaceRoot));
  const convention = opts.testConvention ?? DEFAULT_TEST_CONVENTION;

  const contents = new Map<string, string>();
  for (const file of collectSourceFiles(opts)) {
    const body = opts.readFile(file);
    if (typeof body === "string") contents.set(normalizeKey(file, opts.workspaceRoot), body);
  }

  const importers: Record<string, string[]> = {};
  for (const target of changedFiles) {
    const found: string[] = [];
    for (const [file, body] of contents) {
      if (file !== target && referencesTarget(body, target)) found.push(file);
    }
    importers[target] = found.sort();
  }

  const importersTotal = Object.values(importers).reduce((n, list) => n + list.length, 0);
  const affectedTests = [...new Set([...changedFiles, ...Object.values(importers).flat()])]
    .filter((file) => convention.test(file))
    .sort();

  const raw = changedFiles.length + importersTotal * 0.5 + affectedTests.length * 0.5;
  const score = Math.round(Math.min(10, raw));
  const level: ImpactGraph["riskScore"]["level"] =
    score <= 3 ? "low" : score <= 6 ? "medium" : "high";

  return { changedFiles, importers, affectedTests, riskScore: { score, level } };
}
