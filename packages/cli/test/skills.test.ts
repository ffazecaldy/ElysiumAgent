/**
 * Skill loader tests: frontmatter parsing, discovery from a temp tree,
 * root precedence, and prompt-block rendering.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectSkills, parseFrontmatter, skillRoots, skillsPromptBlock } from "../src/skills";

/** Creates `<root>/<dir>/SKILL.md` and returns the file path. */
function makeSkill(
  root: string,
  dir: string,
  frontmatter: string,
  body = "# Body\n\nDo things.\n",
): string {
  const dirPath = path.join(root, dir);
  fs.mkdirSync(dirPath, { recursive: true });
  const file = path.join(dirPath, "SKILL.md");
  const fm = frontmatter.length > 0 ? `---\n${frontmatter}\n---\n` : "";
  fs.writeFileSync(file, `${fm}${body}`, "utf-8");
  return file;
}

describe("parseFrontmatter", () => {
  it("extracts name and description", () => {
    const fm = parseFrontmatter(
      "---\nname: my-skill\ndescription: Use when testing.\n---\n\n# Body",
    );
    expect(fm.name).toBe("my-skill");
    expect(fm.description).toBe("Use when testing.");
  });

  it("strips surrounding quotes from values", () => {
    const fm = parseFrontmatter("---\nname: \"quoted\"\ndescription: 'single'\n---\n");
    expect(fm.name).toBe("quoted");
    expect(fm.description).toBe("single");
  });

  it("returns nulls without frontmatter", () => {
    expect(parseFrontmatter("# Just markdown\n")).toEqual({ name: null, description: null });
  });

  it("never throws on malformed frontmatter", () => {
    expect(parseFrontmatter("---\nname:\n: : :\n---\nx").name).toBeNull();
  });
});

describe("collectSkills", () => {
  it("discovers skills, frontmatter name wins over dir name, skips dirs without SKILL.md", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-skills-"));
    makeSkill(root, "alpha", "name: beta\ndescription: First skill.");
    makeSkill(root, "gamma", "description: Second skill, dir-name fallback.");
    fs.mkdirSync(path.join(root, "no-skill-file"));
    const skills = collectSkills([root]);
    const names = skills.map((s) => s.name);
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
    expect(names).not.toContain("no-skill-file");
    const beta = skills.find((s) => s.name === "beta");
    expect(beta?.description).toBe("First skill.");
    expect(beta?.file).toBe(path.join(root, "alpha", "SKILL.md"));
  });

  it("falls back to first body line when description is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-skills-"));
    makeSkill(root, "solo", "", "# Title\n\nFirst real line.\n");
    const skills = collectSkills([root]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("solo");
    expect(skills[0]?.description).toBe("First real line.");
  });

  it("first root wins on name clash; missing roots are skipped", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-sk-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-sk-b-"));
    makeSkill(a, "x", "name: dup\ndescription: from A");
    makeSkill(b, "x", "name: dup\ndescription: from B");
    const skills = collectSkills([a, path.join(b, "does-not-exist"), b]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("from A");
  });
});

describe("skillRoots", () => {
  it("dedupes identical project-root and cwd skills dirs", () => {
    const root = path.join(os.tmpdir(), "elysium-root-dedupe");
    expect(skillRoots(root, root)).toEqual([path.join(root, "skills")]);
  });

  it("honors ELYSIUM_SKILLS_DIR override first", () => {
    const prev = process.env.ELYSIUM_SKILLS_DIR;
    process.env.ELYSIUM_SKILLS_DIR = "/custom/skills";
    try {
      const roots = skillRoots("/pr", "/cw");
      expect(roots[0]).toBe("/custom/skills");
      expect(roots).toContain(path.join("/pr", "skills"));
      expect(roots).toContain(path.join("/cw", "skills"));
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: restoring "unset" requires real deletion
        delete process.env.ELYSIUM_SKILLS_DIR;
      } else {
        process.env.ELYSIUM_SKILLS_DIR = prev;
      }
    }
  });
});

describe("skillsPromptBlock", () => {
  it("renders the index with instruction, names and file paths", () => {
    const block = skillsPromptBlock([
      { name: "s1", description: "Desc.", file: "/tmp/s1/SKILL.md" },
    ]);
    expect(block).toContain("SKILL.md");
    expect(block).toContain("s1: Desc. → /tmp/s1/SKILL.md");
  });

  it("returns an empty string with no skills (prompt unchanged)", () => {
    expect(skillsPromptBlock([])).toBe("");
  });
});
