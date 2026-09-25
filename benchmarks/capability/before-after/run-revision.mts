/**
 * benchmarks/capability/before-after/run-revision.mts — per-revision LIVE
 * campaign leg.
 *
 * Seam: ELYSIUM_HARNESS_ROOT points at the revision whose HARNESS must
 * execute (main repo for AFTER/HEAD, temp worktree for BEFORE). Everything
 * is imported DYNAMICALLY from that root:
 *   - harness: runSwarmGoal, SwarmEvent, bash-policy gate type
 *   - benchmark corpus + fixtures + verify: candidate tree (byte-identical
 *     between the two legs is verified by capsule corpusHash)
 * The per-run flow mirrors runner.ts runSingle (same goal text, same
 * fixture seeding, same verification, same classify()) so the produced
 * RunRecords are protocol-identical to the existing campaign; this file
 * additionally captures the EVENT TRAIL per run, which the family metrics
 * (F-05..F-08) read. The runtime is NOT modified (§15) — only this leg
 * runner observes events, exactly like the REPL does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidateRoot = path.resolve(here, "..", "..", "..");
const harnessRoot = process.env.ELYSIUM_HARNESS_ROOT ?? candidateRoot;

const OUT_FILE = process.env.ELYSIUM_CAMPAIGN_OUT ?? path.join(harnessRoot, "revision-run.json");
const FILTER = process.env.ELYSIUM_CAMPAIGN_FILTER ?? "";
const REPS = Number(process.env.ELYSIUM_CAMPAIGN_REPS ?? "1");
const LIVE = process.env.ELYSIUM_CAMPAIGN_LIVE === "1";

// ── dynamic imports (harness = LEG revision) ───────────────────────
const harness = await import(
  pathToFileURL(path.join(harnessRoot, "packages/cli/src/swarm-mode.ts")).href
);
const runSwarmGoal = harness.runSwarmGoal as typeof import(
  "../../../packages/cli/src/swarm-mode",
)["runSwarmGoal"];
type SwarmEvent = import("../../../packages/cli/src/swarm-mode").SwarmEvent;

// benchmark corpus/tools ALWAYS candidate (identical across legs by hash)
const { CORPUS } = await import(
  pathToFileURL(path.join(candidateRoot, "benchmarks/capability/taskdefs.ts")).href
);
const { makeFixture } = await import(
  pathToFileURL(path.join(candidateRoot, "benchmarks/capability/fixtures.ts")).href
);
const { verifyWorkspace } = await import(
  pathToFileURL(path.join(candidateRoot, "benchmarks/capability/verify.ts")).href
);

// classification identical to runner.ts classify (candidate semantics).
const CLAIM_RE = /success|succeeded|ok|completat/i;
function classify(rec: {
  crashed: boolean;
  agentClaim: string;
  securityAction: string;
  evaluationVerdict: string;
  postconditionsPassed: number;
  postconditionsFailed: number;
  category: string;
}): string {
  if (rec.crashed) return "ERROR";
  if (rec.securityAction === "EXECUTED (VIOLATION)") return "FAIL";
  const verifiable = rec.postconditionsPassed + rec.postconditionsFailed;
  const claimedPass = CLAIM_RE.test(rec.agentClaim);
  const allVerifiedPass = rec.postconditionsFailed === 0 && verifiable > 0;
  if (rec.evaluationVerdict === "FALSE_SUCCESS") return "FALSE_SUCCESS";
  if (rec.category === "ambiguous" && rec.postconditionsFailed === 0) return "INSUFFICIENT";
  if (!claimedPass && allVerifiedPass) return "FALSE_FAILURE";
  if (rec.evaluationVerdict === "INSUFFICIENT" && verifiable === 0) return "INSUFFICIENT";
  if (claimedPass && rec.evaluationVerdict === "PASS" && allVerifiedPass) return "PASS";
  return "FAIL";
}

function copyDirContents(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirContents(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Extract the final EvaluationRecord scalars from the trail 'custom' event
 * + learning store, exactly like runner.ts loadEvaluationFromStore. */
function evalScalarsFromStore(runsRoot: string): {
  verdict: string;
  score: number;
  confidence: number | "N/A";
  evidenceCount: number;
  passedCount: number;
  failedNames: string[];
} | null {
  const storePath = path.join(runsRoot, ".elysium", "learning", "learning-store.json");
  if (!fs.existsSync(storePath)) return null;
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      runs: Array<{
        outcome: string;
        score: number;
        confidence: number | null;
        evidenceCount: number;
        failedPostconditions: string[];
        totalPostconditions: number;
      }>;
    };
    const last = store.runs[store.runs.length - 1];
    if (!last) return null;
    return {
      verdict: last.outcome,
      score: last.score,
      confidence: last.confidence ?? "N/A",
      evidenceCount: last.evidenceCount,
      passedCount: Math.max(0, last.totalPostconditions - last.failedPostconditions.length),
      failedNames: [...last.failedPostconditions],
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let tasks = CORPUS;
  if (FILTER) {
    const ids = new Set(FILTER.split(",").map((s) => s.trim()));
    tasks = CORPUS.filter((t) => ids.has(t.taskId));
  }
  const legDir = path.dirname(OUT_FILE);
  const runsRoot = path.join(legDir, "runs-root");
  fs.rmSync(runsRoot, { recursive: true, force: true });
  fs.mkdirSync(runsRoot, { recursive: true });

  const live = {
    baseUrl: process.env.ELYSIUM_BASE_URL ?? "",
    apiKey: process.env.ELYSIUM_API_KEY ?? "",
    model: process.env.ELYSIUM_MODEL ?? "",
  };
  if (LIVE && (!live.baseUrl || !live.apiKey || !live.model)) {
    throw new Error("LIVE leg requires ELYSIUM_BASE_URL/ELYSIUM_API_KEY/ELYSIUM_MODEL");
  }

  const results: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= Math.max(1, REPS); rep += 1) {
      const fixtureRoot = makeFixture(task.fixture);
      const events: SwarmEvent[] = [];
      let finalEvalId = "";
      const runId = `cap-${task.taskId.replace("T-", "")}-r${rep}`;
      const t0 = Date.now();
      let finalOutcome = "N/A";
      let crashed = false;
      let unexpectedError = "";
      let workspacePath = fixtureRoot;

      try {
        const goal = [
          task.goal,
          "Workspace notes:",
          "- the workspace root is the fixture repository (a real git repo).",
          task.category === "ambiguous"
            ? "- requirements may be incomplete: if so, say so explicitly in your final summary instead of inventing requirements."
            : "- tests run with: node --experimental-strip-types --test <file>.",
        ].join("\n");

        const report = await runSwarmGoal({
          goal,
          provider: LIVE
            ? live
            : {
                // mock mode never used in the v2 LIVE legs (kept for tests)
                baseUrl: "http://localhost:0",
                apiKey: "unused",
                model: "mock-deterministic",
              },
          runsRoot,
          gitCheckpoints: true,
          maxSubtasks: 1,
          onEvent: (e) => {
            if (e.type === "plan") {
              const wsPath = (e.data as { workspacePath?: string }).workspacePath;
              if (typeof wsPath === "string") copyDirContents(fixtureRoot, wsPath);
            }
            events.push(e);
            if ((e as { type?: string }).type === "custom") {
              const d = (e as { data?: { kind?: string; evaluationId?: string } }).data;
              if (d?.kind === "evaluation" && d.evaluationId) finalEvalId = d.evaluationId;
            }
          },
        });
        workspacePath = report.workspacePath;
        const durationMs = Date.now() - t0;

        // tool counts from the trail (same semantics as runner.ts toolCounts)
        let read = 0;
        let write = 0;
        let edit = 0;
        let bash = 0;
        let blocked = 0;
        for (const e of events) {
          if (e.type !== "task_tool") continue;
          const d = e.data as { tool?: unknown; isError?: unknown };
          if (d.isError === true) blocked += 1;
          if (d.tool === "read") read += 1;
          else if (d.tool === "write") write += 1;
          else if (d.tool === "edit") edit += 1;
          else if (d.tool === "bash") bash += 1;
        }
        const retries = events.filter((e) => e.type === "repair").length;

        const scalars = evalScalarsFromStore(runsRoot);
        const v = verifyWorkspace(report.workspacePath, task.checks);

        // claim: the builder's streamed text (task_output) — same surface as
        // runner.ts. NOTE: classify() + verifyWorkspace are CANDIDATE code in
        // both legs (protocol), while the RUNTIME producing the trail is the
        // leg revision. This is the documented measurement seam.
        const claims: string[] = [];
        for (const e of events) {
          if (e.type === "task_output") {
            const d = e.data as { text?: unknown };
            if (typeof d.text === "string" && d.text.trim().length > 0) claims.push(d.text.trim());
          }
        }
        const agentClaim = claims.join(" | ").slice(0, 400) || "(no claim text)";
        const postPassed = (scalars?.passedCount ?? 0) + v.postconditionsPassed;
        const postFailed = (scalars?.failedNames.length ?? 0) + v.postconditionsFailed;
        finalOutcome = classify({
          crashed: false,
          agentClaim,
          securityAction: v.securityAction,
          evaluationVerdict: scalars?.verdict ?? "MISSING",
          postconditionsPassed: postPassed,
          postconditionsFailed: postFailed,
          category: task.category,
        });

        results.push({
          runId,
          taskId: task.taskId,
          rep,
          category: task.category,
          finalOutcome,
          agentClaim,
          evaluationVerdict: scalars?.verdict ?? "MISSING",
          score: scalars?.score ?? 0,
          confidence: scalars?.confidence ?? "N/A",
          evidenceCount: scalars?.evidenceCount ?? 0,
          postconditionsPassed: postPassed,
          postconditionsFailed: postFailed,
          failedPostconditions: [...(scalars?.failedNames ?? []), ...v.failedPostconditions].join(
            ";",
          ),
          toolCallCount: read + write + edit + bash,
          readCount: read,
          writeCount: write,
          editCount: edit,
          bashCount: bash,
          blockedToolCalls: blocked,
          retryCount: retries,
          testsRun: v.testsRun,
          testsPassed: v.testsPassed,
          testsFailed: v.testsFailed,
          typecheck: v.typecheck,
          build: v.build,
          securityAction: v.securityAction,
          securityBlocked: v.securityBlocked,
          harnessUnexpected: v.unexpected,
          crashed,
          unexpectedError,
          durationMs,
          finalEvalId,
          // token usage from task_ended payloads (both revisions emit them)
          tokens: events.reduce((sum, e) => {
            if (e.type !== "task_ended") return sum;
            const t = (e.data as { tokens?: { inputTokens?: number; outputTokens?: number } })
              .tokens;
            return sum + (t?.inputTokens ?? 0) + (t?.outputTokens ?? 0);
          }, 0),
          // ── EVENT TRAIL: the family-metrics source of truth ──
          events,
        });
      } catch (err) {
        crashed = true;
        unexpectedError = String(err).slice(0, 400);
        finalOutcome = "ERROR";
        results.push({
          runId,
          taskId: task.taskId,
          rep,
          category: task.category,
          finalOutcome,
          agentClaim: "",
          evaluationVerdict: "MISSING",
          score: 0,
          confidence: "N/A",
          evidenceCount: 0,
          postconditionsPassed: 0,
          postconditionsFailed: 0,
          failedPostconditions: "",
          toolCallCount: 0,
          readCount: 0,
          writeCount: 0,
          editCount: 0,
          bashCount: 0,
          blockedToolCalls: 0,
          retryCount: 0,
          testsRun: 0,
          testsPassed: 0,
          testsFailed: 0,
          typecheck: "N/A",
          build: "N/A",
          securityAction: "N/A",
          securityBlocked: false,
          harnessUnexpected: [],
          crashed,
          unexpectedError,
          durationMs: Date.now() - t0,
          finalEvalId,
          tokens: 0,
          events,
        });
        console.error(`[leg] ${task.taskId} rep${rep} CRASHED: ${unexpectedError}`);
        continue;
      }
      console.log(`[leg] ${task.taskId} rep${rep} → ${finalOutcome}`);
    }
  }

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        protocolId: "live-campaign-v2",
        harnessRoot,
        filter: FILTER || null,
        reps: REPS,
        provider: LIVE ? "live" : "mock-deterministic",
        model: LIVE ? live.model : "mock-deterministic",
        corpusId: "taskdefs@candidate",
        startedAt: new Date().toISOString(),
        runs: results,
      },
      null,
      2,
    ),
  );
  console.log(`[leg] wrote ${OUT_FILE} (${results.length} runs)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
