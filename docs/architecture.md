# Elysium Harness — Architecture

Status: **approved Phase 1**. This document is normative. Changes require orchestrator approval and an entry in `doubts.md` (resolved section).

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Extensions (opt-in)                     │
│  meta-layer │ extension-tools │ tui │ benchmarks │ cli       │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
       │ subscribe     │ register     │ render       │ measure
┌──────▼───────────────▼──────────────▼──────────────▼─────────┐
│                    @elysium/core (small)                     │
│  Agent Loop │ Tool System │ Session & State │ Orchestration  │
│  Quality Gate │ Provider Interface │ Event/Telemetry Bus     │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
       │               │              │              │
   LLM Providers   Files/Shell   JSONL Log    SpawnFn (depth ≤ 2)
 (mock, openai)   (policy-gated)  (tree)      (leaf agents only)
```

Dependency rule: extensions depend on core; core depends on **nothing** (Node stdlib only).

## 2. Core Public Interfaces (frozen in `core/src/types/`)

| Module | Key types | Behavior contract |
|---|---|---|
| **Agent Loop** | `Agent`, `AgentOptions`, `TurnResult` | Runs prompt → provider stream → tool executions → repeat until `end_turn`/`aborted`/`maxTurns`. Per-turn snapshot: the request sent to the provider is built once per turn (system prompt, messages, tools); config changes mid-turn apply to the *next* turn. Supports steering (queued user messages drained between turns) and abort via `AbortSignal`. |
| **Tool System** | `Tool`, `ToolRegistry`, `ToolContext`, `PathPolicy` | Registry validates names (unique), exposes `toDefinitions()` for the provider. `read`/`write`/`edit`/`bash` built in. `read`/`write`/`edit`: every filesystem path is resolved against `ctx.cwd` and validated against `PathPolicy.allowedRoots` before I/O. `bash` is instead governed by the **command policy** (regex-based `deniedCommands`/`warnCommands`, §4 item 2) and is **not** path-contained — see §4 for the security implications. |
| **Session & State** | `Session`, `SessionEntry`, `Checkpoint`, `CompactionResult` | Append-only JSONL tree (`id`/`parentId`). Branch = append under a different parent. Checkpoint = leaf pointer. Compaction = append a `summary` entry; context projection (`buildContext()`) substitutes covered entries with the summary — history is never rewritten. |
| **Orchestration** | `OrchestrationPlan`, `Orchestrator`, `SpawnFn`, `SubagentResult` | Depth ≤ 2 **by construction**: a plan carries exactly one level of subtasks; `SubagentResult` cannot contain a plan, so spawned agents have no API to spawn further. Builder/critic: optional critic pass with fresh context per subtask; repair rounds bounded. |
| **Quality Gate** | `QualityGate`, `Rubric`, `QualityScore`, `JudgeFn` | Weighted rubric scoring (0–10 per dimension, weighted mean). `evaluate()` returns accept/reject **with reasons** (targeted retry feedback). Two judge profiles: `structural` (deterministic, offline) and `llm-judge` (uses a provider). |
| **Providers** | `LlmProvider`, `StreamEvent`, `LlmRequest` | Async-iterable streaming; terminal `done` or `error` exactly once. Adapters: `MockProvider` (deterministic scripted; zero network), `OpenAICompatibleProvider` (SSE). |
| **Events** | `EventBus`, `HarnessEvent`, `EventHandler` | Typed pub/sub + bounded ring buffer (`recent(n)`). Every lifecycle moment emits: `task_started/ended`, `turn_started/ended`, `tool_called`, `token_usage`, `latency`, `quality_evaluated`, `error`. |

## 3. State Model

- **Run** = one top-level `Agent.run()` or `Orchestrator.execute()`. Owns a `runId` (ULID-style).
- **Session** = append-only entry tree; the active leaf defines current state. Persistence: one JSONL file per session under `.elysium/sessions/`.
- **Projection** = what the model sees: active-branch entries minus summary-covered entries plus summaries. Pure function of the log — replayable, measurable.
- **Checkpoints** are free (any leaf). **Branching** = append with `parentId` of an older entry. **Compaction** never destroys data.

## 4. Security Model

1. **Path containment** — `read`/`write`/`edit` resolve paths and reject anything escaping `allowedRoots` (symlink-aware: resolve real path first). Default roots: `[cwd]`. **`bash` is not covered by path containment**: it executes shell commands under the command policy below only, so an arbitrary command can touch any path the OS user can reach — treat `allowedRoots` as a tool-level guard, not an OS sandbox. Known limitation: symlink-based escapes and TOCTOU (time-of-check to time-of-use) races remain possible even for the path-validated tools; the real-path resolution closes the obvious cases but is not a hard guarantee.
2. **Bash policy** — `deniedCommands` regexes block; `warnCommands` flag in telemetry but execute; everything else allowed (default-allow, operator adds deny rules). Policy matched on the normalized command string. Execution timeout: each bash command runs under `ELYSIUM_BASH_TIMEOUT_MS` (default **30000 ms**); a watchdog force-kills the process tree when the timeout fires, and the tool returns a timeout error instead of hanging.
3. **No secrets in code** — providers read credentials from the environment (`ELYSIUM_*` / provider API-key variables) with an optional `.env` file as fallback — the environment always wins when a variable is set in both places. The harness never logs request headers. Note: `.env` is a plaintext file living inside the default `allowedRoots` (`[cwd]`), so it is readable/writable by the path-validated tools and must be treated as **sensitive**: it is gitignored, never committed, and never included in telemetry or error payloads.
4. **Telemetry is local** — JSONL under `.elysium/`; no network egress except configured providers.
5. **Depth cap** — orchestration cannot exceed depth 2 (type-level, see §2).
6. **Error taxonomy** — recoverable CLI errors are typed classes exported from core (`core/src/types/errors.ts`, frozen contract):

   - `RecoverableCliError` (base) — carries `action: string`, the concrete user step to recover. Subclasses: `ProviderConfigurationError` (→ `MissingApiKeyError`, which names `provider`), `UnknownProviderError` (names `provider`), `ProviderInitializationError`.
   - `FatalError` is deliberately **not** a subclass of `RecoverableCliError`. It may be raised only by the CLI entrypoint (top-level handler) and only for genuine irrecoverable failures; core and extensions must never throw it.
   - **No `process.exit` in core or in any mid-level handler.** Error-throwing factories (e.g. the provider factory) throw typed `RecoverableCliError`s; the REPL error boundary catches them, renders message + action, and keeps running. The process exits only at the entrypoint (`/quit`, SIGINT, uncaught fatal).
   - Errors surface as structured bus events: `type: "error"`, `data: { scope, kind, message }` — `scope` names the emitting layer (e.g. `"cli"`), `kind` the class of failure (e.g. `recoverable_command_error`, `agent_run_error`), `message` the human-readable text. No secrets ever enter the payload. The normative `error` event shape in §5 consequently carries `{scope, kind, message}`.

## 5. Telemetry Format (normative)

Every event is one JSON line:
```json
{
  "type": "task_ended",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "runId": "01JABC...",
  "taskId": "subtask-3",
  "data": { "status": "pass", "durationMs": 1421, "tokens": { "inputTokens": 530, "outputTokens": 210 } }
}
```
Required `data` keys per type: `tool_called` → `{tool, durationMs, isError}`; `token_usage` → `{inputTokens, outputTokens}`; `latency` → `{scope: "turn"|"task"|"run", durationMs}`; `quality_evaluated` → `{weighted, passed}`; `error` → `{scope, kind, message}`. The Meta-Layer persists exactly these lines — the format is the contract between core and meta-layer.

## 6. Meta-Layer (extension) Loop

```
subscribe(eventBus) ──► TelemetryStore (JSONL, queryable by run/task/type/time)
       │                       │
       ▼                       ▼
 HypothesisEngine ◄── observations (aggregates: slow tasks, low first-pass, retry storms)
       │  proposes: {id, observation, change, expectedEffect, status}
       ▼
 ControlledApplication (config deltas only: retry counts, granularity, tool ordering)
       │
       ▼
 DeltaMeasurement (re-run held-out tasks; promote iff delta > 0, else reject + log)
```

Hypothesis JSON (normative):
```json
{ "id": "hyp_01J...", "observation": {"metric": "first_pass_rate", "value": 0.62, "window": 20},
  "change": {"kind": "retry_policy", "from": {"maxRetries": 1}, "to": {"maxRetries": 2}},
  "expectedEffect": "first_pass_rate +0.05 or more",
  "status": "proposed", "delta": null }
```

## 7. CLI Layer

- **`bin/agent.ts`** — the presentation and recovery layer. It renders output, translates typed errors from core (`RecoverableCliError` subclasses, §4.6) via an error boundary into friendly messages + recovery actions, and keeps the REPL alive. No business logic lives here; core owns the loop. It also hosts the **session/UI state** of the REPL (session stats, transcript, `/save`) and the **skills integration**: at startup the skill index is injected into the system prompt, and each skill's `SKILL.md` is read on demand via the `read` tool when the agent invokes it.
- **`bin/ui.ts`** — zero-dependency ANSI theme for the CLI (colors, borders, status line). `NO_COLOR`-aware: disables all styling when the variable is set.
- **`packages/cli/src/swarm-mode.ts`** — Swarmloop mode runtime. Maps the Swarmloop skill's gauntlet profile (planner → parallel builders → fresh-context critic → one repair round → scored report) onto the core `Orchestrator` engine (§2). Exposed in the REPL as `/swarm <goal>`. Emits live progress events (per-subagent text output and tool calls prefixed by `taskId`, critic verdicts, repair rounds) that the REPL renders as they arrive.
- **Effort modes** (`/mode min|medium|high|max`) — a UI-level orchestration-intensity knob (max turns, swarm subtask count, repair rounds, tool-output visibility, system-prompt strictness). Session-scoped: resolved in the CLI layer, not persisted in core or on disk; default `medium`.

## 8. Core / Extension Boundary (definitive)

**Core:** agent loop, tool system + 4 built-ins, session & state, orchestration primitives (depth ≤ 2), streaming quality gate, provider interface + mock, event bus, typed CLI error classes.
**Extensions:** meta-layer, extra tools (grep/glob/http-fetch), OpenAI adapter (network), TUI, benchmarks, CLI, anything else — forever.

## 9. Measurement

Defined in `plan.md` §Measurement: first-pass rate, token usage, latency, quality score (weights: correctness .30 / efficiency .30 / maintainability .20 / principles .20). Benchmarks compare against `docs/baseline.md`; no arbitrary numeric targets.
