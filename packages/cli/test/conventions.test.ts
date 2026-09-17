/**
 * Conventions loader tests: shallow discovery (root marker files + one
 * `.elysium/conventions` dir), multi-section scoped parsing, path-based
 * rule filtering, and the rendered block (null on no rules, char cap with
 * a `[truncated]` note).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConventionsBlock, discoverConventions, rulesForPaths } from "../src/conventions";

const roots: string[] = [];

/** Creates a tracked temp root, cleaned up after the test file. */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-conv-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Writes a file (creating parent dirs), relative to root. */
function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
}

describe("discoverConventions", () => {
  it("finds AGENTS.md sections, CLAUDE.md default body, and .elysium/conventions/*.md", () => {
    const root = makeRoot();
    write(
      root,
      "AGENTS.md",
      [
        "Always run biome before committing.",
        "",
        "## scope: default",
        "Default rule one.",
        "",
        "## scope: src/frontend/**",
        "Frontend rule.",
        "Second frontend line.",
        "",
        "## scope: docs/**",
        "Docs rule.",
        "",
      ].join("\n"),
    );
    write(root, "CLAUDE.md", "Top-level preamble line.\n\nMore preamble.\n");
    write(root, ".elysium/conventions/testing.md", "## scope: packages/*/test/**\nTest rule.\n");

    const rules = discoverConventions(root);
    const key = (r: { scope: string; source: string }): string => `${r.source}::${r.scope}`;

    // Preamble lines → one default rule from AGENTS.md; scoped sections parsed.
    expect(rules.map(key)).toEqual([
      "AGENTS.md::default",
      "AGENTS.md::default",
      "AGENTS.md::src/frontend/**",
      "AGENTS.md::docs/**",
      "CLAUDE.md::default",
      ".elysium/conventions/testing.md::packages/*/test/**",
    ]);
    expect(rules[0]?.body).toBe("Always run biome before committing.");
    expect(rules[2]?.body).toBe("Frontend rule.\nSecond frontend line.");
    expect(rules[4]?.body).toContain("Top-level preamble line.");
    expect(rules[4]?.source).toBe("CLAUDE.md");
  });

  it("returns [] on an empty dir and skips unreadable files without throwing", () => {
    expect(discoverConventions(makeRoot())).toEqual([]);

    const root = makeRoot();
    // A directory named like a marker file: not a regular file → skipped.
    fs.mkdirSync(path.join(root, "AGENTS.md"));
    // Conventions "dir" is actually a file → readdir fails → skipped.
    fs.writeFileSync(path.join(root, ".elysium"), "x", "utf-8");
    expect(discoverConventions(root)).toEqual([]);
    expect(() => discoverConventions(path.join(root, "does-not-exist"))).not.toThrow();
  });
});

describe("rulesForPaths", () => {
  const rules = [
    { scope: "default", source: "AGENTS.md", body: "always" },
    { scope: "src/frontend/**", source: "AGENTS.md", body: "fe" },
    { scope: "src/backend/**", source: "AGENTS.md", body: "be" },
    { scope: "*.md", source: "docs.md", body: "one-segment md" },
    { scope: "packages/cli", source: "dir.md", body: "dir prefix" },
  ];

  it("returns defaults + only scopes matching at least one path", () => {
    const picked = rulesForPaths(rules, ["src/frontend/app.ts"]);
    const scopes = picked.map((r) => r.scope);
    expect(scopes).toContain("default");
    expect(scopes).toContain("src/frontend/**");
    expect(scopes).not.toContain("src/backend/**");
    expect(scopes).not.toContain("*.md");
    expect(scopes).not.toContain("packages/cli");
  });

  it("matches ** across depths, * within one segment, and bare dir prefixes", () => {
    expect(rulesForPaths(rules, ["src/frontend/deep/nested/x.ts"]).map((r) => r.scope)).toContain(
      "src/frontend/**",
    );
    expect(rulesForPaths(rules, ["README.md"]).map((r) => r.scope)).toContain("*.md");
    expect(rulesForPaths(rules, ["packages/cli/src/index.ts"]).map((r) => r.scope)).toContain(
      "packages/cli",
    );
    expect(rulesForPaths(rules, []).map((r) => r.scope)).toEqual(["default"]);
  });
});

describe("buildConventionsBlock", () => {
  it("renders null when no rules apply", () => {
    const root = makeRoot();
    expect(buildConventionsBlock(root, ["src/a.ts"])).toBeNull();

    write(root, "AGENTS.md", "## scope: src/backend/**\nBackend only.\n");
    expect(buildConventionsBlock(root, ["src/frontend/a.ts"])).toBeNull();
  });

  it("renders '<scope>: <body>' lines for relevant rules", () => {
    const root = makeRoot();
    write(
      root,
      "AGENTS.md",
      ["## scope: default", "Use pnpm.", "", "## scope: src/frontend/**", "Use React 19."].join(
        "\n",
      ),
    );
    const block = buildConventionsBlock(root, ["src/frontend/app.tsx"]);
    expect(block).toContain("## Project conventions (relevant rules)");
    expect(block).toContain("default: Use pnpm.");
    expect(block).toContain("src/frontend/**: Use React 19.");
  });

  it("caps the block at maxChars with a [truncated] note", () => {
    const root = makeRoot();
    write(root, "AGENTS.md", `## scope: default\n${"x".repeat(500)}\n`);
    const block = buildConventionsBlock(root, ["a.ts"], 200);
    expect(block).not.toBeNull();
    expect(block?.length).toBeLessThanOrEqual(200);
    expect(block?.endsWith("[truncated]")).toBe(true);
  });
});
