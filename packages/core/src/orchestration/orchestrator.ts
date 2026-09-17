/**
 * Hierarchical Orchestration engine — Variant A: plan-graph executor.
 *
 * Executes a flat {@link OrchestrationPlan} (exactly one level of subtasks,
 * depth ≤ 2 by construction — a SubagentResult cannot carry a plan, so spawned
 * agents have no API to spawn further) with bounded concurrency. Each subtask
 * runs the optional critic against a FRESH context (only the task and its own
 * result — never sibling results), and failing critic gaps are appended to the
 * task context for a bounded number of repair rounds. Spawn rejections are
 * captured as failed results and never crash the run. Aborting the configured
 * signal marks tasks that have not started yet as failed with summary
 * "aborted"; already-running attempts settle naturally.
 */
import { randomBytes } from "node:crypto";
import { type FailureCause, classifyFailure } from "../quality/failure-cause";
import type { HarnessEvent } from "../types/events";
import type {
  CriticVerdict,
  OrchestrationPlan,
  OrchestrationReport,
  SpawnFn,
  SubagentResult,
  SubagentTask,
  SubtaskReport,
} from "../types/orchestration";
import type { EvidenceChain, EvidenceKind } from "./evidence";

/** Callback evaluating a single subtask attempt; receives a fresh context only. */
type CriticFn = (task: SubagentTask, result: SubagentResult) => Promise<CriticVerdict>;

/** Options for the {@link Orchestrator}. */
export interface OrchestratorOptions {
  /** Seam used to execute a single subtask (leaf agents only — depth ≤ 2 by construction). */
  spawn: SpawnFn;
  /**
   * Optional critic run after every spawn attempt. It receives ONLY the task and
   * that attempt's result — never the results of sibling subtasks.
   */
  critic?: CriticFn;
  /** Repair rounds (re-spawns) after failing critic gaps. Default 1. */
  repairRounds?: number;
  /** Maximum number of subtasks executed concurrently. Default 4. */
  maxConcurrency?: number;
  /** When aborted, tasks that have not started yet fail with summary "aborted". */
  signal?: AbortSignal;
  /**
   * Optional per-spawn budget in milliseconds. When > 0, a spawn that has not
   * settled within the budget is abandoned: an `error` event (scope "task") is
   * emitted and a failed {@link SubagentResult} with summary `timeout after Ns`
   * is returned in its place. Default 0 (timeout disabled). Rejections are
   * still captured — a timeout never propagates rejections to the caller.
   */
  spawnTimeoutMs?: number;
  /** Telemetry sink receiving typed harness events for this run. */
  onEvent?: (event: HarnessEvent) => void;
  /**
   * Optional evidence chain: attempt, critic and task_ended steps are recorded
   * here and mirrored on the bus as `custom` events carrying
   * `{ evidenceId, kind, summary }`.
   */
  evidence?: EvidenceChain;
}

/** Default per-spawn budget: 0 = timeout disabled. */
const DEFAULT_SPAWN_TIMEOUT_MS = 0;

const DEFAULT_REPAIR_ROUNDS = 1;
const DEFAULT_MAX_CONCURRENCY = 4;
/** The only depth an OrchestrationPlan may declare (type-level MaxDepth = 2). */
const MAX_DEPTH = 2;
const RUN_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a ULID-style run id: 10 chars of millisecond timestamp + 16 random chars. */
function generateRunId(): string {
  let time = Date.now();
  let timestampPart = "";
  for (let i = 0; i < 10; i += 1) {
    timestampPart = RUN_ID_ALPHABET.charAt(time % 32) + timestampPart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = "";
  for (let i = 0; i < bytes.length; i += 1) {
    randomPart += RUN_ID_ALPHABET.charAt((bytes[i] ?? 0) % 32);
  }
  return timestampPart + randomPart;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedResult(taskId: string): SubagentResult {
  return { taskId, status: "fail", summary: "aborted", artifacts: [] };
}

/**
 * Returns a respawn copy of the task with the critic's gaps appended to its
 * context. The planned task object is never mutated.
 */
function taskWithCriticGaps(task: SubagentTask, gaps: string[], round: number): SubagentTask {
  const bulletLines = gaps.length > 0 ? gaps : ["(critic reported no specific gaps)"];
  const bullets = bulletLines.map((gap) => `- ${gap}`).join("\n");
  const gapBlock = `Critic feedback, repair round ${round} — address these gaps:\n${bullets}`;
  return {
    ...task,
    context: task.context === undefined ? gapBlock : `${task.context}\n\n${gapBlock}`,
  };
}

/**
 * Plan-graph executor over a flat {@link OrchestrationPlan}.
 * Depth is capped at 2 by construction: see `docs/architecture.md` §2 and §4.
 */
export class Orchestrator {
  private readonly spawn: SpawnFn;
  private readonly critic?: CriticFn;
  private readonly repairRounds: number;
  private readonly maxConcurrency: number;
  private readonly signal?: AbortSignal;
  private readonly spawnTimeoutMs: number;
  private readonly onEvent?: (event: HarnessEvent) => void;
  private readonly evidence?: EvidenceChain;

  constructor(options: OrchestratorOptions) {
    this.spawn = options.spawn;
    this.critic = options.critic;
    this.repairRounds = Math.max(0, options.repairRounds ?? DEFAULT_REPAIR_ROUNDS);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.signal = options.signal;
    this.spawnTimeoutMs = Math.max(0, options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
    this.onEvent = options.onEvent;
    this.evidence = options.evidence;
  }

  /** Validates and executes the plan, returning a per-subtask report. */
  async execute(plan: OrchestrationPlan): Promise<OrchestrationReport> {
    this.validatePlan(plan);
    const runId = generateRunId();
    const startedAtMs = Date.now();
    const reports: SubtaskReport[] = new Array<SubtaskReport>(plan.subtasks.length);
    let cursor = 0;
    const workerCount = Math.min(this.maxConcurrency, plan.subtasks.length);

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const task = plan.subtasks[index];
        if (task === undefined) {
          return;
        }
        reports[index] = await this.runSubtask(runId, task);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      goal: plan.goal,
      completedAt: nowIso(),
      subtasks: reports,
      // The critic (when configured) is the acceptance gate: a subtask only
      // counts as passed if its spawn result passed AND its verdict passed.
      allPassed: reports.every(
        (report) =>
          report.result.status === "pass" && (report.critic === undefined || report.critic.passed),
      ),
      totalDurationMs: Date.now() - startedAtMs,
    };
  }

  /** maxDepth must be exactly 2 (rejected at runtime for non-TS callers too). */
  private validatePlan(plan: OrchestrationPlan): void {
    if (plan.maxDepth !== MAX_DEPTH) {
      throw new Error(
        `Invalid orchestration plan: maxDepth must be ${MAX_DEPTH}, received ${String(plan.maxDepth)}.`,
      );
    }
    if (plan.subtasks.length === 0) {
      throw new Error("Invalid orchestration plan: subtasks must not be empty.");
    }
    const seenIds = new Set<string>();
    for (const task of plan.subtasks) {
      if (seenIds.has(task.id)) {
        throw new Error(`Invalid orchestration plan: duplicate subtask id "${task.id}".`);
      }
      seenIds.add(task.id);
    }
  }

  /**
   * Runs one subtask to completion: initial spawn, optional fresh-context critic,
   * and bounded repair rounds that re-spawn the same task with the critic gaps
   * appended to its context. Emits task_started, task_ended and task-scope
   * latency events for this run. When an evidence chain is configured, attempt,
   * critic and task_ended steps are recorded and mirrored on the bus as
   * `custom` events.
   */
  private async runSubtask(runId: string, task: SubagentTask): Promise<SubtaskReport> {
    if (this.signal?.aborted) {
      // Never started: reported as aborted, no lifecycle events are emitted.
      return { task, result: abortedResult(task.id) };
    }
    /** Records an evidence entry and mirrors it as a `custom` bus event. */
    const recordEvidence = (
      kind: EvidenceKind,
      summary: string,
      data?: {
        [key: string]: unknown;
      },
    ): void => {
      const entry = this.evidence?.add(kind, task.id, summary, data);
      if (entry === undefined) {
        return;
      }
      this.emit({
        type: "custom",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { evidenceId: entry.id, kind, summary },
      });
    };

    const startedAtMs = Date.now();
    this.emit({
      type: "task_started",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { goal: task.goal },
    });

    let attemptTask: SubagentTask = task;
    let result = await this.spawnSafely(runId, attemptTask);
    let attempts = 1;
    recordEvidence("attempt", `attempt 1: ${result.summary}`, {
      status: result.status,
      attempt: attempts,
    });
    let verdict: CriticVerdict | undefined;
    /** Classified critic-gap causes per round, for collapse detection. */
    const priorCauses: FailureCause[][] = [];
    if (this.critic !== undefined) {
      verdict = await this.runCritic(this.critic, runId, attemptTask, result);
      recordEvidence("critic", `critic verdict round 1: ${verdict.passed ? "pass" : "fail"}`, {
        passed: verdict.passed,
        gaps: verdict.gaps,
      });
      for (let round = 1; round <= this.repairRounds && !verdict.passed; round += 1) {
        if (this.signal?.aborted) {
          break;
        }
        // Causal collapse detection: when this round's critic gaps classify to
        // causes that are all a subset of the previous round's causes (nothing
        // new surfaced), repairing again cannot make progress — stop early.
        // UNKNOWN causes are ignored when at least one known cause exists.
        const allCauses = verdict.gaps.map((gap) => classifyFailure(gap).cause);
        const knownCauses = allCauses.filter((cause) => cause !== "UNKNOWN");
        const effectiveCauses = knownCauses.length > 0 ? knownCauses : allCauses;
        const previous = priorCauses[priorCauses.length - 1];
        if (
          round >= 2 &&
          previous !== undefined &&
          effectiveCauses.length > 0 &&
          effectiveCauses.every((cause) => previous.includes(cause))
        ) {
          const uniq = Array.from(new Set(effectiveCauses)).join(", ");
          this.emit({
            type: "error",
            timestamp: nowIso(),
            runId,
            taskId: task.id,
            data: { message: `repair loop collapse: repeated causes [${uniq}]`, scope: "task" },
          });
          break;
        }
        priorCauses.push(effectiveCauses);
        attemptTask = taskWithCriticGaps(attemptTask, verdict.gaps, round);
        result = await this.spawnSafely(runId, attemptTask);
        attempts += 1;
        recordEvidence("attempt", `attempt ${attempts}: ${result.summary}`, {
          status: result.status,
          attempt: attempts,
          repairRound: round,
        });
        verdict = await this.runCritic(this.critic, runId, attemptTask, result);
        recordEvidence(
          "critic",
          `critic verdict round ${round + 1}: ${verdict.passed ? "pass" : "fail"}`,
          { passed: verdict.passed, gaps: verdict.gaps },
        );
      }
    }

    const durationMs = Date.now() - startedAtMs;
    recordEvidence("task_ended", `task ended: ${result.status}`, {
      status: result.status,
      durationMs,
      attempts,
    });
    this.emit({
      type: "task_ended",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { status: result.status, durationMs, attempts },
    });
    this.emit({
      type: "latency",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { scope: "task", durationMs },
    });
    // The report keeps the original planned task; repair used detached copies.
    return { task, result, critic: verdict };
  }

  /**
   * Spawn rejections are captured as failed results; they never crash the run.
   * When {@link OrchestratorOptions.spawnTimeoutMs} is > 0, the spawn is raced
   * against a timer: on expiry the attempt is abandoned with an `error` event
   * and a failed result — no rejection ever propagates, and the (late) spawn
   * outcome is simply ignored.
   */
  private async spawnSafely(runId: string, task: SubagentTask): Promise<SubagentResult> {
    const spawned = this.spawnWithRejectionCaptured(runId, task);
    if (this.spawnTimeoutMs <= 0) {
      return spawned;
    }
    const seconds = Math.round(this.spawnTimeoutMs / 100) / 10;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SubagentResult>((resolve) => {
      timer = setTimeout(() => {
        const summary = `timeout after ${seconds}s`;
        this.emit({
          type: "error",
          timestamp: nowIso(),
          runId,
          taskId: task.id,
          data: { message: summary, scope: "task" },
        });
        resolve({
          taskId: task.id,
          status: "fail",
          summary,
          artifacts: [],
        });
      }, this.spawnTimeoutMs);
    });
    try {
      return await Promise.race([spawned, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Invokes the spawn seam with its rejection converted into a failed result,
   * so `Promise.race` above never sees a rejected promise.
   */
  private async spawnWithRejectionCaptured(
    runId: string,
    task: SubagentTask,
  ): Promise<SubagentResult> {
    try {
      return await this.spawn(task);
    } catch (error) {
      const message = errorMessage(error);
      this.emit({
        type: "error",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { message: `spawn failed: ${message}`, scope: "task" },
      });
      return {
        taskId: task.id,
        status: "fail",
        summary: `spawn failed: ${message}`,
        artifacts: [],
      };
    }
  }

  /**
   * Runs the critic with a FRESH context: only the task and this attempt's
   * result are passed — sibling results are structurally unreachable. A critic
   * that throws is captured as a failed verdict (with the error as a gap) so it
   * feeds the bounded repair loop instead of crashing the run.
   */
  private async runCritic(
    critic: CriticFn,
    runId: string,
    task: SubagentTask,
    result: SubagentResult,
  ): Promise<CriticVerdict> {
    try {
      return await critic(task, result);
    } catch (error) {
      const message = errorMessage(error);
      this.emit({
        type: "error",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { message: `critic failed: ${message}`, scope: "task" },
      });
      return { passed: false, gaps: [`critic failed: ${message}`] };
    }
  }

  private emit(event: HarnessEvent): void {
    this.onEvent?.(event);
  }
}
