/**
 * benchmarks/capability/before-after/run-before-after.mts — LIVE Campaign v2
 * orchestrator: executes the SAME protocol against TWO harness revisions
 * (BEFORE = pre-remediation ref, AFTER = candidate) and writes a comparison.
 *
 * Mechanism (§3): git worktree pin for BEFORE (non-destructive; the user's
 * working tree is never touched), then the per-revision runner executes the
 * campaign against the harness of ITS OWN revision. Results land in
 * benchmarks/results/<campaign-id>/{before,after}/.
 *
 * Usage:
 *   npx tsx benchmarks/capability/before-after/run-before-after.mts \
 *     --baseline=a9060f3 --candidate=HEAD [--filter=T-SEC01,...] [--reps=1]
 *
 * LIVE provider config comes from .env (ELYSIUM_*), exactly like run-campaign.
 * No TYPESAFE_API_KEY / Jev requirement: DecisionProvider stays off (§11).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CAMPAIGN_PROTOCOL_ID, CAMPAIGN_VERSION, PROTOCOL, buildCapsule } from "./protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// ── args ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3) || null;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}
const BASELINE = flag("baseline") ?? "a9060f3";
const CANDIDATE = flag("candidate") ?? "HEAD";
const FILTER = flag("filter");
const REPS = Number(flag("reps") ?? String(PROTOCOL.reps));
if (REPS !== PROTOCOL.reps) {
  console.error(`[protocol] --reps must equal ${PROTOCOL.reps} for comparability (§13)`);
  process.exit(2);
}

const campaignId = `live-v2-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const outRoot = path.join(repoRoot, "benchmarks", "results", campaignId);
fs.mkdirSync(path.join(outRoot, "before"), { recursive: true });
fs.mkdirSync(path.join(outRoot, "after"), { recursive: true });

function git(args: string[], cwd = repoRoot): string {
  const require = createRequire(import.meta.url);
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`git ${args.join(" ")} failed: ${String(err)}`);
  }
}

function loadLiveConfig(): { baseUrl: string; apiKey: string; model: string } {
  const envPath = path.join(repoRoot, ".env");
  if (process.env.ELYSIUM_BASE_URL && process.env.ELYSIUM_API_KEY && process.env.ELYSIUM_MODEL) {
    return {
      baseUrl: process.env.ELYSIUM_BASE_URL,
      apiKey: process.env.ELYSIUM_API_KEY,
      model: process.env.ELYSIUM_MODEL,
    };
  }
  if (!fs.existsSync(envPath)) throw new Error("LIVE legs require ELYSIUM_* in env or .env");
  const text = fs.readFileSync(envPath, "utf8");
  const get = (k: string): string => {
    const m = text.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  const cfg = {
    baseUrl: get("ELYSIUM_BASE_URL"),
    apiKey: get("ELYSIUM_API_KEY"),
    model: get("ELYSIUM_MODEL"),
  };
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw new Error("ELYSIUM_BASE_URL / ELYSIUM_API_KEY / ELYSIUM_MODEL missing in .env");
  }
  return cfg;
}

/** Resolve a git ref to a full SHA (rejects dirty candidate tree for HEAD). */
function resolveRef(ref: string): { sha: string; short: string; worktree: string | null } {
  const sha = git(["rev-parse", ref]);
  if (ref === "HEAD") {
    const status = git(["status", "--porcelain"]);
    if (status.length > 0) {
      console.error(
        "[worktree] candidate HEAD is dirty — running the campaign on a dirty tree " +
          "would not be reproducible. Commit or stash first (§13).",
      );
      process.exit(2);
    }
    return { sha, short: sha.slice(0, 12), worktree: null }; // run in-place
  }
  // non-HEAD ref → temporary worktree (non-destructive)
  const wt = path.join(
    process.env.ELYSIUM_BENCH_WT ?? path.join(process.env.TEMP ?? "/tmp", "elysium-bench-wt"),
    sha.slice(0, 7), // match the legacy manual worktree name (reuse it)
  );
  if (!fs.existsSync(path.join(wt, "package.json"))) {
    git(["worktree", "add", wt, sha]);
  }
  return { sha, short: sha.slice(0, 12), worktree: wt };
}

interface LegResultFile {
  protocolId: string;
  campaignVersion: number;
  ref: string;
  gitSha: string;
  capsuleJson: string;
  runsJson: string;
  eventsMissing: boolean;
}

/** Execute ONE leg: the per-revision runner inside `dir`. */
async function runLeg(
  leg: "before" | "after",
  ref: string,
  resolved: { sha: string; short: string; worktree: string | null },
  live: { baseUrl: string; apiKey: string; model: string },
): Promise<LegResultFile> {
  const dir = resolved.worktree ?? repoRoot;
  console.log(`\n[${leg}] revision ${resolved.short} @ ${dir}`);
  // The runner lives in THIS revision's benchmark sources but must execute
  // the harness of ITS revision: we run the CANDIDATE sources' runner with
  // ELYSIUM_HARNESS_ROOT pointing at the leg revision. The runner imports
  // runSwarmGoal from that root (see run-revision.mts).
  const runnerEntry = path.join(
    repoRoot,
    "benchmarks",
    "capability",
    "before-after",
    "run-revision.mts",
  );
  const require = createRequire(import.meta.url);
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const outFile = path.join(outRoot, leg, "revision-run.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELYSIUM_HARNESS_ROOT: dir,
    ELYSIUM_CAMPAIGN_OUT: outFile,
    ELYSIUM_CAMPAIGN_FILTER: FILTER ?? "",
    ELYSIUM_CAMPAIGN_REPS: String(REPS),
    ELYSIUM_CAMPAIGN_LIVE: "1",
    ELYSIUM_BASE_URL: live.baseUrl,
    ELYSIUM_API_KEY: live.apiKey,
    ELYSIUM_MODEL: live.model,
    ELYSIUM_CMD_TRACE: path.join(outRoot, leg, "cmd-trace.tsv"),
  };
  try {
    // Windows: bare `npx` is a .cmd shim → spawnSync ENOENT. Resolve the real
    // tsx entry via the current node + the tsx CLI script from THIS tree's
    // node_modules (both legs share identical devDependencies by lockfile).
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    execFileSync(process.execPath, [tsxCli, "--tsconfig", "tsconfig.base.json", runnerEntry], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: PROTOCOL.runTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`[${leg}] runner failed:`, String(err).slice(0, 600));
    throw err;
  }
  if (!fs.existsSync(outFile)) throw new Error(`[${leg}] no revision-run.json produced`);
  return {
    protocolId: CAMPAIGN_PROTOCOL_ID,
    campaignVersion: CAMPAIGN_VERSION,
    ref,
    gitSha: resolved.sha,
    capsuleJson: fs.readFileSync(path.join(outRoot, leg, "capsule.json"), "utf8"),
    runsJson: fs.readFileSync(outFile, "utf8"),
    eventsMissing: false,
  };
}

async function main(): Promise<void> {
  const live = loadLiveConfig();
  console.log(`[campaign] LIVE v2  protocol=${CAMPAIGN_PROTOCOL_ID}  model=${live.model}`);
  console.log(`[campaign] baseline=${BASELINE}  candidate=${CANDIDATE}`);

  const beforeRef = resolveRef(BASELINE);
  const afterRef = resolveRef(CANDIDATE);

  const beforeCapsule = buildCapsule(beforeRef.worktree ?? repoRoot, BASELINE, live.model, "live");
  const afterCapsule = buildCapsule(afterRef.worktree ?? repoRoot, CANDIDATE, live.model, "live");
  fs.writeFileSync(
    path.join(outRoot, "before", "capsule.json"),
    JSON.stringify(beforeCapsule, null, 2),
  );
  fs.writeFileSync(
    path.join(outRoot, "after", "capsule.json"),
    JSON.stringify(afterCapsule, null, 2),
  );

  const before = await runLeg("before", BASELINE, beforeRef, live);
  const after = await runLeg("after", CANDIDATE, afterRef, live);

  // comparison (deterministic — pure functions over the two result files)
  const { compareLegsFromFiles } = await import(
    pathToFileURL(path.join(here, "compare-files.ts")).href
  );
  const out = compareLegsFromFiles(
    {
      leg: "before",
      dir: path.join(outRoot, "before"),
      ref: beforeRef.sha,
      runs: JSON.parse(before.runsJson),
      capsule: JSON.parse(before.capsuleJson),
    },
    {
      leg: "after",
      dir: path.join(outRoot, "after"),
      ref: afterRef.sha,
      runs: JSON.parse(after.runsJson),
      capsule: JSON.parse(after.capsuleJson),
    },
  );
  fs.writeFileSync(path.join(outRoot, "comparison.json"), JSON.stringify(out.json, null, 2));
  fs.writeFileSync(path.join(outRoot, "comparison.md"), out.md);
  console.log(`\n[campaign] results in ${outRoot}`);
  console.log(out.md);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
