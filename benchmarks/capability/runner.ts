import fs from "node:fs";
/**
 * benchmarks/capability/runner.ts — baseline executor.
 *
 * Each run: fresh fixture repo (git) → REAL runSwarmGoal against the
 * deterministic local LLM server (real provider, real Agent loop, real bash
 * gate, real critic, real evaluation/learning/adaptive) → harness-side
 * deterministic verification → one RunRecord.
 *
 * Provider: the campaign default is the local scripted server (deterministic,
 * offline, the repo's own sanctioned offline mode). `live` mode points the
 * SAME real path at the env-configured provider (z.ai GLM). The model is
 * NEVER changed between runs of the same phase.
 */
import path from "node:path";
import type { EvaluationRecord } from "../../packages/cli/src/evaluation";
import { createLearningEngine } from "../../packages/cli/src/learning/runtime";
import {
  type RunSwarmGoalOptions,
  type SwarmEvent,
  runSwarmGoal,
} from "../../packages/cli/src/swarm-mode";
import type { ScriptedTurn } from "../../packages/core/src/types/provider";
import { makeFixture } from "./fixtures";
import { type MockSwarmServer, startMockSwarmServer } from "./mock-llm-server";
import { scriptFor } from "./scripts";
import type { TaskDef } from "./taskdefs";
import { type Verification, verifyWorkspace } from "./verify";

export interface RunRecord {
  taskId: string;
  runId: string;
  category: TaskDef["category"];
  adaptiveMode: string;
  strategyId: string;
  goal: string;
  finalOutcome:
    | "PASS"
    | "FAIL"
    | "INSUFFICIENT"
    | "FALSE_SUCCESS"
    | "FALSE_FAILURE"
    | "ERROR"
    | "N/A";

  agentClaim: string;
  evaluationVerdict: string;
  score: number;
  confidence: number | "N/A";

  evidenceCount: number;
  failedPostconditions: string;
  postconditionsPassed: number;
  postconditionsFailed: number;

  retryCount: number;
  toolCallCount: number;
  readCount: number;
  writeCount: number;
  editCount: number;
  bashCount: number;

  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  typecheck: "pass" | "fail" | "N/A";
  build: "pass" | "fail" | "N/A";

  criticVerdict: string;
  durationMs: number;

  learningIngested: boolean;
  patternTriggered: string;
  strategyConsidered: number;
  strategyApplied: boolean;

  securityAction: string;
  securityBlocked: boolean;

  unexpectedError: string;
  crashed: boolean;

  // provenance / agent-vs-harness separation
  fixture: string;
  provider: string;
  model: string;
  workspace: string;
  rep: number;
  difficulty: number;
  initialFailure: boolean;
  recoveryAttempted: boolean;
  recoverySuccessful: boolean;
  recoveryRetries: number;
  harnessUnexpected: string[];
}

const CLAIM_RE = /success|succeeded|ok|completat/i;

function blankRecord(task: TaskDef, runId: string, rep: number): RunRecord {
  return {
    taskId: task.taskId,
    runId,
    category: task.category,
    adaptiveMode: "disabled",
    strategyId: "N/A",
    goal: task.goal,
    finalOutcome: "N/A",
    agentClaim: "",
    evaluationVerdict: "N/A",
    score: 0,
    confidence: "N/A",
    evidenceCount: 0,
    failedPostconditions: "",
    postconditionsPassed: 0,
    postconditionsFailed: 0,
    retryCount: 0,
    toolCallCount: 0,
    readCount: 0,
    writeCount: 0,
    editCount: 0,
    bashCount: 0,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    typecheck: "N/A",
    build: "N/A",
    criticVerdict: "N/A",
    durationMs: 0,
    learningIngested: false,
    patternTriggered: "none",
    strategyConsidered: 0,
    strategyApplied: false,
    securityAction: "N/A",
    securityBlocked: false,
    unexpectedError: "",
    crashed: false,
    fixture: "",
    provider: "mock",
    model: "mock-deterministic",
    workspace: "",
    rep,
    difficulty: task.difficulty,
    initialFailure: false,
    recoveryAttempted: false,
    recoverySuccessful: false,
    recoveryRetries: 0,
    harnessUnexpected: [],
  };
}

function toolCounts(events: SwarmEvent[]): {
  total: number;
  read: number;
  write: number;
  edit: number;
  bash: number;
  blocked: number;
} {
  let read = 0;
  let write = 0;
  let edit = 0;
  let bash = 0;
  let blocked = 0;
  for (const e of events) {
    if (e.type !== "task_tool") continue;
    const d = e.data as { tool?: unknown; isError?: unknown };
    const name = String(d.tool ?? "");
    if (d.isError === true) blocked += 1;
    if (name === "read") read += 1;
    else if (name === "write") write += 1;
    else if (name === "edit") edit += 1;
    else if (name === "bash") bash += 1;
  }
  return { total: read + write + edit + bash, read, write, edit, bash, blocked };
}

function describeCritic(events: SwarmEvent[]): string {
  let last: string | null = null;
  for (const e of events) {
    if (e.type !== "critic") continue;
    const d = e.data as { phase?: string; passed?: boolean };
    if (d.phase === "end") last = d.passed ? "passed" : "failed";
  }
  return last ?? "N/A";
}

function countType(events: SwarmEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

/**
 * Claim-vs-outcome classification. NO score thresholds:
 * - FALSE_SUCCESS: evaluation says FALSE_SUCCESS (success claim contradicted
 *   by facts) or a security violation executed under a success claim.
 * - FALSE_FAILURE: failure/insufficient claim while EVERY verifiable
 *   postcondition (evaluator + harness) passed.
 * - PASS: success claim + evaluator PASS + zero failed postconditions.
 * - INSUFFICIENT: nothing verifiable anywhere.
 * - FAIL: everything else.
 */
function classify(rec: {
  crashed: boolean;
  agentClaim: string;
  securityAction: string;
  evaluationVerdict: string;
  postconditionsPassed: number;
  postconditionsFailed: number;
  category: string;
}): RunRecord["finalOutcome"] {
  if (rec.crashed) return "ERROR";
  if (rec.securityAction === "EXECUTED (VIOLATION)") return "FAIL";
  const verifiable = rec.postconditionsPassed + rec.postconditionsFailed;
  const claimedPass = CLAIM_RE.test(rec.agentClaim);
  const allVerifiedPass = rec.postconditionsFailed === 0 && verifiable > 0;
  if (rec.evaluationVerdict === "FALSE_SUCCESS") return "FALSE_SUCCESS";
  // Ambiguous tasks have NO task-specific postconditions by design: the
  // evaluator's generic gates only measure harness health, so the claim/outcome
  // pair is unclassifiable ⇒ INSUFFICIENT (never a FALSE_FAILURE).
  if (rec.category === "ambiguous" && rec.postconditionsFailed === 0) return "INSUFFICIENT";
  if (!claimedPass && allVerifiedPass) return "FALSE_FAILURE";
  if (rec.evaluationVerdict === "INSUFFICIENT" && verifiable === 0) return "INSUFFICIENT";
  if (claimedPass && rec.evaluationVerdict === "PASS" && allVerifiedPass) return "PASS";
  return "FAIL";
}

export interface CampaignOptions {
  tasks: TaskDef[];
  runsRoot: string;
  reps: number;
  providerKind: "mock" | "live";
  /** Live provider config (required when providerKind === "live"). */
  live?: { baseUrl: string; apiKey: string; model: string };
  maxSubtasks?: number;
}

export interface RunningServer {
  server: MockSwarmServer;
}

/** Start the deterministic local LLM server (once per campaign). */
export async function startCampaignLlm(): Promise<MockSwarmServer> {
  return startMockSwarmServer();
}

export async function runBaselineCampaign(
  opts: CampaignOptions,
  server: MockSwarmServer,
): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const task of opts.tasks) {
    for (let rep = 1; rep <= Math.max(1, opts.reps); rep += 1) {
      records.push(await runSingle(task, opts, rep, "disabled", server));
    }
  }
  return records;
}

export async function runSingle(
  task: TaskDef,
  opts: CampaignOptions,
  rep: number,
  adaptiveMode: "disabled" | "observe" | "suggest" | "apply",
  server: MockSwarmServer,
): Promise<RunRecord> {
  const fixtureRoot = makeFixture(task.fixture);
  const events: SwarmEvent[] = [];
  let finalEvalId = "";
  const runId = `cap-${task.taskId.replace("T-", "")}-r${rep}`;
  const rec = blankRecord(task, runId, rep);
  rec.fixture = fixtureRoot;
  rec.adaptiveMode = adaptiveMode;

  const t0 = Date.now();
  try {
    const goal = [
      task.goal,
      "Workspace notes:",
      "- the workspace root is the fixture repository (a real git repo).",
      task.category === "ambiguous"
        ? "- requirements may be incomplete: if so, say so explicitly in your final summary instead of inventing requirements."
        : "- tests run with: node --experimental-strip-types --test <file>.",
    ].join("\n");

    // Deterministic provider: load THIS task's scripted builder turns before
    // the swarm starts (planner/critic defaults stay generic).
    server.setBuilderTurns(scriptFor(task.taskId));

    const swarmOpts: RunSwarmGoalOptions = {
      goal,
      provider:
        opts.providerKind === "live"
          ? (opts.live as { baseUrl: string; apiKey: string; model: string })
          : { baseUrl: server.baseUrl, apiKey: "campaign-local", model: "mock-deterministic" },
      runsRoot: opts.runsRoot,
      // Production (REPL) parity: the run workspace is a real git repo with
      // checkpoints — without this the rollback postcondition is red by
      // construction on every task that writes files.
      gitCheckpoints: true,
      maxSubtasks: opts.maxSubtasks ?? 1,
      onEvent: (e) => {
        // The swarm creates its OWN scratch workspace (mkdtemp) at run start;
        // the plan event carries its absolute path. The campaign seeds the
        // task's fixture repo INTO that workspace here — this is harness-side
        // environment preparation, exactly what the REPL does when it copies a
        // project into the run workspace. The agent never sees fixtureRoot.
        if (e.type === "plan") {
          const wsPath = (e.data as { workspacePath?: string }).workspacePath;
          if (typeof wsPath === "string") {
            copyDirContents(fixtureRoot, wsPath);
          }
        }
        events.push(e);
        if (e.type === "custom") {
          const d = e.data as { kind?: string; record?: EvaluationRecord };
          if (d.kind === "evaluation") finalEvalId = String(d.evaluationId ?? "");
        }
      },
    };
    const report = await runSwarmGoal(swarmOpts);
    rec.durationMs = Date.now() - t0;

    rec.criticVerdict = describeCritic(events);
    const tc = toolCounts(events);
    rec.toolCallCount = tc.total;
    rec.readCount = tc.read;
    rec.writeCount = tc.write;
    rec.editCount = tc.edit;
    rec.bashCount = tc.bash;
    rec.retryCount = countType(events, "repair");

    // The evaluation record itself is not on the trail (only verdict/score
    // scalars + id are); the learning store is its durable projection.
    const evalRec = finalEvalId ? loadEvaluationFromStore(opts.runsRoot, finalEvalId) : null;
    if (evalRec !== null) {
      rec.evaluationVerdict = evalRec.verdict;
      rec.score = evalRec.score;
      rec.confidence = evalRec.confidence ?? "N/A";
      rec.evidenceCount = evalRec.evidenceCount;
    } else {
      rec.evaluationVerdict = "MISSING";
      rec.score = 0;
      rec.confidence = "N/A";
    }

    const v: Verification = verifyWorkspace(report.workspacePath, task.checks);
    rec.testsRun = v.testsRun;
    rec.testsPassed = v.testsPassed;
    rec.testsFailed = v.testsFailed;
    rec.typecheck = v.typecheck;
    rec.build = v.build;
    rec.securityAction = v.securityAction;
    rec.securityBlocked = v.securityBlocked;
    rec.harnessUnexpected = v.unexpected;

    const evalPassed = evalRec?.passedCount ?? 0;
    const evalFailedNames = evalRec?.failedNames ?? [];
    rec.postconditionsPassed = evalPassed + v.postconditionsPassed;
    rec.postconditionsFailed = evalFailedNames.length + v.postconditionsFailed;
    rec.failedPostconditions = [...evalFailedNames, ...v.failedPostconditions].join(";");

    const claims: string[] = [];
    for (const e of events) {
      // The builder's streamed text IS its claim surface on the trail.
      if (e.type === "task_output") {
        const d = e.data as { text?: unknown };
        if (typeof d.text === "string" && d.text.trim().length > 0) claims.push(d.text.trim());
      }
    }
    rec.agentClaim = claims.join(" | ").slice(0, 400) || "(no claim text)";
    rec.finalOutcome = classify({ ...rec, category: rec.category });

    // Adaptive observation: strategy_applied events on the trail.
    const applied = events.filter(
      (e) => e.type === "custom" && (e.data as { kind?: string }).kind === "strategy_applied",
    );
    const considered = events.filter(
      (e) => e.type === "custom" && (e.data as { kind?: string }).kind === "strategy_suggested",
    );
    rec.strategyApplied = applied.length > 0;
    rec.strategyConsidered = considered.length;
    rec.strategyId =
      applied.length > 0
        ? String((applied[0].data as { strategyId?: unknown }).strategyId ?? "N/A")
        : considered.length > 0
          ? String((considered[0].data as { strategyId?: unknown }).strategyId ?? "N/A")
          : "N/A";

    // Learning: the final EvaluationRecord must have landed in the store —
    // precise check: the store's LAST run must carry this run's verdict+score.
    const learning = createLearningEngine(opts.runsRoot);
    const runs = learning.loadStore().runs;
    const last = runs[runs.length - 1];
    rec.learningIngested =
      runs.length > 0 &&
      last.outcome === rec.evaluationVerdict &&
      Math.abs(last.score - rec.score) < 1e-9;

    // Recovery block (B/D fixtures START red by design).
    if (task.category === "bugfix" || task.category === "recovery") {
      rec.initialFailure = true;
      rec.recoveryAttempted =
        rec.bashCount > 0 || rec.retryCount > 0 || rec.editCount > 0 || rec.writeCount > 0;
      rec.recoverySuccessful = rec.testsFailed === 0 && rec.testsPassed > 0;
      rec.recoveryRetries = rec.retryCount;
    }

    rec.workspace = report.workspacePath;
  } catch (err) {
    rec.durationMs = Date.now() - t0;
    rec.crashed = true;
    rec.finalOutcome = "ERROR";
    rec.unexpectedError = String(err).slice(0, 400);
    rec.workspace = fixtureRoot;
  }
  return rec;
}

/** Where the fixture materialized (for reports). */
export function fixtureNameOf(task: TaskDef): string {
  return path.basename(task.fixture);
}

/** Recursively copy src/ into dst/ (seeding the run workspace). */
function copyDirContents(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirContents(s, d);
    else void fs.copyFileSync(s, d);
  }
}

/**
 * Recover the full EvaluationRecord from the learning store by evaluation id.
 * The learning RunRecord is the durable projection of the record: it carries
 * verdict/score/confidence/failed-postconditions/evidence count.
 */
function loadEvaluationFromStore(
  runsRoot: string,
  evaluationId: string,
): {
  verdict: string;
  score: number;
  confidence: number | null;
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
        verifiedPostconditions: number;
        totalPostconditions: number;
      }>;
    };
    // The store ingests exactly once per swarm run (the final record): the
    // LAST entry is the projection of the evaluation we just emitted.
    const runs = store.runs;
    const last = runs[runs.length - 1];
    if (!last) return null;
    void evaluationId;
    return {
      verdict: last.outcome,
      score: last.score,
      confidence: last.confidence,
      evidenceCount: last.evidenceCount,
      passedCount: Math.max(0, last.totalPostconditions - last.failedPostconditions.length),
      failedNames: [...last.failedPostconditions],
    };
  } catch {
    return null;
  }
}

export { CLAIM_RE };
