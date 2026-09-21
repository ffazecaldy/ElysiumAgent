/** Regression tests for the probe campaign holes (B7/B8/B9/B11/B18/B10). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitService } from "@elysium/core";
import { redactObject } from "@elysium/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildDecisionRecord } from "../src/decision/fingerprint";
import { minimizeState, stateHash } from "../src/decision/sanitize";
import {
  type HookContext,
  judgeEvidenceStrength,
  refineFailureCause,
  refineRisk,
} from "../src/decision/swarm-hooks";
import { createSwarmGit } from "../src/swarm-git";
import { checkPath, normalizePath } from "../src/task-ownership";

const tmpDirs: string[] = [];
function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `probe-fix-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf-8",
    shell: false,
  }).trim();
}

const ctx = (mode: "shadow" | "enforce"): HookContext => ({
  evaluator: {
    id: "probe",
    available: () => true,
    evaluate: async () => ({
      ok: true,
      latencyMs: 1,
      answers: {
        cause: { kind: "choice", choice: "MADE_UP_CAUSE", probabilities: {}, confidence: 0.99 },
        risk_level: { kind: "score", score: "low", probabilities: {}, confidence: 0.99 },
        security_sensitive: { kind: "noul", probability: 0.9 },
        requires_review: { kind: "noul", probability: 0.9 },
        establishes_claim: { kind: "noul", probability: 0.9 },
        strength: { kind: "score", score: "strong", probabilities: {}, confidence: 0.2 },
      },
    }),
  },
  mode,
  runId: "probe-run",
  taskId: null,
  record: () => {},
});

describe("probe regressions: decision boundary hardening (B7/B8/B9)", () => {
  it("stateHash survives a cyclic state (B7)", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => stateHash(cyc)).not.toThrow();
    expect(stateHash(cyc)).toHaveLength(16);
  });

  it("buildDecisionRecord survives a cyclic state (B7)", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const rec = buildDecisionRecord({
      runId: "r",
      taskId: null,
      useCase: "bash-gray-zone",
      providerId: "p",
      mode: "shadow",
      outcome: { verdict: "ALLOW", source: "deterministic", reason: "x" },
      semantic: null,
      evaluation: null,
      state: cyc,
    });
    expect(rec.stateHash).toHaveLength(16);
  });

  it("stateHash is deterministic for the same non-cyclic state", () => {
    expect(stateHash({ q: 1, b: "x" })).toBe(stateHash({ q: 1, b: "x" }));
  });

  it("refineFailureCause rejects a made-up cause outside the taxonomy (B8)", async () => {
    const r = await refineFailureCause(ctx("enforce"), "boom", ["UNKNOWN"]);
    expect(r.cause).toBeNull();
  });

  it("refineFailureCause still accepts a real taxonomy cause", async () => {
    const enforcing: HookContext = {
      ...ctx("enforce"),
      evaluator: {
        id: "probe",
        available: () => true,
        evaluate: async () => ({
          ok: true,
          latencyMs: 1,
          answers: {
            cause: { kind: "choice", choice: "TEST_FAILURE", probabilities: {}, confidence: 0.9 },
          },
        }),
      },
    };
    const r = await refineFailureCause(enforcing, "boom", ["UNKNOWN"]);
    expect(r.cause).toBe("TEST_FAILURE");
  });

  it("refineRisk does not leak enforce-only signals in shadow mode (B9)", async () => {
    const r = await refineRisk(ctx("shadow"), {
      taskSummary: "s",
      changedFiles: ["a.ts"],
      dependents: 1,
      testsAffected: 1,
      criticalPath: true,
      deterministicLevel: "low",
      ownershipEnforced: true,
    });
    expect(r.securitySensitive).toBeNull();
    expect(r.requiresReview).toBeNull();
    expect(r.level).toBe("low");
  });

  it("judgeEvidenceStrength still maps low confidence to UNKNOWN (guard intact)", async () => {
    const r = await judgeEvidenceStrength(ctx("enforce"), {
      claimedBehavior: "b",
      beforeExitCode: 1,
      afterExitCode: 0,
      targeted: true,
      newTestAdded: true,
      changedFiles: ["a.ts"],
    });
    expect(r.strength).toBe("UNKNOWN");
  });
});

describe("probe regressions: secret-guard cycle safety (B18)", () => {
  it("redactObject collapses a cycle instead of overflowing", () => {
    const cyc: Record<string, unknown> = { k: "password: hunter2222" };
    cyc.self = cyc;
    const out = redactObject(cyc) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("hunter2222");
  });

  it("redactObject keeps non-cyclic objects structurally intact", () => {
    const out = redactObject({ a: { b: ["x", 1, true] } }) as Record<string, unknown>;
    expect(out).toEqual({ a: { b: ["x", 1, true] } });
  });
});

describe("probe regressions: task-ownership dot-segment collapse (B10)", () => {
  const policy = { allowed: ["src/**"], readOnly: ["docs/**"], forbidden: ["src/secrets/**"] };

  it("collapses inner dot-segments before glob matching", () => {
    expect(normalizePath("src/../escape.ts")).toBe("escape.ts");
    expect(checkPath(policy, "src/../escape.ts", "write").allowed).toBe(false);
    expect(checkPath(policy, "src/a/../b.ts", "write").allowed).toBe(true);
  });

  it("leading .. stays and cannot match an anchored allowed glob (fail closed)", () => {
    expect(normalizePath("../escape.ts")).toBe("../escape.ts");
    expect(checkPath(policy, "../escape.ts", "write").allowed).toBe(false);
  });

  it("keeps the forbidden glob working across normalization", () => {
    expect(checkPath(policy, "src/secrets/k.ts", "write").allowed).toBe(false);
    expect(checkPath(policy, "src/secrets/../secrets/k.ts", "write").allowed).toBe(false);
  });
});

describe("probe regressions: verified git rollback (B11)", () => {
  it("rollback removes an untracked file that did not exist at the tag", () => {
    const dir = makeTempDir();
    const svc = new GitService(dir);
    svc.init();
    fs.writeFileSync(path.join(dir, "a.txt"), "v1");
    svc.checkpoint("task-1");
    fs.writeFileSync(path.join(dir, "new-untracked.txt"), "post-tag");
    const rolled = createSwarmGit(dir).rollbackFiles(["a.txt", "new-untracked.txt"], "task-1");
    expect(fs.existsSync(path.join(dir, "new-untracked.txt"))).toBe(false);
    expect(rolled).toBe(2); // both restores verified
  });

  it("rollback restores a modified tracked file byte-exact", () => {
    const dir = makeTempDir();
    const svc = new GitService(dir);
    svc.init();
    fs.writeFileSync(path.join(dir, "a.txt"), "v1");
    svc.checkpoint("task-1");
    fs.writeFileSync(path.join(dir, "a.txt"), "v2-broken");
    expect(createSwarmGit(dir).rollbackFiles(["a.txt"], "task-1")).toBe(1);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("v1");
  });

  it("unknown tag stays a no-op (historical contract)", () => {
    const dir = makeTempDir();
    const svc = new GitService(dir);
    svc.init();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    expect(() => svc.rollbackPath("a.txt", "elysium/nope")).not.toThrow();
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("x");
    expect(createSwarmGit(dir).rollbackFiles(["a.txt"], "never-tagged")).toBe(0);
  });

  it("refuses a rollback path resolving outside the repo", () => {
    const dir = makeTempDir();
    const svc = new GitService(dir);
    svc.init();
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    svc.checkpoint("t");
    expect(() => svc.rollbackPath("../outside.txt", "elysium/t")).toThrow(/outside/);
  });

  it("checkpoint tag immutability preserved (never moved)", () => {
    const dir = makeTempDir();
    const svc = new GitService(dir);
    svc.init();
    fs.writeFileSync(path.join(dir, "a.txt"), "v1");
    svc.checkpoint("plan");
    const tagCommit = git(dir, ["rev-parse", "elysium/plan^{commit}"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "v2");
    svc.checkpoint("plan");
    // The tag still points at the FIRST checkpoint commit.
    expect(git(dir, ["rev-parse", "elysium/plan^{commit}"])).toBe(tagCommit);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf-8")).toBe("v2");
  });
});

describe("minimizeState stays cycle-hostile-free end-to-end", () => {
  it("handles a cyclic nested value without crashing", () => {
    const nested: Record<string, unknown> = { list: ["a.ts"] };
    nested.self = nested;
    const out = minimizeState({ files: nested } as Record<string, unknown>);
    expect(JSON.stringify(out)).not.toContain("[Circular]");
  });
});
