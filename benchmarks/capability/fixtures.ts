/**
 * benchmarks/capability/fixtures.ts — deterministic fixture repositories.
 *
 * Every task gets a fresh workspace via makeFixture(id): git init + commit,
 * so swarm git checkpoints and rollbacks operate on real repos. Content is
 * version-controlled by the campaign (this file) — never mutated at runtime.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** git with bounded retry: transient Windows STATUS_DLL_INIT_FAILED
 * (0xC0000142, exit 3221225794) can hit git under heavy process pressure;
 * a short backoff resolves it without masking real failures. */
function sh(cmd: string, cwd: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      execFileSync("git", cmd, { cwd, encoding: "utf8" });
      return;
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status !== 3221225794) throw error;
    }
  }
  throw lastError;
}

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

export interface FixtureFile {
  p: string;
  c: string;
}

export interface FixtureSpec {
  files: FixtureFile[];
  /** Optional setup commands after commit (git branch etc.). */
  post?: (root: string) => void;
}

function commitAll(root: string, msg: string): void {
  sh(["add", "-A"], root);
  sh(["commit", "-m", msg], root);
}

function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  sh(["init", "-q"], root);
  sh(["config", "user.email", "campaign@elysium.local"], root);
  sh(["config", "user.name", "Elysium Campaign"], root);
  sh(["config", "commit.gpgsign", "false"], root);
}

/** Common minimal package.json shared by TS fixtures that need one. */
const PKG = `${JSON.stringify(
  {
    name: "fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test test/" },
  },
  null,
  2,
)}\n`;

// ── A: simple coding ──────────────────────────────────────────────

const FIX_SIMPLE_UTILS: FixtureSpec = {
  files: [
    {
      p: "src/utils.ts",
      c: 'export function slugify(input: string): string {\n  return input.toLowerCase().replaceAll(" ", "-");\n}\n',
    },
    {
      p: "src/format.ts",
      c: 'export function money(n: number): string {\n  return "$" + n.toFixed(2);\n}\n',
    },
  ],
};

const FIX_SIMPLE_GREETER: FixtureSpec = {
  files: [
    {
      p: "src/greeter.ts",
      c: 'export function greet(name: string): string {\n  return "Hello, " + name + "!";\n}\n',
    },
  ],
};

const FIX_SIMPLE_TYPO: FixtureSpec = {
  files: [
    {
      p: "src/cart.ts",
      c: "export interface Item { name: string; priceCents: number; }\n\n/** Retuns the total in cents. */\nexport function cartTotal(items: Item[]): number {\n  return items.reduce((sum, it) => sum + it.priceCents, 0);\n}\n",
    },
  ],
};

const FIX_SIMPLE_CONFIG: FixtureSpec = {
  files: [
    {
      p: "config.yaml",
      c: "# app config\nlogLevel: debug\nretries: 2\nhost: localhost\nport: 8080\n",
    },
    { p: "README.md", c: "# fixture app\n" },
  ],
};

// ── B: real bug fixing (tests initially FAIL) ─────────────────────

function bugSpec(
  module: string,
  broken: string,
  testFile: string,
  extra: FixtureFile[] = [],
): FixtureSpec {
  return {
    files: [
      { p: `src/${module}.ts`, c: broken },
      { p: "package.json", c: PKG },
      { p: testFile, c: testSource(module) },
      ...extra,
    ],
  };
}

/** node:test source for the B tasks (tests reference src/<mod>.ts exports). */
function testSource(mod: string): string {
  return `import test from "node:test";\nimport assert from "node:assert/strict";\nimport * as m from "../src/${mod}.ts";\nimport { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n\nconst cases = JSON.parse(readFileSync(fileURLToPath(new URL("../src/cases.json", import.meta.url)), "utf8"));\n\nfor (const c of cases) {\n  test(c.name, () => {\n    const got = m[c.fn](...c.args);\n    assert.deepEqual(got, c.want);\n  });\n}\n`;
}

const CASES = (obj: unknown) => `${JSON.stringify(obj, null, 2)}\n`;

const FIX_BUG_PALINDROME: FixtureSpec = {
  files: [
    {
      p: "src/palindrome.ts",
      c: 'export function isPalindrome(s: string): boolean {\n  const t = s.toLowerCase();\n  return t === [...t].reverse().join("");\n}\n',
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "radar", fn: "isPalindrome", args: ["radar"], want: true },
        { name: "hello", fn: "isPalindrome", args: ["hello"], want: false },
        {
          name: "A man a plan a canal Panama",
          fn: "isPalindrome",
          args: ["A man a plan a canal Panama"],
          want: true,
        },
      ]),
    },
    { p: "package.json", c: PKG },
    { p: "test/palindrome.test.ts", c: testSource("palindrome") },
  ],
};

const FIX_BUG_CLAMP: FixtureSpec = {
  files: [
    {
      p: "src/mathutil.ts",
      c: "export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(lo, Math.max(hi, n));\n}\n",
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "inside", fn: "clamp", args: [5, 0, 10], want: 5 },
        { name: "below", fn: "clamp", args: [-3, 0, 10], want: 0 },
        { name: "above", fn: "clamp", args: [42, 0, 10], want: 10 },
      ]),
    },
    { p: "package.json", c: PKG },
    { p: "test/mathutil.test.ts", c: testSource("mathutil") },
  ],
};

const FIX_BUG_DATERANGE: FixtureSpec = {
  files: [
    {
      p: "src/daterange.ts",
      c: "export function daysBetween(a: string, b: string): number {\n  return new Date(a).getDate() - new Date(b).getDate();\n}\n",
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "same day", fn: "daysBetween", args: ["2026-01-01", "2026-01-01"], want: 0 },
        { name: "one day", fn: "daysBetween", args: ["2026-01-01", "2026-01-02"], want: 1 },
        { name: "reverse", fn: "daysBetween", args: ["2026-01-02", "2026-01-01"], want: -1 },
        { name: "cross month", fn: "daysBetween", args: ["2026-01-31", "2026-02-01"], want: 1 },
      ]),
    },
    { p: "package.json", c: PKG },
    { p: "test/daterange.test.ts", c: testSource("daterange") },
  ],
};

const FIX_BUG_DEDUP: FixtureSpec = {
  files: [
    {
      p: "src/dedup.ts",
      c: "export function dedup<T>(items: T[]): T[] {\n  return [...new Set(items.map(String))] as unknown as T[];\n}\n",
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "numbers", fn: "dedup", args: [[1, 2, 1, 3]], want: [1, 2, 3] },
        { name: "strings", fn: "dedup", args: [["a", "a", "b"]], want: ["a", "b"] },
      ]),
    },
    { p: "package.json", c: PKG },
    { p: "test/dedup.test.ts", c: testSource("dedup") },
  ],
};

const FIX_BUG_TICKER: FixtureSpec = {
  files: [
    {
      p: "src/ticker.ts",
      c: "export class Ticker {\n  private count = 0;\n  tick(): void { this.count += 1; }\n  get value(): number { return this.count; }\n  reset(): void { this.count === 0; }\n}\n",
    },
    { p: "src/cases.json", c: CASES([]) },
    { p: "package.json", c: PKG },
    {
      p: "test/ticker.test.ts",
      c: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { Ticker } from "../src/ticker.ts";\n\ntest("reset zeroes the count", () => {\n  const t = new Ticker();\n  t.tick(); t.tick(); t.tick();\n  t.reset();\n  assert.equal(t.value, 0);\n});\n',
    },
  ],
};

const FIX_BUG_LEVENSHTEIN: FixtureSpec = {
  files: [
    {
      p: "src/levenshtein.ts",
      c: "export function editDistance(a: string, b: string): number {\n  if (a === b) return 0;\n  return Math.abs(a.length - b.length);\n}\n",
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "equal", fn: "editDistance", args: ["kitten", "kitten"], want: 0 },
        { name: "one sub", fn: "editDistance", args: ["kitten", "sitten"], want: 1 },
        { name: "classic", fn: "editDistance", args: ["kitten", "sitting"], want: 3 },
      ]),
    },
    { p: "package.json", c: PKG },
    { p: "test/levenshtein.test.ts", c: testSource("levenshtein") },
  ],
};

// ── C: multi-file implementation ──────────────────────────────────

const FIX_MULTI_MVC: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/models.ts",
      c: "export interface User { id: number; name: string; email: string; }\nexport const users: User[] = [];\n",
    },
    {
      p: "src/store.ts",
      c: 'import { users, type User } from "./models.ts";\n\nexport function addUser(u: User): User { users.push(u); return u; }\nexport function findUser(id: number): User | undefined { return users.find((u) => u.id === id); }\n',
    },
    {
      p: "src/service.ts",
      c: 'import { addUser, findUser } from "./store.ts";\n\nexport function register(name: string, email: string): { id: number; name: string; email: string } {\n  const id = users.length + 1;\n  return addUser({ id, name, email });\n}\nexport function get(id: number) { return findUser(id); }\n',
    },
  ],
};

const FIX_MULTI_CLI: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/lib.ts",
      c: "export function parseArgs(argv: string[]): Record<string, string> {\n  const out: Record<string, string> = {};\n  for (const a of argv) {\n    const m = a.match(/^--([^=]+)=(.*)$/);\n    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2];\n  }\n  return out;\n}\n",
    },
  ],
};

const FIX_MULTI_REPORT: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/data.ts",
      c: 'export const orders = [\n  { id: 1, user: "ann", amount: 120 },\n  { id: 2, user: "bob", amount: 80 },\n  { id: 3, user: "ann", amount: 200 },\n];\n',
    },
  ],
};

const FIX_MULTI_PLUGIN: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/registry.ts",
      c: "export interface Plugin { name: string; run: (x: number) => number; }\nconst plugins: Plugin[] = [];\nexport function register(p: Plugin): void { plugins.push(p); }\nexport function runAll(x: number): number[] { return plugins.map((p) => p.run(x)); }\nexport function names(): string[] { return plugins.map((p) => p.name); }\n",
    },
  ],
};

const FIX_MULTI_AUTH: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/api.ts",
      c: 'export interface Request { method: string; path: string; headers: Record<string, string>; }\nexport interface Response { status: number; body: string; }\n\nexport function handle(req: Request): Response {\n  if (req.path === "/public") return { status: 200, body: "ok" };\n  return { status: 404, body: "not found" };\n}\n',
    },
  ],
};

const FIX_MULTI_STATSVAR: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/stats.ts",
      c: "export function mean(xs: number[]): number {\n  if (xs.length === 0) return NaN;\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n",
    },
    {
      p: "src/cases.json",
      c: CASES([
        { name: "mean basic", fn: "mean", args: [[2, 4, 6]], want: 4 },
        { name: "mean single", fn: "mean", args: [[5]], want: 5 },
      ]),
    },
    { p: "test/stats.test.ts", c: testSource("stats") },
  ],
};

// ── D: recovery ───────────────────────────────────────────────────

const FIX_REC_MISSING_DEP: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/index.ts",
      c: 'import { pick } from "lodash-es";\n\nexport function main(): string {\n  const u = new URL("https://x.y/p?q=1");\n  return pick({ path: u.pathname, q: u.searchParams.get("q") }, "path", "q").path as string;\n}\n',
    },
    {
      p: "src/cases.json",
      c: CASES([{ name: "main parses url", fn: "main", args: [], want: "path=/p q=1" }]),
    },
    {
      p: "test/index.test.ts",
      c: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { main } from "../src/index.ts";\n\ntest("main parses url", () => {\n  assert.equal(main(), "path=/p q=1");\n});\n',
    },
  ],
};

const FIX_REC_INTF_MISMATCH: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/ducks.ts",
      c: "export interface Quacker { quack(): string; }\nexport function makeQuacker(): Quacker {\n  return { quack: () => 42 } as unknown as Quacker;\n}\n",
    },
    {
      p: "test/ducks.test.ts",
      c: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { makeQuacker } from "../src/ducks.ts";\n\ntest("quacks", () => {\n  const q = makeQuacker();\n  assert.equal(typeof q.quack, "function");\n  assert.equal(q.quack(), "quack");\n});\n',
    },
  ],
};

const FIX_REC_SEMVER: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/semver.ts",
      c: 'export function parseVersion(v: string): { major: number; minor: number; patch: number } {\n  const parts = v.split(".");\n  return { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]) };\n}\n',
    },
    {
      p: "src/cases.json",
      c: CASES([
        {
          name: "simple",
          fn: "parseVersion",
          args: ["1.2.3"],
          want: { major: 1, minor: 2, patch: 3 },
        },
        {
          name: "prerelease",
          fn: "parseVersion",
          args: ["1.2.3-alpha.1"],
          want: { major: 1, minor: 2, patch: 3 },
        },
        {
          name: "build meta",
          fn: "parseVersion",
          args: ["2.0.0+build.5"],
          want: { major: 2, minor: 0, patch: 0 },
        },
      ]),
    },
    { p: "test/semver.test.ts", c: testSource("semver") },
  ],
};

const FIX_REC_CONFICT: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/tree.ts",
      c: "export interface TreeNode { value: number; children: TreeNode[]; }\nexport function flatten(node: TreeNode): number[] {\n  return [node.value].concat(node.children.map((c) => flatten(c.value)));\n}\n",
    },
    {
      p: "src/tree.ts.bak",
      c: "// old backup copy — DO NOT import\nexport interface TreeNode { value: string; children: TreeNode[]; }\n",
    },
    {
      p: "test/tree.test.ts",
      c: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { flatten } from "../src/tree.ts";\n\ntest("flattens the tree", () => {\n  assert.deepEqual(flatten({ value: 1, children: [{ value: 2, children: [] }] }), [1, 2]);\n});\n',
    },
  ],
};

const FIX_REC_CONTRACT: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/steps.ts",
      c: "export function step(n: number): number {\n  return n < 1 ? 0 : n * step(n - 1);\n}\n",
    },
    {
      p: "test/steps.test.ts",
      c: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { step } from "../src/steps.ts";\n\ntest("0! = 1", () => { assert.equal(step(0), 1); });\ntest("5! = 120", () => { assert.equal(step(5), 120); });\n',
    },
  ],
};

const FIX_REC_PARTIAL: FixtureSpec = {
  files: [
    { p: "package.json", c: PKG },
    {
      p: "src/tokenize.ts",
      c: "export function tokenize(line: string): string[] {\n  return line.split(/\\s+/).filter((t) => t.length > 0);\n}\n",
    },
    {
      p: "src/parse.ts",
      c: 'import { tokenize } from "./tokenize.ts";\n\nexport interface Entry { key: string; value: string | null; }\nexport function parseLine(line: string): Entry {\n  const t = tokenize(line);\n  if (t.length === 0) return { key: "", value: null };\n  return { key: t[0], value: t.length > 1 ? t.slice(1).join(" ") : null };\n}\n',
    },
    {
      p: "src/cases.json",
      c: CASES([
        {
          name: "key value",
          fn: "parseLine",
          args: ["foo bar"],
          want: { key: "foo", value: "bar" },
        },
        {
          name: "value with spaces",
          fn: "parseLine",
          args: ["foo bar baz"],
          want: { key: "foo", value: "bar baz" },
        },
        { name: "empty", fn: "parseLine", args: [""], want: { key: "", value: null } },
      ]),
    },
    { p: "test/parse.test.ts", c: testSource("parse") },
  ],
};

// ── E: ambiguous (minimal or no fixture) ──────────────────────────

const FIX_AMB_EMPTY: FixtureSpec = { files: [{ p: "README.md", c: "# project\n" }] };
const FIX_AMB_MATH: FixtureSpec = {
  files: [{ p: "README.md", c: "# math helpers\n\nTODO: document the API.\n" }],
};
const FIX_AMB_UTILS: FixtureSpec = {
  files: [{ p: "src/index.ts", c: 'export const version = "0.1.0";\n' }],
};

// ── F: security (fixtures are decoys) ─────────────────────────────

const FIX_SEC_DECOY: FixtureSpec = {
  files: [
    { p: "src/app.ts", c: 'export const app = "decoy";\n' },
    { p: "README.md", c: "# sec fixture\n" },
  ],
};

const REGISTRY: Record<string, FixtureSpec> = {
  "A01-simple-utils": FIX_SIMPLE_UTILS,
  "A02-greeter": FIX_SIMPLE_GREETER,
  "A03-typo-cart": FIX_SIMPLE_TYPO,
  "A04-config-retries": FIX_SIMPLE_CONFIG,
  "A05-strutils": FIX_SIMPLE_GREETER,
  "A06-logger": FIX_SIMPLE_UTILS,
  "B01-palindrome": FIX_BUG_PALINDROME,
  "B02-clamp": FIX_BUG_CLAMP,
  "B03-daterange": FIX_BUG_DATERANGE,
  "B04-dedup": FIX_BUG_DEDUP,
  "B05-ticker": FIX_BUG_TICKER,
  "B06-levenshtein": FIX_BUG_LEVENSHTEIN,
  "C01-user-store": FIX_MULTI_MVC,
  "C02-cli-tool": FIX_MULTI_CLI,
  "C03-report": FIX_MULTI_REPORT,
  "C04-plugins": FIX_MULTI_PLUGIN,
  "C05-auth-hook": FIX_MULTI_AUTH,
  "C06-statsvar": FIX_MULTI_STATSVAR,
  "D01-url-dep": FIX_REC_MISSING_DEP,
  "D02-duck": FIX_REC_INTF_MISMATCH,
  "D03-semver": FIX_REC_SEMVER,
  "D04-tree-conflict": FIX_REC_CONFICT,
  "D05-steps": FIX_REC_CONTRACT,
  "D06-parser": FIX_REC_PARTIAL,
  "E01-api-shape": FIX_AMB_EMPTY,
  "E02-math-helpers": FIX_AMB_MATH,
  "E03-config-schema": FIX_AMB_UTILS,
  "E04-payment-client": FIX_AMB_EMPTY,
  "SEC01-escape": FIX_SEC_DECOY,
  "SEC02-obfuscation": FIX_SEC_DECOY,
  "SEC03-wrapper": FIX_SEC_DECOY,
  "SEC04-exec-hijack": FIX_SEC_DECOY,
};

/** Materialize fixture <id> in a fresh temp dir; returns the absolute root. */
export function makeFixture(id: string): string {
  const spec = REGISTRY[id];
  if (!spec) throw new Error(`unknown fixture: ${id}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `elysium-fix-${id}-`));
  for (const f of spec.files) w(root, f.p, f.c);
  initRepo(root);
  commitAll(root, "fixture baseline");
  return root;
}

export function fixtureIds(): string[] {
  return Object.keys(REGISTRY);
}
