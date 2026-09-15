# Elysium Harness

A next-generation agent harness: a **minimal, auditable core** (Pi-inspired) with **hierarchical orchestration (depth ≤ 2)** and **streaming quality gates** as first-class, opt-in extensions (Elysium-Swarmloop-inspired).

> **Repo layout**: this repo hosts two related projects.
> - **Root** — the TypeScript/pnpm harness (this README). Packages under `packages/`, CLI via `pnpm agent`, skills in `skills/`.
> - **`agent-python/`** — the legacy Python v0.16 web harness (FastAPI + Alpine SPA), kept for reference. Run its tests with a Python venv: `cd agent-python && python -m pytest -q` (108 tests green). Its own README lives at `agent-python/README.md`.
> - **`skills/`** — agent skills shipped with the harness and indexed into the CLI system prompt (`/skills`): `living-dashboard` (UI), `elysium-swarmloop`, `elysium-bench-operations`.

```
┌──────────────────────────────────────────────────────────────┐
│                      Extensions (opt-in)                     │
│  meta-layer │ extension-tools │ tui │ benchmarks │ cli       │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
┌──────▼───────────────▼──────────────▼──────────────▼─────────┐
│                    @elysium/core (small)                     │
│  Agent Loop │ Tool System │ Session │ Orchestration │        │
│  Quality Gate │ Provider Interface │ Event/Telemetry Bus     │
└──────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Kind | What it gives you |
|---|---|---|
| `@elysium/core` | core | Agent loop, tool system (`read`/`write`/`edit`/`bash`), JSONL session tree, depth-2 orchestrator, quality gate, providers (mock + OpenAI-compatible), typed event bus |
| `@elysium/meta-layer` | extension | Software Factory meta-layer: telemetry store, improvement hypotheses, controlled application, delta promotion |
| `@elysium/extension-tools` | extension | `grep`, `glob`, `http_fetch` tools |
| `@elysium/tui` | extension | Readline REPL with live streaming |
| `@elysium/benchmarks` | extension | Benchmark/eval suite, baseline management |
| `@elysium/cli` | extension | `elysium demo / run / orchestrate` |

## Quick start

Requires Node ≥ 22 and pnpm ≥ 9.

```bash
pnpm install
pnpm build          # typechecks every package (strict, zero errors)
pnpm test           # full unit + integration suite
pnpm demo           # offline end-to-end agent run on the deterministic mock provider
```

The demo runs a complete agent loop with **zero network**: a scripted provider requests a tool call, the harness executes it through the policy-checked tool registry, and the agent produces a final answer.

## 60-second programmatic tour

```ts
import {
  Agent, MockProvider, ToolRegistry, createBuiltinTools, Session, EventBus,
} from "@elysium/core";

const bus = new EventBus();
const policy = { allowedRoots: [process.cwd()] };
const registry = new ToolRegistry();
for (const tool of createBuiltinTools(policy)) registry.register(tool);

const session = new Session({ filePath: ".elysium/sessions/demo.jsonl" });
const provider = new MockProvider([{ text: "Ready." }]); // or OpenAICompatibleProvider

const agent = new Agent({
  systemPrompt: "You are a coding agent.",
  provider,
  tools: registry.list(),
  executeTool: async (call, ctx) => {
    const tool = registry.get(call.name);
    if (!tool) {
      return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: "unknown tool", isError: true };
    }
    const result = await tool.execute(call.arguments, { cwd: process.cwd(), signal: ctx.signal, emit: (e) => bus.emit(e) });
    return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError };
  },
});

const run = await agent.run("List the tools you have.");
session.appendUser("List the tools you have.");
for (const m of run.messages) session.appendUser /* or appendAssistant/appendToolResult */(m);
bus.on((e) => process.stdout.write(`[${e.type}] ${JSON.stringify(e.data)}\n`));
```

## Orchestration (depth ≤ 2, by construction)

```ts
import { Orchestrator } from "@elysium/core";

const orchestrator = new Orchestrator({ spawn: mySpawnFn, maxConcurrency: 4, repairRounds: 1 });
const report = await orchestrator.execute({
  goal: "Ship the feature",
  maxDepth: 2,              // the only legal value — anything else is rejected
  subtasks: [{ id: "t1", goal: "Implement X", acceptanceCriteria: ["X works"] }],
});
```

A spawned subagent **cannot** spawn further agents: `SubagentResult` carries no plan, so depth 3 is impossible by construction, not by convention.

## Quality gates

```ts
import { QualityGate, createDefaultRubric } from "@elysium/core";

const gate = new QualityGate();                    // deterministic structural judge
const score = await gate.evaluate(
  { kind: "code", content: generatedCode, criteria: ["handles abort", "no stubs"] },
  createDefaultRubric(),                           // correctness .3 / efficiency .3 / maintainability .2 / principles .2
);
if (!score.passed) console.log(score.reasons);     // targeted retry feedback
```

For live judging, swap in `createLlmJudge(provider)`.

## Interactive agent (`pnpm agent`)

`pnpm agent` starts a professional REPL (mock, offline mode until a real provider is configured with `/key` or `.env`). Slash commands:

| Command | Behavior |
|---|---|
| `/help` | List all commands |
| `/model` | Show current provider/model and available providers |
| `/model <provider>` | Switch provider (`openai`, `deepseek`, `groq`, `together`, `openrouter`, `glm`, `opencode`, `ollama`, `mock`) |
| `/model <provider> <model>` | Switch provider and model |
| `/key <provider> <key>` | Save an API key to `.env` (always masked in output); then run `/model <provider>` to activate |
| `/connections` | Provider status table (configured / key-required) |
| `/tools` | List registered tools |
| `/workspace` | Show the workspace path |
| `/status` | Session status line: provider/model, tool count, turns, messages |
| `/history` | Show the conversation history of the current session |
| `/clear-chat` | Clear the in-memory conversation (fresh chat, same REPL) |
| `/save` | Save the session transcript as markdown to the temp workspace (path via `/workspace`) |
| `/mode [min\|medium\|high\|max]` | Set the effort mode for this session; `/mode` alone shows the active one (see [Effort modes](#effort-modes)) |
| `/swarm <goal>` | Run the goal in Swarmloop mode (see below) — repair rounds are **fixed at 1** regardless of effort mode |
| `/skills` | List indexed skills (from `skills/` dirs or `ELYSIUM_SKILLS_DIR`) |
| `/quit` | Exit cleanly |

**Streaming output**: assistant text arrives live, token by token, as the provider streams it — no waiting for the full turn.

**Per-turn footer**: each completed turn ends with a closing line reporting tokens used, elapsed time, and tokens/sec.

**Friendly provider errors**: provider failures are translated into plain messages with a suggested fix — out-of-credits, rate limit, bad API key, unreachable host (see the troubleshooting table below). The REPL never crashes on them.

**Session status line**: a compact one-line summary (provider · model · tools · turns) is available via `/status` and shown where relevant, so you always know which provider and session state you are talking to.

**Transactional provider switching**: the target provider is built and validated *before* the live agent is touched; a failed switch leaves the previous provider running. Unknown provider names get a closest-match suggestion (e.g. `/model openIA` → *did you mean 'openai'?*).

### Effort modes

`/mode` selects how much work a turn (or a swarm run) may do. The mode is **session-only**: it resets to `medium` when the REPL restarts, and is not persisted to disk.

| Mode | Max turns | Swarm subtasks | Repair rounds | Tool output | System prompt |
|---|---|---|---|---|---|
| `min` | 4 | 1 | 0 | hidden | Terse — minimal instructions |
| `medium` (default) | 8 | 5 | 1 | visible | Standard |
| `high` | 12 | 10 | 2 | visible | Stricter — explicit verification steps |
| `max` | 16 | 15 | 2 | visible | Strictest — double-check everything |

What each column controls: max turns caps the agent loop per turn; swarm subtasks caps the planner's fan-out in `/swarm`; repair rounds is the number of critic-driven retries per failed subtask (note: `/swarm` ignores this column and always uses exactly **1** repair round); tool output visibility controls whether tool results are echoed in the REPL; the system prompt column describes how prescriptive the system prompt is at that mode. `/mode` without arguments shows the active mode.

**Ctrl+C abort**: pressing Ctrl+C during an in-flight agent turn aborts the current turn (via the turn's `AbortSignal`) and returns to the prompt; the provider session and REPL state survive. Pressing it at the prompt exits cleanly (two Ctrl+C within 3 seconds while idle also exits).

## Swarmloop mode (`/swarm`)

Swarmloop mode is a gauntlet-style orchestration profile built on the same depth-≤2 `Orchestrator` engine:

1. **Plan** — your goal goes to a planner agent that decomposes it into subtasks.
2. **Build** — all subtasks run in **parallel** builder agents (with tool access); the live view shows at most 3 panes at once plus the MASTER column and a footer counting the subagents running beyond the visible panes ("+ altri N subagent in parallelo").
3. **Judge** — a fresh-context critic (sees only the artifact, never the builder's history) judges each result.
4. **Repair** — failed results get exactly **one** repair round (fixed — the effort mode does **not** change it) with the critic's gaps as feedback.
5. **Report** — the final report carries per-subtask status, critic verdicts, and quality scores.

Run it from the REPL: `/swarm your-goal`. The number of subtasks is capped (`maxSubtasks`, set by the current effort mode — see [Effort modes](#effort-modes)); a vague goal cannot fan out into an unbounded swarm. Repair rounds are instead **fixed at 1** and do not follow the effort mode.

**Live progress**: during execution the REPL streams what each subagent does in real time — its text output and tool calls, each line prefixed by the subtask's `taskId` — plus critic verdicts and repair rounds as they happen, so the gauntlet is observable end-to-end rather than silent until the final report.

## Provider troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| HTTP 429 with code `1113`, or a Chinese balance/balance-exhausted message | Account **out of credits** | Recharge at the provider console, or `/model` another provider |
| Plain HTTP 429 | **Rate limit** (too many requests) | Wait and retry; slow down parallel work |
| HTTP 401 / 403 | **Bad API key** | Re-set the key with `/key <provider> <key>` |
| `fetch failed` | **Host unreachable** (network down, wrong base URL, provider outage) | Check connectivity and the provider endpoint, or `/model` another provider |

## API keys

- Keys live in `.env`, which is **gitignored** — they are never committed.
- Keys are **always masked** in REPL output (`/key`, `/connections`, error messages).
- If you ever pasted an API key into a chat (this one included), **rotate it** at the provider console and save the new one with `/key`.

## Meta-Layer (self-improvement loop, extension)

The meta-layer subscribes to the event bus, persists telemetry verbatim (JSONL), aggregates observations (first-pass rate, latency), proposes **config-delta hypotheses** (never code patches), applies them under control, re-measures on held-out runs, and promotes only positive deltas (auto-rollback otherwise). See `docs/architecture.md` §5–6 for the normative event and hypothesis formats.

## Benchmarks

```ts
import { BenchmarkRunner, createStandardScenarios, writeBaseline, compare } from "@elysium/benchmarks";
const summary = await new BenchmarkRunner().runAll(createStandardScenarios());
// first-pass rate, token usage, latency, quality score — compare vs docs/baseline.md
```

Metrics are defined in `plan.md` §Measurement; the committed baseline lives in `docs/baseline.md`.

## Security model (summary)

- **Path containment**: filesystem tools resolve real paths and refuse anything outside `allowedRoots` (symlink-aware).
- **Command policy**: `deniedCommands` regexes block, `warnCommands` flag in telemetry, default-allow otherwise.
- **Secrets**: providers read keys from your environment / constructor and never log them.
- **Telemetry**: local JSONL only; no egress beyond configured providers.

Full model: `docs/architecture.md` §4.

## Documentation

- `docs/architecture.md` — normative architecture, public interfaces, state model, telemetry format
- `prd.md` / `plan.md` / `ideas.md` / `doubts.md` — build-time context files (living documents)
- `PHASE_BUILD.md` — the frozen API contract used to build the system itself

## License

MIT
