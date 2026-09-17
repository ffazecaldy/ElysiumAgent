/**
 * Swarmloop runtime mode — the "swarm goal" gauntlet loop as a callable seam.
 *
 * Pipeline (skill-faithful, depth ≤ 2):
 *  1. PLANNING TURN — one direct LLM call decomposes the goal into at most
 *     `maxSubtasks` subtasks with acceptance criteria (strict-JSON contract,
 *     tolerantly extracted; falls back to a single subtask = the whole goal).
 *  2. EXECUTION — an {@link Orchestrator} runs a real {@link Agent} per
 *     subtask with the builtin tools scoped to a fresh per-RUN mkdtemp
 *     workspace, bounded turns, concurrency 2 and 1 repair round.
 *  3. CRITIC — a fresh-context LLM judge per attempt (only task + result),
 *     tolerant parse defaulting to passed on unparseable output.
 *  4. QUALITY GATE — structuralJudge per result vs its criteria; weighted
 *     scores ride on the returned report.
 *
 * Error policy: every LLM/provider failure emits a SwarmEvent "error" first,
 * then the original error is rethrown — rendering belongs to the caller.
 * This module never terminates the process.
 *
 * Visibility: builder streamed text is surfaced as "task_output" events
 * (batched per line, ~200ms timer fallback) and every executed builder tool
 * as a "task_tool" event, so callers can show what each subagent is doing
 * while it runs.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type CriticVerdict,
  type GateArtifact,
  type HarnessEvent,
  type LlmProvider,
  OpenAICompatibleProvider,
  type OrchestrationPlan,
  type OrchestrationReport,
  Orchestrator,
  QualityGate,
  type SpawnFn,
  type SubagentResult,
  type SubagentTask,
  type TokenUsage,
  ToolRegistry,
  type ToolResultMessage,
  createBuiltinTools,
  createDefaultRubric,
  riskScore,
  structuralJudge,
} from "@elysium/core";
import { redactObject, redactText } from "@elysium/core";
import { collectEnvSecretValues, gateBashCommand } from "./bash-gate";
import type { BashCommandPolicy } from "./policy/bash-policy";
import { type TaskPathPolicy, checkPath } from "./task-ownership";
import { finishRun, recordRunPhase as markRunPhase, startRunRecord } from "./swarm-run-store";
import { markInterrupted } from "./run-state";
import { createSwarmGit } from "./swarm-git";

// ── Public seam ───────────────────────────────────────────────────

/**
 * The nine event kinds surfaced through {@link RunSwarmGoalOptions.onEvent}.
 * Per-kind `data` payloads:
 * - `plan`         → `{ goal, source, subtasks: [{id, goal, acceptanceCriteria}], workspacePath }`
 * - `task_started` → `{ taskId, goal, ...orchestrator data }`
 * - `task_ended`   → `{ taskId, status, durationMs, attempts, tokens? }` — tokens present when the builder reported usage
 * - `task_output`  → `{ taskId, text }` — line-batched builder streamed text
 * - `task_tool`    → `{ taskId, tool, isError }` — after each builder tool execution
 * - `critic`       → `{ taskId, phase, passed?, gaps? }`
 * - `repair`       → `{ taskId, round }`
 * - `done`         → `{ goal, allPassed, subtaskCount, scores, workspacePath, totalDurationMs }`
 * - `error`        → `{ scope, message, taskId? }`
 */
export type SwarmEventType =
  | "plan"
  | "task_started"
  | "task_ended"
  | "task_output"
  | "task_tool"
  | "critic"
  | "repair"
  | "done"
  | "error";

/** Runtime-mode event. `data` payloads are kind-specific free-form records. */
export interface SwarmEvent {
  type: SwarmEventType;
  data: Record<string, unknown>;
}

/** Provider coordinates shared by every LLM call of the run. */
export interface SwarmProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Options for {@link runSwarmGoal}. */
export interface RunSwarmGoalOptions {
  goal: string;
  provider: SwarmProviderConfig;
  /** Upper bound for the planner's subtask count. Default 3. */
  maxSubtasks?: number;
  /** Optional event sink for the whole gauntlet loop. */
  onEvent?: (e: SwarmEvent) => void;
  /** Cooperative cancellation: when aborted, the run stops (planner, builder
   * tool calls and critic requests all observe the same signal). */
  signal?: AbortSignal;
  /** Optional per-task path ownership: taskId → policy. When a policy exists
   * for the task being spawned, its write/edit tool calls are checked in
   * write mode (default-deny outside `allowed` globs) and read calls in read
   * mode (blocked only by `forbidden`); denied calls get an isError result.
   * Absent for a task → no enforcement (backward compatible).
   * Bash commands go through the bash-policy gate for every task (see
   * `bashPolicy` below). */
  taskPolicies?: Map<string, TaskPathPolicy>;
  /** Bash command policy applied to EVERY task's shell calls in this run.
   * Default (conservative, documented in config.ts): builtin deny-list,
   * writable roots = the run workspace, network DENIED — swarm workers are
   * unattended and must not reach the network. Blocked commands never spawn;
   * approval-requiring commands are refused in swarm context (no interactive
   * approver exists there — documented choice). */
  bashPolicy?: BashCommandPolicy;
  /** When set, the run is recorded durably under
   * `<runsRoot>/.elysium/runs/<runId>/elysium-run.json` (crash recovery +
   * `resume` support). Absent → no persistence (backward compatible, keeps
   * tests hermetic). */
  runsRoot?: string;
  /** Per-run git checkpoints (E6): the run workspace becomes a real git repo
   * with a tag after planning (`elysium/plan`) and after each builder task
   * (`elysium/task-<id>`); repair re-spawns roll artifact files back to the
   * task's checkpoint first. Default FALSE (no repo created — back-compat
   * and hermetic tests); the interactive REPL enables it. */
  gitCheckpoints?: boolean;
}

/** Per-subtask quality-gate outcome attached to the orchestration report. */
export interface SwarmTaskScore {
  taskId: string;
  weighted: number;
  passed: boolean;
}

/** What {@link runSwarmGoal} resolves with. */
export interface SwarmGoalReport extends OrchestrationReport {
  scores: SwarmTaskScore[];
  /** Absolute path of the per-run scratch workspace (left in place for inspection). */
  workspacePath: string;
}

// ── Internals ─────────────────────────────────────────────────────

interface PlannedSubtask {
  id: string;
  goal: string;
  acceptanceCriteria: string[];
}

const DEFAULT_MAX_SUBTASKS = 3;
const BUILDER_MAX_TURNS = 6;
/**
 * Concurrency: every planned subtask runs in PARALLEL (the view shows at
 * most 3 live panes; the rest stream beyond them). Bounded by the plan
 * size, which is itself bounded by the effort mode's maxSubtasks.
 */
const MAX_CONCURRENCY = Number.POSITIVE_INFINITY;
/** Per-spawn hard cap: a hung builder stream must not wedge the whole run. */
function swarmSpawnTimeoutMs(): number {
  const raw = Number(process.env.ELYSIUM_SPAWN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}
const REPAIR_ROUNDS = 1;
/** Marker the Orchestrator appends to task context when re-spawning after critic gaps. */
const REPAIR_MARKER = /Critic feedback, repair round (\d+)/;

const JSON_ONLY_SYSTEM_PROMPT = "You output only valid JSON. No markdown fences, no commentary.";

const BUILDER_SYSTEM_PROMPT = "You are a focused builder agent. Complete the subtask.";

const GENERIC_CRITERIA = [
  "The goal is fully addressed with concrete output",
  "All produced artifacts are complete and non-placeholder",
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant strict-JSON extraction: the first brace block of the text, found
 * with string-aware brace matching so braces inside JSON strings are ignored.
 */
function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** One streaming completion reduced to its final assistant text. */
async function completeOnce(
  provider: LlmProvider,
  systemPrompt: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  for await (const event of provider.stream({
    systemPrompt,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (event.type === "text_delta") {
      text += event.delta;
    } else if (event.type === "done") {
      text = event.message.text.length > 0 ? event.message.text : text;
      break;
    } else if (event.type === "error") {
      throw event.error;
    }
  }
  return text;
}

// ── Planning ──────────────────────────────────────────────────────

function fallbackSubtask(goal: string): PlannedSubtask {
  return {
    id: "task-1",
    goal,
    acceptanceCriteria: [...GENERIC_CRITERIA],
  };
}

function normalizePlannerSubtasks(parsed: unknown): PlannedSubtask[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.subtasks)) return [];
  const out: PlannedSubtask[] = [];
  for (const entry of parsed.subtasks) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    const goal = entry.goal;
    if (typeof id !== "string" || id.trim().length === 0) continue;
    if (typeof goal !== "string" || goal.trim().length === 0) continue;
    const rawCriteria = entry.acceptanceCriteria;
    const criteria = Array.isArray(rawCriteria)
      ? rawCriteria.filter(
          (c: unknown): c is string => typeof c === "string" && c.trim().length > 0,
        )
      : [];
    out.push({
      id: id.trim(),
      goal: goal.trim(),
      acceptanceCriteria: criteria.length > 0 ? criteria : [...GENERIC_CRITERIA],
    });
  }
  return out;
}

/** Guarantees unique subtask ids (the Orchestrator rejects duplicates). */
function withUniqueIds(subtasks: PlannedSubtask[]): PlannedSubtask[] {
  const seen = new Map<string, number>();
  return subtasks.map((task) => {
    const count = seen.get(task.id) ?? 0;
    seen.set(task.id, count + 1);
    if (count === 0) return task;
    return { ...task, id: `${task.id}-${count + 1}` };
  });
}

/** @internal testing export: tolerant planner-output parse. */
export function parsePlannerOutput(
  raw: string,
  goal: string,
  maxSubtasks: number,
): { subtasks: PlannedSubtask[]; source: "llm" | "fallback" } {
  const block = extractFirstJsonBlock(raw);
  if (block !== null) {
    try {
      const parsed: unknown = JSON.parse(block);
      const normalized = normalizePlannerSubtasks(parsed).slice(0, maxSubtasks);
      if (normalized.length > 0) {
        return { subtasks: withUniqueIds(normalized), source: "llm" };
      }
    } catch {
      // Tolerant: fall through to the deterministic fallback plan.
    }
  }
  return { subtasks: [fallbackSubtask(goal)], source: "fallback" };
}

function buildPlannerPrompt(goal: string, n: number): string {
  return [
    `Decompose the goal into EXACTLY ${n} subtasks (N no more than ${n}).`,
    "Respond STRICT JSON: subtasks array of {id, goal, acceptanceCriteria array}",
    "",
    "GOAL:",
    goal,
  ].join("\n");
}

// ── Critic ────────────────────────────────────────────────────────

/** @internal testing export: tolerant critic-verdict parse. */
export function parseCriticVerdict(raw: string): CriticVerdict {
  const block = extractFirstJsonBlock(raw);
  if (block !== null) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (isRecord(parsed)) {
        const passed = typeof parsed.passed === "boolean" ? parsed.passed : true;
        const gaps = Array.isArray(parsed.gaps)
          ? parsed.gaps.filter((g: unknown): g is string => typeof g === "string")
          : [];
        return { passed, gaps };
      }
    } catch {
      // Tolerant: fall through to the default verdict.
    }
  }
  return {
    passed: true,
    gaps: ["critic response was not valid JSON; defaulted to passed=true with no gaps"],
  };
}

function buildCriticPrompt(task: SubagentTask, result: SubagentResult): string {
  const lines: string[] = [
    "Judge if the result satisfies the acceptance criteria.",
    "Respond STRICT JSON {passed: boolean, gaps: string array}",
    "",
    `TASK: ${task.goal}`,
  ];
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    lines.push("", "ACCEPTANCE CRITERIA:");
    for (const criterion of criteria) lines.push(`- ${criterion}`);
  }
  lines.push("", "RESULT:", result.summary);
  if (result.artifacts.length > 0) {
    lines.push("", "ARTIFACTS:");
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
  }
  return lines.join("\n");
}

// ── Builder agents ────────────────────────────────────────────────

function buildBuilderPrompt(task: SubagentTask, workspace: string): string {
  const lines: string[] = [`SUBTASK ${task.id}: ${task.goal}`];
  const criteria = task.acceptanceCriteria ?? [];
  if (criteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const criterion of criteria) lines.push(`- ${criterion}`);
  }
  if (task.context !== undefined && task.context.trim().length > 0) {
    lines.push("", "Context:", task.context);
  }
  lines.push(
    "",
    `Work inside the workspace directory (${workspace}). Create real files for anything you produce. Finish with a concise summary of what you did.`,
  );
  return lines.join("\n");
}

function finalAssistantText(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "assistant" && message.text.trim().length > 0) {
      return message.text.trim();
    }
  }
  return null;
}

/** Recursive relative posix-path listing of every file under the workspace. */
async function listWorkspaceFiles(root: string): Promise<Set<string>> {
  const entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  const out = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    out.add(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return out;
}

/** Fallback flush interval for {@link StreamLineBatcher} (anti-flood cadence). */
const OUTPUT_FLUSH_MS = 200;

/**
 * Line-oriented text-delta batcher: accumulates streamed deltas and releases
 * them one complete line at a time, so per-token provider updates never flood
 * the event stream. A timer flushes any partial line after
 * {@link OUTPUT_FLUSH_MS} of inactivity, and `flush()` drains the remainder
 * when the stream ends.
 * @internal testing export.
 */
export class StreamLineBatcher {
  readonly #onLine: (text: string) => void;
  readonly #flushEveryMs: number;
  #buffer = "";
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(onLine: (text: string) => void, flushEveryMs: number = OUTPUT_FLUSH_MS) {
    this.#onLine = onLine;
    this.#flushEveryMs = flushEveryMs;
  }

  /** Appends a delta; emits one SwarmEvent per completed line immediately. */
  push(delta: string): void {
    this.#buffer += delta;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex + 1);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#onLine(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (this.#buffer.length > 0 && this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.flush();
      }, this.#flushEveryMs);
    }
  }

  /** Emits any pending partial line and cancels the timer. Idempotent. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#buffer.length === 0) return;
    const text = this.#buffer;
    this.#buffer = "";
    this.#onLine(text);
  }
}

// ── Plan-only seam (used by /plan) ────────────────────────────────

/** What {@link planGoal} returns: the decomposed plan, nothing executed. */
export interface SwarmPlan {
  goal: string;
  source: "llm" | "fallback";
  subtasks: Array<{ id: string; goal: string; acceptanceCriteria: string[] }>;
  provider: SwarmProviderConfig;
}

/**
 * Decomposes a goal into subtasks with acceptance criteria WITHOUT running
 * the gauntlet — the planning turn of {@link runSwarmGoal} exposed as its
 * own seam (powers the `/plan` command). Falls back to a single subtask on
 * unparseable output, exactly like the planner inside the full run.
 * LLM failures throw (the caller renders them).
 */
export async function planGoal(opts: {
  goal: string;
  provider: SwarmProviderConfig;
  maxSubtasks?: number;
  signal?: AbortSignal;
}): Promise<SwarmPlan> {
  const maxSubtasks = Math.max(1, Math.floor(opts.maxSubtasks ?? DEFAULT_MAX_SUBTASKS));
  const provider: LlmProvider = new OpenAICompatibleProvider({
    baseUrl: opts.provider.baseUrl,
    apiKey: opts.provider.apiKey,
    model: opts.provider.model,
  });
  const raw = await completeOnce(
    provider,
    JSON_ONLY_SYSTEM_PROMPT,
    buildPlannerPrompt(opts.goal, maxSubtasks),
    opts.signal,
  );
  const planned = parsePlannerOutput(raw, opts.goal, maxSubtasks);
  return {
    goal: opts.goal,
    source: planned.source,
    subtasks: planned.subtasks.map((s) => ({
      id: s.id,
      goal: s.goal,
      acceptanceCriteria: s.acceptanceCriteria,
    })),
    provider: opts.provider,
  };
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Runs the full swarm gauntlet for one goal: plan → parallel builder agents
 * with fresh-context critic and bounded repair → structural quality gate.
 * LLM/provider failures emit a SwarmEvent "error" and then rethrow.
 */
export async function runSwarmGoal(opts: RunSwarmGoalOptions): Promise<SwarmGoalReport> {
  if (opts.signal?.aborted) {
    throw new Error("swarm aborted");
  }
  // SecretGuard: collect env values ONCE per run (exact-value redaction set).
  const envSecretValues = collectEnvSecretValues();
  const maxSubtasks = Math.max(1, Math.floor(opts.maxSubtasks ?? DEFAULT_MAX_SUBTASKS));
  const emitSwarm = (event: SwarmEvent): void => {
    opts.onEvent?.(event);
  };

  // Fresh scratch workspace per RUN (all subtasks share it; left in place).
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "elysium-swarm-"));
  // E6: per-run git checkpoints (opt-in). All functions no-op when disabled
  // or when git is unavailable — never blocks the run.
  const swarmGit = createSwarmGit(workspace, { enabled: opts.gitCheckpoints === true });
  // Durable run record (crash recovery / resume): opt-in via opts.runsRoot.
  // Created BEFORE planning so any failure can mark the run INTERRUPTED; a
  // hard process crash leaves it RUNNING → recovered later by stale detection.
  const runState = opts.runsRoot
    ? startRunRecord(opts.runsRoot, `swarm-${Date.now()}`, opts.goal)
    : null;
  if (runState) markRunPhase(opts.runsRoot as string, runState, "PLANNING");
  const provider: LlmProvider = new OpenAICompatibleProvider({
    baseUrl: opts.provider.baseUrl,
    apiKey: opts.provider.apiKey,
    model: opts.provider.model,
  });

  // ── (1) PLANNING TURN — single direct LLM call, tolerant parse ──
  let planned: { subtasks: PlannedSubtask[]; source: "llm" | "fallback" };
  try {
    const raw = await completeOnce(
      provider,
      JSON_ONLY_SYSTEM_PROMPT,
      buildPlannerPrompt(opts.goal, maxSubtasks),
      opts.signal,
    );
    planned = parsePlannerOutput(raw, opts.goal, maxSubtasks);
  } catch (error: unknown) {
    if (runState && opts.runsRoot) markInterrupted(opts.runsRoot, runState);
    emitSwarm({
      type: "error",
      data: { scope: "planner", message: `planning LLM call failed: ${errorMessage(error)}` },
    });
    throw error;
  }
  const tasks: SubagentTask[] = planned.subtasks.map((subtask) => ({
    id: subtask.id,
    goal: subtask.goal,
    acceptanceCriteria: subtask.acceptanceCriteria,
  }));
  emitSwarm({
    type: "plan",
    data: {
      goal: opts.goal,
      source: planned.source,
      subtasks: tasks.map((task) => ({
        id: task.id,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
      })),
      workspacePath: workspace,
    },
  });
  if (runState) markRunPhase(opts.runsRoot as string, runState, "EXECUTION");
  try {
    swarmGit.checkpoint("plan");
  } catch {
    // git failure is non-fatal by contract
  }

  const plan: OrchestrationPlan = {
    goal: opts.goal,
    maxDepth: 2,
    subtasks: tasks,
    critic: { enabled: true, repairRounds: REPAIR_ROUNDS },
  };

  // Builtin tools scoped to the per-run workspace (same wiring as bin/agent.ts).
  // Built fresh INSIDE each spawn when the task carries an ownership policy so
  // executeTool closes over the right registry; the shared instance below is
  // the fallback for tasks without one.
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({ allowedRoots: [workspace], network: false })) {
    registry.register(tool);
  }
  const buildRegistry = (): ToolRegistry => {
    const perTask = new ToolRegistry();
    for (const tool of createBuiltinTools({ allowedRoots: [workspace], network: false })) {
      perTask.register(tool);
    }
    return perTask;
  };

  // Artifact attribution: builders share the run workspace and run
  // concurrently, so a naive before/after diff per spawn double-counts files
  // created by siblings. Instead, after every successful tool call we diff the
  // workspace and claim each newly seen file for exactly one task (first
  // observer wins — in practice the creating task's own tool continuation).
  const claimedArtifacts = new Map<string, string>();

  /** Latest cumulative builder usage per task id (zeroed when a builder run throws). */
  const taskUsageById = new Map<string, TokenUsage>();

  const spawn: SpawnFn = async (task: SubagentTask): Promise<SubagentResult> => {
    // Repair detection: the Orchestrator re-spawns with critic gaps appended
    // to the task context — surface that as a repair event as it happens.
    const repairMatch = REPAIR_MARKER.exec(task.context ?? "");
    if (repairMatch !== null) {
      emitSwarm({
        type: "repair",
        data: { taskId: task.id, round: Number(repairMatch[1] ?? 0) },
      });
    }

    const knownFiles = await listWorkspaceFiles(workspace);
    const taskArtifacts: string[] = [];

    // Task ownership: a fresh per-task registry (allowedRoots=[workspace], as
    // before) is built inside the spawn when the task has a policy, so the
    // enforcement pre-check below closes over the right instance.
    const policy = opts.taskPolicies?.get(task.id);
    const taskRegistry = policy !== undefined ? buildRegistry() : registry;

    // Bash policy gate input: caller override or the conservative default.
    const effectiveBashPolicy: BashCommandPolicy = opts.bashPolicy ?? {
      denied: [],
      writableRoots: [workspace],
      networkAllowed: false,
    };

    // Streamed builder text → line-batched "task_output" events for this task.
    const batcher = new StreamLineBatcher((text: string): void => {
      emitSwarm({ type: "task_output", data: { taskId: task.id, text } });
    });

    const executeTool = async (
      call: { id: string; name: string; arguments: Record<string, unknown> },
      ctx: { signal: AbortSignal },
    ): Promise<ToolResultMessage> => {
      // Ownership pre-check: write/edit are writes, everything else a read.
      // bash is deliberately not intercepted here (documented gap).
      if (policy !== undefined && (call.name === "write" || call.name === "edit")) {
        const target = call.arguments.path;
        if (typeof target === "string") {
          const verdict = checkPath(policy, target, "write");
          if (!verdict.allowed) {
            const content = `path denied by task ownership: ${target}`;
            emitSwarm({
              type: "task_tool",
              data: { taskId: task.id, tool: call.name, isError: true },
            });
            return {
              role: "tool_result",
              toolCallId: call.id,
              toolName: call.name,
              content,
              isError: true,
            };
          }
        }
      } else if (policy !== undefined && call.name === "read") {
        const target = call.arguments.path;
        if (typeof target === "string") {
          const verdict = checkPath(policy, target, "read");
          if (!verdict.allowed) {
            const content = `path denied by task ownership: ${target}`;
            emitSwarm({
              type: "task_tool",
              data: { taskId: task.id, tool: call.name, isError: true },
            });
            return {
              role: "tool_result",
              toolCallId: call.id,
              toolName: call.name,
              content,
              isError: true,
            };
          }
        }
      }

      // Bash policy gate: every shell command passes here BEFORE spawn.
      // BLOCK/APPROVE never execute (swarm has no interactive approver);
      // the command the model sees is the policy reason.
      if (call.name === "bash" && typeof call.arguments.command === "string") {
        const gate = gateBashCommand(effectiveBashPolicy, call.arguments.command, workspace);
        if (gate.action === "BLOCK" || gate.action === "APPROVE") {
          emitSwarm({
            type: "task_tool",
            data: { taskId: task.id, tool: call.name, isError: true },
          });
          return {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content:
              gate.action === "APPROVE"
                ? `bash command requires approval and was refused in swarm context: ${gate.reason ?? "policy"}`
                : `bash command blocked by policy: ${gate.reason ?? "denied"}`,
            isError: true,
          };
        }
      }

      const tool = taskRegistry.get(call.name);
      if (!tool) {
        emitSwarm({ type: "task_tool", data: { taskId: task.id, tool: call.name, isError: true } });
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `unknown tool: ${call.name}`,
          isError: true,
        };
      }
      try {
        const result = await tool.execute(call.arguments, {
          cwd: workspace,
          signal: ctx.signal,
          emit: () => {},
        });
        // SecretGuard boundary: redact BEFORE any emission/event/return, so
        // no secret from tool output can reach the bus, evidence or reports.
        const redactedContent = redactText(result.content, envSecretValues);
        const redactedDetails =
          result.details === undefined
            ? undefined
            : (redactObject(result.details, envSecretValues) as Record<string, unknown>);
        emitSwarm({
          type: "task_tool",
          data: { taskId: task.id, tool: call.name, isError: result.isError },
        });
        if (!result.isError) {
          const afterFiles = await listWorkspaceFiles(workspace);
          for (const file of afterFiles) {
            if (knownFiles.has(file)) continue;
            knownFiles.add(file);
            if (!claimedArtifacts.has(file)) {
              claimedArtifacts.set(file, task.id);
              taskArtifacts.push(file);
            }
          }
        }
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: redactedContent,
          isError: result.isError,
          ...(redactedDetails !== undefined ? { details: redactedDetails } : {}),
        };
      } catch (error: unknown) {
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `error: ${errorMessage(error)}`,
          isError: true,
        };
      }
    };

    const agent = new Agent({
      systemPrompt: BUILDER_SYSTEM_PROMPT,
      provider,
      tools: taskRegistry.list(),
      maxTurns: BUILDER_MAX_TURNS,
      executeTool,
      onEvent: (agentEvent: AgentEvent): void => {
        // Forward builder text deltas into the line batcher; tool visibility
        // is emitted directly in `executeTool` (exact isError, one event per
        // executed call).
        if (agentEvent.kind === "text_delta") {
          const data = agentEvent.data as { delta?: unknown };
          if (typeof data.delta === "string" && data.delta.length > 0) {
            batcher.push(data.delta);
          }
        }
      },
    });

    try {
      const run = await agent.run(buildBuilderPrompt(task, workspace));
      batcher.flush();
      taskUsageById.set(task.id, run.usage);
      const summary = finalAssistantText(run.messages);
      const completed = run.stopReason === "end_turn" && summary !== null;
      return {
        taskId: task.id,
        status: completed ? "pass" : "partial",
        summary: summary ?? "(no final assistant text)",
        artifacts: [...taskArtifacts],
      };
    } catch (error: unknown) {
      batcher.flush();
      taskUsageById.set(task.id, { inputTokens: 0, outputTokens: 0 });
      return {
        taskId: task.id,
        status: "fail",
        summary: `agent run failed: ${errorMessage(error)}`,
        artifacts: [],
      };
    }
  };

  // ── (3) CRITIC — fresh context: ONLY task + this attempt's result ──
  const critic = async (task: SubagentTask, result: SubagentResult): Promise<CriticVerdict> => {
    emitSwarm({ type: "critic", data: { taskId: task.id, phase: "start" } });
    try {
      const raw = await completeOnce(
        provider,
        JSON_ONLY_SYSTEM_PROMPT,
        buildCriticPrompt(task, result),
        opts.signal,
      );
      const verdict = parseCriticVerdict(raw);
      emitSwarm({
        type: "critic",
        data: {
          taskId: task.id,
          phase: "end",
          passed: verdict.passed,
          gaps: verdict.gaps,
        },
      });
      return verdict;
    } catch (error: unknown) {
      // Surface the provider failure, then rethrow: the Orchestrator captures
      // critic rejections as a failed verdict feeding the bounded repair loop.
      emitSwarm({
        type: "error",
        data: {
          taskId: task.id,
          scope: "critic",
          message: `critic LLM call failed: ${errorMessage(error)}`,
        },
      });
      throw error;
    }
  };

  // ── (2) EXECUTION — Orchestrator with concurrency 2, 1 repair round ──
  const taskGoalById = new Map<string, string>();
  for (const task of tasks) taskGoalById.set(task.id, task.goal);

  const orchestrator = new Orchestrator({
    spawn,
    critic,
    repairRounds: REPAIR_ROUNDS,
    maxConcurrency: MAX_CONCURRENCY,
    spawnTimeoutMs: swarmSpawnTimeoutMs(),
    signal: opts.signal,
    onEvent: (event: HarnessEvent): void => {
      // Map orchestrator telemetry onto the runtime-mode event surface;
      // latency-style events are not part of it and are dropped.
      if (event.type === "task_started") {
        emitSwarm({
          type: "task_started",
          data: {
            taskId: event.taskId,
            goal: taskGoalById.get(event.taskId ?? "") ?? "",
            ...event.data,
          },
        });
      } else if (event.type === "task_ended") {
        // E6 wiring: checkpoint the workspace after each builder task ends
        // (never blocks the run on git failure — createSwarmGit is tolerant).
        try {
          swarmGit.checkpoint(`task-${event.taskId ?? "task"}`);
        } catch {
          // git failure is non-fatal by contract
        }
        const usage = taskUsageById.get(event.taskId ?? "");
        emitSwarm({
          type: "task_ended",
          data: {
            taskId: event.taskId,
            ...event.data,
            ...(usage !== undefined
              ? {
                  tokens: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                  },
                }
              : {}),
          },
        });
      } else if (event.type === "error") {
        emitSwarm({ type: "error", data: { taskId: event.taskId, ...event.data } });
      }
    },
  });

  const orchestration = await orchestrator.execute(plan);

  // ── (5) QUALITY GATE — structuralJudge per result vs its criteria ──
  const gate = new QualityGate({ judge: structuralJudge });
  const rubric = createDefaultRubric();
  const scores: SwarmTaskScore[] = [];
  for (const subtask of orchestration.subtasks) {
    const criteria = subtask.task.acceptanceCriteria;
    // The gated artifact is the whole result — summary plus the artifacts the
    // builder produced — mirroring exactly what the fresh-context critic saw.
    const content =
      subtask.result.artifacts.length > 0
        ? `${subtask.result.summary}\n\nArtifacts:\n${subtask.result.artifacts.map((a) => `- ${a}`).join("\n")}`
        : subtask.result.summary;
    const artifact: GateArtifact = {
      taskId: subtask.task.id,
      kind: "text",
      content,
      ...(criteria !== undefined && criteria.length > 0 ? { criteria } : {}),
    };
    // Adaptive verification: scale the pass threshold (and skip extra
    // strictness) by the deterministic risk of the subtask instead of a
    // fixed one-size-fits-all bar. The default rubric is spread — its frozen
    // shape in types/quality.ts stays untouched, only `threshold` is
    // overridden per level.
    const risk = riskScore({
      criteriaCount: criteria?.length ?? 0,
      filesTouched: subtask.result.artifacts.length,
    });
    const THRESHOLD_BY_LEVEL: Record<string, number> = { low: 6.5, medium: 8.0, high: 9.0 };
    const levelThreshold = THRESHOLD_BY_LEVEL[risk.level] ?? 8.0;
    const levelRubric: typeof rubric = { ...rubric, threshold: levelThreshold };
    const score = await gate.evaluate(artifact, levelRubric);
    scores.push({ taskId: subtask.task.id, weighted: score.weighted, passed: score.passed });
  }

  if (runState) {
    finishRun(opts.runsRoot as string, runState, orchestration.allPassed ? "COMPLETED" : "FAILED");
  }

  emitSwarm({
    type: "done",
    data: {
      goal: orchestration.goal,
      allPassed: orchestration.allPassed,
      subtaskCount: orchestration.subtasks.length,
      scores,
      workspacePath: workspace,
      totalDurationMs: orchestration.totalDurationMs,
    },
  });

  return { ...orchestration, scores, workspacePath: workspace };
}
