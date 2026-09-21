/**
 * packages/cli/src/swarm-git.ts — per-run git checkpoints (E6 wiring).
 *
 * Wraps the core GitService so the swarm loop can checkpoint the workspace
 * at each phase and roll files back before a repair re-spawn. Failure of git
 * NEVER blocks the run: every function degrades to null/0. With
 * `enabled: false` everything is a no-op (default for tests/back-compat).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GitService } from "@elysium/core";

/** Checkpoint/rollback surface used by the swarm loop. */
export interface SwarmGit {
  /** Commit + tag `elysium/<phase>`; returns the tag or null. */
  checkpoint(phase: string): string | null;
  /** Roll each path back to a phase tag; returns how many succeeded. */
  rollbackFiles(paths: string[], phase: string): number;
}

/** True when git operations should run. */
export interface SwarmGitOptions {
  enabled: boolean;
}

/** Build a SwarmGit bound to the run workspace. */
export function createSwarmGit(
  workspace: string,
  options: SwarmGitOptions = { enabled: true },
): SwarmGit {
  if (!options.enabled) {
    return {
      checkpoint: () => null,
      rollbackFiles: () => 0,
    };
  }
  const service = new GitService(workspace);
  try {
    service.init();
  } catch {
    // Git unavailable/broken → permanent no-op for this run (never throws).
    return {
      checkpoint: () => null,
      rollbackFiles: () => 0,
    };
  }

  /** Resolve a full ref, or null when it does not exist. */
  const refExists = (ref: string): boolean => {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${ref}`], {
        cwd: workspace,
        encoding: "utf-8",
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  return {
    checkpoint(phase: string): string | null {
      try {
        let result = service.checkpoint(phase);
        if (result === null && !refExists(`elysium/${phase}`)) {
          // Empty workspace → no HEAD yet → the checkpoint could not commit.
          // Drop a marker file so the first commit exists, then retry once.
          const marker = path.join(workspace, ".elysium-run");
          if (!fs.existsSync(marker)) {
            fs.writeFileSync(marker, `elysium run · checkpoint ${phase}\n`);
            result = service.checkpoint(phase);
          }
        }
        return result;
      } catch {
        return null;
      }
    },
    rollbackFiles(paths: string[], phase: string): number {
      // Rollback targets the FULL tag ref (`elysium/<phase>`): the bare phase
      // name is not a git ref — checkout would silently no-op (GitService
      // swallows the failure) and leave the broken files in place.
      const ref = `elysium/${phase}`;
      if (!refExists(ref)) {
        return 0;
      }
      // Count only VERIFIED restores: rollbackPath throws when the worktree
      // does not really match the tag afterwards, and a thrown path is a
      // failure, never a success.
      let done = 0;
      for (const p of paths) {
        try {
          service.rollbackPath(p, ref);
          done++;
        } catch {
          // verification failed → not counted
        }
      }
      return done;
    },
  };
}
