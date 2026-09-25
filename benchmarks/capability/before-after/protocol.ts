/**
 * benchmarks/capability/before-after/protocol.ts — campaign protocol +
 * environment capsule. One source of truth for BEFORE and AFTER: any change
 * here between the two legs is a methodology violation (§13) and shows up as
 * protocolMismatch in the comparison.
 *
 * No provider calls happen in this module — pure metadata + hashing.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Campaign protocol identifier — bump ONLY when the protocol itself changes
 * (corpus, reps, timeouts, budget). BEFORE/AFTER legs MUST share this. */
export const CAMPAIGN_PROTOCOL_ID = "live-campaign-v2";
export const CAMPAIGN_VERSION = 2;

/**
 * Protocol constants — the ONLY knobs the two legs share. The runner reads
 * them from here; CLI overrides are rejected in before-after mode so the two
 * revisions cannot drift.
 */
export const PROTOCOL = {
  /** corpus version: derived from taskdefs.ts content hash at capsule time */
  reps: 1,
  maxSubtasks: 1,
  providerKind: "live" as const,
  /** per-run wall-clock budget guard (ms) — same for both legs */
  runTimeoutMs: 600_000,
  /** deterministic phases: baseline only; adaptive phase is out of scope for
   * the LIVE legs (documented runner behavior: adaptive skipped in --live) */
  adaptivePhase: false,
} as const;

export interface EnvironmentCapsule {
  campaignVersion: number;
  protocolId: string;
  os: { platform: string; release: string; arch: string };
  runtime: { node: string; tsx?: string };
  packageManager: { name: string; version: string };
  lockfileHash: string;
  corpusHash: string;
  configHash: string;
  gitSha: string;
  gitRef: string;
  harnessRevision: string;
  model: string;
  provider: string;
  startedAt: string;
}

function sha256File(filePath: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function lockfileHash(repoRoot: string): string {
  // pnpm workspaces: the root lockfile pins the whole dependency tree.
  return sha256File(path.join(repoRoot, "pnpm-lock.yaml"));
}

export function corpusHashOf(repoRoot: string): string {
  return sha256File(path.join(repoRoot, "benchmarks", "capability", "taskdefs.ts"));
}

/** Stable hash of the benchmark-relevant config (NOT the user .env). */
export function configHashOf(repoRoot: string): string {
  const parts: string[] = [];
  for (const rel of ["vitest.config.ts", "tsconfig.base.json", "biome.json"]) {
    parts.push(`${rel}:${sha256File(path.join(repoRoot, rel))}`);
  }
  return sha256Text(parts.join("|"));
}

function git(repoRoot: string, args: string[]): string {
  // lazy import keeps this module loadable in vitest browser-ish contexts
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildCapsule(
  repoRoot: string,
  ref: string,
  model: string,
  provider: string,
): EnvironmentCapsule {
  return {
    campaignVersion: CAMPAIGN_VERSION,
    protocolId: CAMPAIGN_PROTOCOL_ID,
    os: {
      platform: process.platform,
      release: require("node:os").release(),
      arch: process.arch,
    },
    runtime: { node: process.version },
    packageManager: {
      name: "pnpm",
      version: git(repoRoot, ["--version"]).split(" ")[1] ?? "unknown",
    },
    lockfileHash: lockfileHash(repoRoot),
    corpusHash: corpusHashOf(repoRoot),
    configHash: configHashOf(repoRoot),
    gitSha: git(repoRoot, ["rev-parse", "HEAD"]),
    gitRef: ref,
    harnessRevision: git(repoRoot, ["rev-parse", "--short", "HEAD"]),
    model,
    provider,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Protocol identity check between two capsules — everything that MUST match
 * for a valid comparison. Returns the list of violations (empty = valid).
 */
export function protocolViolations(
  before: EnvironmentCapsule,
  after: EnvironmentCapsule,
): string[] {
  const violations: string[] = [];
  const same = <K extends keyof EnvironmentCapsule>(k: K): boolean =>
    JSON.stringify(before[k]) === JSON.stringify(after[k]);
  if (before.protocolId !== after.protocolId) violations.push("protocolId");
  if (before.campaignVersion !== after.campaignVersion) violations.push("campaignVersion");
  if (!same("os")) violations.push("os");
  if (before.runtime.node !== after.runtime.node) violations.push("runtime.node");
  if (before.lockfileHash !== after.lockfileHash) violations.push("lockfileHash");
  if (before.corpusHash !== after.corpusHash) violations.push("corpusHash");
  if (before.model !== after.model) violations.push("model");
  if (before.provider !== after.provider) violations.push("provider");
  return violations;
}
