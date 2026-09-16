import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Minimal git wrapper around a working directory. Port of git_service.py v0.16.
 *
 * All commands run via execFileSync('git', [...], { cwd: repoPath }) — never
 * with shell:true. Every method is tolerant: failures are swallowed and
 * reported as null / no-op, the only exception being init() which rethrows
 * when `git init` itself fails.
 */
export class GitService {
  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /** True if the repo path exists and is a git work tree. */
  hasRepo(): boolean {
    return this.git(["rev-parse", "--is-inside-work-tree"]) !== null;
  }

  /** `git init` if the directory is not a git repo yet; ok if it already is. Throws only on real init failure. */
  init(): void {
    mkdirSync(this.repoPath, { recursive: true });
    if (this.hasRepo()) return;
    try {
      this.git(["init"], true);
    } catch (err) {
      throw new Error(
        `git init failed for ${this.repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!this.hasRepo()) {
      throw new Error(`git init failed for ${this.repoPath}: not a work tree afterwards`);
    }
  }

  /** Stage every change (including untracked). No-op on failure. */
  addAll(): void {
    this.git(["add", "-A", "--"]);
  }

  /** Commit staged changes. Returns short HEAD hash, or null when there is nothing to commit. */
  commit(message: string): string | null {
    this.addAll();
    // No --allow-empty: "nothing to commit" must fail and yield null.
    // gpgsign=false keeps commits working on hosts with signing enabled by default.
    const ok = this.git(["-c", "commit.gpgsign=false", "commit", "-m", message, "--quiet"]);
    if (ok === null) return null;
    return this.git(["rev-parse", "--short", "HEAD"]);
  }

  /** addAll + commit + lightweight tag `elysium/<tag>` (created only if missing). Returns commit hash or null. */
  checkpoint(tag: string): string | null {
    this.commit(`checkpoint: ${tag}`);
    // Tag the current state even if the commit was a no-op — a checkpoint
    // marks "this state", so resolve HEAD after the (possibly empty) commit.
    const head = this.git(["rev-parse", "--short", "HEAD"]);
    if (head === null) return null;
    const ref = `elysium/${tag}`;
    // Keep the existing tag if it already points anywhere — never move checkpoints.
    const existing = this.git(["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`]);
    if (existing === null) {
      this.git(["tag", ref]);
    }
    return head;
  }

  /** Restore a single path from a tag. No-op if anything is missing. */
  rollbackPath(path: string, tag: string): void {
    this.git(["checkout", tag, "--", path]);
  }

  /** Parse `git diff --numstat` between two tags (or worktree vs fromTag). Null when diff fails. */
  diffStat(fromTag: string, toTag?: string): DiffStat | null {
    const args = ["diff", "--numstat", fromTag];
    if (toTag !== undefined) args.push(toTag);
    const out = this.git(args);
    if (out === null) return null;
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const parts = trimmed.split("	");
      if (parts.length < 3) continue;
      // Binary files show "-" for counts; skip them from the sums but count the file.
      const ins = parts[0] ?? "-";
      const del = parts[1] ?? "-";
      const insN = ins === "-" ? 0 : Number.parseInt(ins, 10);
      const delN = del === "-" ? 0 : Number.parseInt(del, 10);
      files += 1;
      insertions += Number.isNaN(insN) ? 0 : insN;
      deletions += Number.isNaN(delN) ? 0 : delN;
    }
    return { files, insertions, deletions };
  }

  /**
   * Run git with args in the repo. Returns stdout on success (trimmed),
   * null on non-zero exit / spawn failure. Never throws.
   */
  private git(args: string[], rethrow = false): string | null {
    try {
      const out = execFileSync("git", args, {
        cwd: this.repoPath,
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return out.trim();
    } catch (err) {
      if (rethrow) throw err;
      return null;
    }
  }
}
