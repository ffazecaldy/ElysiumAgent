import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/git-service.js";

function runGit(repo: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		shell: false,
		windowsHide: true,
	}).trim();
}

describe("GitService", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "elysium-git-test-"));
		new GitService(dir).init();
		// Keep byte-exact checkouts: a global core.autocrlf would turn \n into \r\n.
		runGit(dir, ["config", "core.autocrlf", "false"]);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("init creates a repo and is idempotent", () => {
		const svc = new GitService(dir);
		expect(svc.hasRepo()).toBe(true);
		// init again on an existing repo must not throw
		expect(() => svc.init()).not.toThrow();
		expect(svc.hasRepo()).toBe(true);
	});

	it("hasRepo is false for a plain non-git directory", () => {
		const plain = mkdtempSync(join(tmpdir(), "elysium-git-plain-"));
		try {
			expect(new GitService(plain).hasRepo()).toBe(false);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("commit returns short hash; empty second commit returns null", () => {
		const svc = new GitService(dir);
		writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
		const hash1 = svc.commit("first");
		expect(hash1).toBeTruthy();
		expect(hash1).toMatch(/^[0-9a-f]{7,40}$/);
		expect(hash1).toBe(runGit(dir, ["rev-parse", "--short", "HEAD"]));

		// Nothing changed -> nothing to commit -> null
		expect(svc.commit("second empty")).toBeNull();
	});

	it("checkpoint creates elysium/<tag> and diffStat counts modifications", () => {
		const svc = new GitService(dir);
		writeFileSync(join(dir, "notes.txt"), "line1\nline2\n", "utf8");
		const hash = svc.checkpoint("task-start");
		expect(hash).toBeTruthy();

		// tag exists (lightweight, points at HEAD)
		expect(runGit(dir, ["tag", "--list", "elysium/task-start"])).toContain("elysium/task-start");
		const tagged = runGit(dir, ["rev-parse", "elysium/task-start"]);
		expect(tagged).toBe(runGit(dir, ["rev-parse", "HEAD"]));

		// modify the file, then diff from the checkpoint
		writeFileSync(join(dir, "notes.txt"), "line1\nCHANGED\nline2\nnew line\n", "utf8");
		const stat = svc.diffStat("elysium/task-start");
		expect(stat).not.toBeNull();
		expect(stat!.files).toBeGreaterThanOrEqual(1);
		expect(stat!.insertions).toBeGreaterThan(0);
		expect(stat!.deletions).toBeGreaterThanOrEqual(0);

		// diff fromTag vs a committed HEAD must match the working-tree diff
		expect(svc.commit("modify notes")).toBeTruthy();
		const stat2 = svc.diffStat("elysium/task-start", "HEAD");
		expect(stat2).toEqual(stat);
	});

	it("checkpoint with an existing tag does not move it", () => {
		const svc = new GitService(dir);
		writeFileSync(join(dir, "f.txt"), "v1\n", "utf8");
		svc.checkpoint("dup");
		const firstTagged = runGit(dir, ["rev-parse", "elysium/dup"]);
		writeFileSync(join(dir, "f.txt"), "v2\n", "utf8");
		svc.checkpoint("dup"); // same tag again -> must keep original
		expect(runGit(dir, ["rev-parse", "elysium/dup"])).toBe(firstTagged);
	});

	it("rollbackPath restores the file content from the tag", () => {
		const svc = new GitService(dir);
		const file = join(dir, "notes.txt");
		writeFileSync(file, "original content\n", "utf8");
		svc.checkpoint("task-start");

		writeFileSync(file, "totally different\n", "utf8");
		expect(readFileSync(file, "utf8")).toBe("totally different\n");

		svc.rollbackPath("notes.txt", "elysium/task-start");
		expect(readFileSync(file, "utf8")).toBe("original content\n");
	});

	it("tolerant methods never throw on invalid input", () => {
		const svc = new GitService(dir);
		expect(() => svc.addAll()).not.toThrow();
		expect(() => svc.rollbackPath("missing.txt", "elysium/nope")).not.toThrow();
		expect(svc.diffStat("elysium/does-not-exist")).toBeNull();
	});
});
