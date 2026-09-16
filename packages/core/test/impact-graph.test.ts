/**
 * Tests for the change impact graph: importer discovery, affected-test
 * collection and deterministic risk scoring over an in-memory workspace.
 */
import { describe, expect, it } from "vitest";
import { buildImpactGraph } from "../src/quality/impact-graph";

/** Builds an injected readFile/listFiles pair from a flat path→content map. */
function fakeWorkspace(files: Record<string, string>) {
  const paths = Object.keys(files);
  const rel = (p: string): string => {
    const posix = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (posix === ROOT) return "";
    return posix.startsWith(`${ROOT}/`) ? posix.slice(ROOT.length + 1) : posix;
  };
  return {
    readFile: (p: string): string | null => files[rel(p)] ?? null,
    listFiles: (dir: string): string[] => {
      const base = rel(dir);
      const prefix = base ? `${base}/` : "";
      const children = new Set<string>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        children.add(rest.includes("/") ? `${rest.split("/")[0]}/` : rest);
      }
      return [...children];
    },
  };
}

const ROOT = "/ws";

describe("buildImpactGraph", () => {
  const base = {
    workspaceRoot: ROOT,
    ...fakeWorkspace({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": `import { a } from "./a";\nexport const b = a + 1;\n`,
      "src/a.test.ts": `import { a } from "./a";\ntest("a", () => {});\n`,
      "src/unrelated.ts": `import path from "path";\n`,
    }),
  };

  it("finds importers by relative specifier", () => {
    const g = buildImpactGraph({ ...base, changedFiles: ["src/a.ts"] });
    expect(g.changedFiles).toEqual(["src/a.ts"]);
    expect(g.importers["src/a.ts"]).toEqual(["src/a.test.ts", "src/b.ts"]);
  });

  it("finds importers by bare basename specifier", () => {
    const g = buildImpactGraph({
      workspaceRoot: ROOT,
      ...fakeWorkspace({
        "src/a.ts": "export const a = 1;\n",
        "src/c.ts": `import { a } from "a";\n`,
      }),
      changedFiles: ["src/a.ts"],
    });
    expect(g.importers["src/a.ts"]).toEqual(["src/c.ts"]);
  });

  it("excludes the changed file itself and non-importers", () => {
    const g = buildImpactGraph({ ...base, changedFiles: ["src/b.ts"] });
    expect(g.importers["src/b.ts"]).toEqual([]);
  });

  it("collects affected tests from importers and changed files", () => {
    const g = buildImpactGraph({ ...base, changedFiles: ["src/a.ts", "src/a.test.ts"] });
    expect(g.affectedTests.sort()).toEqual(["src/a.test.ts"]);
  });

  it("flags a changed file as affected test even with no importers", () => {
    const g = buildImpactGraph({ ...base, changedFiles: ["src/a.test.ts"] });
    expect(g.affectedTests).toEqual(["src/a.test.ts"]);
    expect(g.importers["src/a.test.ts"]).toEqual([]);
  });

  it("honors a custom test convention", () => {
    const ws = {
      workspaceRoot: ROOT,
      ...fakeWorkspace({
        "src/a.ts": "export const a = 1;\n",
        "tests/test_a.py": "from a import a\n",
      }),
      testConvention: /(^|\/)tests\//,
    };
    const g = buildImpactGraph({ ...ws, changedFiles: ["src/a.ts"] });
    expect(g.importers["src/a.ts"]).toEqual(["tests/test_a.py"]);
    expect(g.affectedTests).toEqual(["tests/test_a.py"]);
  });

  it("scans python importers and respects test conventions", () => {
    const g = buildImpactGraph({
      workspaceRoot: ROOT,
      ...fakeWorkspace({
        "pkg/mod.py": "value = 1\n",
        "pkg/test_mod.py": "from pkg.mod import value\n",
      }),
      changedFiles: ["pkg/mod.py"],
    });
    expect(g.importers["pkg/mod.py"]).toEqual(["pkg/test_mod.py"]);
    expect(g.affectedTests).toEqual(["pkg/test_mod.py"]);
  });

  it("risk level grows with fan-in", () => {
    const files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" };
    for (let i = 0; i < 12; i++) files[`src/u${i}.ts`] = `import { a } from "./a";\n`;
    const lowFanIn = buildImpactGraph({
      workspaceRoot: ROOT,
      ...fakeWorkspace(files),
      changedFiles: ["src/a.ts"],
    });
    expect(lowFanIn.riskScore.score).toBe(Math.round(Math.min(10, 1 + 12 * 0.5 + 0 * 0.5)));
    expect(lowFanIn.riskScore.level).toBe("high");

    const lonely = buildImpactGraph({
      workspaceRoot: ROOT,
      ...fakeWorkspace({ "src/lonely.ts": "export const x = 1;\n" }),
      changedFiles: ["src/lonely.ts"],
    });
    expect(lonely.riskScore.score).toBe(1);
    expect(lonely.riskScore.level).toBe("low");
  });

  it("caps the score at 10 and stays deterministic", () => {
    const files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" };
    for (let i = 0; i < 40; i++) files[`src/u${i}.ts`] = `require("./a");\n`;
    const opts = {
      workspaceRoot: ROOT,
      ...fakeWorkspace(files),
      changedFiles: ["src/a.ts"],
    };
    const first = buildImpactGraph(opts);
    const second = buildImpactGraph(opts);
    expect(first.riskScore.score).toBe(10);
    expect(first.riskScore.level).toBe("high");
    expect(second).toEqual(first);
  });

  it("normalizes changed paths to workspace-relative posix keys", () => {
    const g = buildImpactGraph({ ...base, changedFiles: [`${ROOT}/src/a.ts`] });
    expect(g.changedFiles).toEqual(["src/a.ts"]);
    expect(g.importers["src/a.ts"]).toEqual(["src/a.test.ts", "src/b.ts"]);
  });
});
