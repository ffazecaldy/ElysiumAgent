#!/usr/bin/env node
/**
 * Elysium Harness — AI Agent CLI
 *
 *   pnpm agent                     Interactive REPL
 *   pnpm agent "do something"      Single task
 *   pnpm agent --help              Show help
 *
 * REPL slash commands: type /help inside the REPL for the authoritative,
 * always-current list (kept in sync with the dispatcher there — don't
 * duplicate it here).
 *
 * Providers are configured in .env (see .env.example) or via /key.
 * Credential precedence: real environment variables (ELYSIUM_*) win over
 * the .env file values — documented in .env.example, implemented in the
 * loadConfig() helper of packages/cli/src/config.ts. /key writes ONLY to
 * .env — no new credentials file is introduced by this workstream.
 *
 * Error policy: recoverable errors (missing key, unknown provider, failed
 * switch) are caught by the command error boundary and displayed — the REPL
 * always keeps running. Only startup failures may terminate the process,
 * and only from this entrypoint.
 *
 * Ctrl+C (SIGINT) hardening:
 *   - While a generation is in flight, the first SIGINT aborts that run
 *     via Agent.abort() (which bridges to the per-run internal
 *     AbortController in packages/core/src/agent/agent.ts — the external
 *     AgentOptions.signal seam ALSO accepts one; abort() targets exactly
 *     the in-flight run, whatever wired it) and returns to the prompt.
 *     NOTHING in the agent path calls process.exit for a signal.
 *   - Two SIGINTs within 3 seconds while IDLE exit the process (code 0).
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  MockProvider,
  OpenAICompatibleProvider,
  ToolRegistry,
  createBuiltinTools,
  MissingApiKeyError,
  ProviderInitializationError,
  RecoverableCliError,
  UnknownProviderError,
  type ToolResultMessage,
  type ToolCallPart,
  makeEvent,
  type EventBus,
} from "@elysium/core";
import { EventBus as RealEventBus } from "@elysium/core";
import {
  loadConfig,
  saveEnvValue,
  describeConfig,
  maskSecret,
  PROVIDER_NAMES,
  PROVIDER_MODELS,
  PROVIDER_URLS,
  type ProviderConfig,
  type ProviderName,
} from "../packages/cli/src/config";
import {
  dim,
  bold,
  white,
  cyan,
  green,
  red,
  yellow,
  marks,
  section,
  box,
  hr,
  kv,
  spinner,
  thinkingSpinner,
  magenta,
  translateProviderError,
} from "../packages/cli/src/ui";
import { runSwarmGoal, type SwarmEvent } from "../packages/cli/src/swarm-mode";
import { createSwarmView, type SwarmView } from "../packages/cli/src/swarm-view";
import { collectSkills, skillRoots, skillsPromptBlock } from "../packages/cli/src/skills";

/**
 * PROJECT_ROOT governs where .env is read/written. The ELYSIUM_PROJECT_ROOT
 * override exists ONLY so tests can redirect /key persistence to a
 * disposable directory — the default remains the repo root that holds this
 * entrypoint.
 */
const PROJECT_ROOT = process.env.ELYSIUM_PROJECT_ROOT
  ? path.resolve(process.env.ELYSIUM_PROJECT_ROOT)
  : path.resolve(import.meta.dirname, "..");
const WORKSPACE = fs.mkdtempSync(
  path.join(process.env.TEMP || process.env.TMP || "/tmp", "elysium-"),
);

const SYSTEM_PROMPT =
  "You are Elysium, an AI coding agent. " +
  "SCOPE DISCIPLINE (highest priority): do EXACTLY what the user asks - nothing more. " +
  "If the user asks to ANALYZE, read, explain, summarize, or tabulate something, respond with the analysis ONLY: do NOT create files, do NOT write code, do NOT start a project, do NOT run commands beyond what the task requires. " +
  "Create or modify files ONLY when the user explicitly asks to create/modify/write something. " +
  "When the task is done, stop: do not volunteer extra features, follow-ups, or improvements. " +
  "Be concise and direct. State what you did in one line only if you used tools.";

// ── Skills: startup index, read on demand via the builtin `read` tool ──
// The loader only builds a lightweight index (name + description + path)
// from skills/ directories; the full SKILL.md content is pulled by the
// agent through the existing `read` tool only when a task matches. No new
// tool, no core change, no background work.
const SKILLS = collectSkills(skillRoots(PROJECT_ROOT));
const SKILLS_PROMPT_BLOCK = skillsPromptBlock(SKILLS);

// ── Effort modes (/mode) ──────────────────────────────────────────

/** Elysium intensity mode — a session-only effort dial, never persisted. */
export type Mode = "min" | "medium" | "high" | "max";

const VALID_MODES: readonly Mode[] = ["min", "medium", "high", "max"];

/** Type guard: is this raw user input one of the four effort modes? */
function isMode(value: string): value is Mode {
  return (VALID_MODES as readonly string[]).includes(value);
}

/** Per-mode budget: turn/subtask/repair caps, tool-line visibility, prompt tail. */
interface ModeConfig {
  label: string;
  maxTurns: number;
  maxSubtasks: number;
  repairRounds: number;
  showToolOutput: boolean;
  systemPromptSuffix: string;
}

const MODES: Record<Mode, ModeConfig> = {
  min: {
    label: "min - fast answers, no subagents",
    maxTurns: 4,
    maxSubtasks: 1,
    repairRounds: 0,
    showToolOutput: false,
    systemPromptSuffix: " Be terse.",
  },
  medium: {
    label: "medium - balanced",
    maxTurns: 8,
    maxSubtasks: 5,
    repairRounds: 1,
    showToolOutput: true,
    systemPromptSuffix: "",
  },
  high: {
    label: "high - thorough, more repair",
    maxTurns: 12,
    maxSubtasks: 10,
    repairRounds: 2,
    showToolOutput: true,
    systemPromptSuffix: " Think step by step and verify your work before answering.",
  },
  max: {
    label: "max - maximum effort",
    maxTurns: 16,
    maxSubtasks: 15,
    repairRounds: 2,
    showToolOutput: true,
    systemPromptSuffix:
      " Think step by step, verify your work, consider edge cases, and double-check the result before answering.",
  },
};

/** Active effort mode. Session-only: nothing here is written to .env. */
let currentMode: Mode = "medium";

/** System prompt for the current mode: base prompt + skills index + the mode's suffix. */
function systemPromptForMode(): string {
  return SYSTEM_PROMPT + SKILLS_PROMPT_BLOCK + MODES[currentMode].systemPromptSuffix;
}

// ── Session stats (for /status /history /save) ────────────────────

interface SessionStats {
  startedAt: number;
  prompts: string[];
  tokensIn: number;
  tokensOut: number;
  turns: number;
  transcript: Array<{ role: string; text: string }>;
}

function newSessionStats(): SessionStats {
  return {
    startedAt: Date.now(),
    prompts: [],
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    transcript: [],
  };
}

/**
 * Set by the Agent onEvent callback while streaming live (TTY only).
 * The run path resets it before each run and skips the replay loop
 * when the content was already streamed.
 */
let liveStreamed = false;
let inThink = false;
let activeSpinner: ReturnType<typeof thinkingSpinner> | null = null;

// ── Event bus (shared: meta-layer & CLI both consume) ─────────────

const eventBus: EventBus = new RealEventBus({ bufferSize: 2000 });

/** Emit a CLI error as a structured event (no secrets in payload, ever). */
function emitCliError(kind: string, message: string): void {
  eventBus.emit({
    type: "error",
    timestamp: new Date().toISOString(),
    data: { scope: "cli", kind, message },
  });
}

// ── Provider factory: THROWS typed errors, NEVER process.exit ─────

const CREDENTIAL_LESS = new Set<string>(["mock", "ollama"]);

function makeProvider(config: ProviderConfig) {
  if (config.provider === "mock") {
    return new MockProvider([
      {
        text: "I am running in mock mode (offline). Configure a real provider with /key or .env file.",
      },
    ]);
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "ollama",
    model: config.model,
  });
}

/**
 * Validate + attempt to initialize the candidate provider BEFORE committing.
 * Throws typed RecoverableCliError subclasses only — never process.exit.
 */
function assertSwitchable(candidate: ProviderConfig): void {
  if (!(candidate.provider in PROVIDER_URLS)) {
    throw new UnknownProviderError(candidate.provider);
  }
  if (!CREDENTIAL_LESS.has(candidate.provider) && !candidate.apiKey) {
    throw new MissingApiKeyError(candidate.provider);
  }
}

function wireAgentFor(
  config: ProviderConfig,
  registry: ToolRegistry,
  hooks?: { stats?: SessionStats },
): Agent {
  const provider = makeProvider(config);
  return new Agent({
    // maxTurns comes from the active effort mode; the system prompt is the
    // base prompt with the mode's suffix appended (empty for medium).
    systemPrompt: systemPromptForMode(),
    provider,
    tools: registry.list(),
    maxTurns: MODES[currentMode].maxTurns,
    executeTool: async (call, ctx): Promise<ToolResultMessage> => {
      const tool = registry.get(call.name);
      if (!tool) {
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
          cwd: process.cwd(),
          signal: ctx.signal,
          emit: (e) => eventBus.emit(e),
        });
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: result.isError,
          ...(result.details !== undefined ? { details: result.details } : {}),
        };
      } catch (err: unknown) {
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
    // Live streaming: the ANSWER prints in normal readable color (white);
    // tool activity prints as compact dim status lines. Never dim the answer.
    onEvent: (e) => {
      if (e.kind === "text_delta") {
        const d = (e.data as { delta?: string }).delta ?? "";
        if (d) {
          if (liveStreamed === false) {
            // First delta: stop the thinking spinner so output starts clean.
            activeSpinner?.stop();
            activeSpinner = null;
            liveStreamed = true;
          }
          // Render with think-awareness (dim inside <think>, white outside).
          let rest = d;
          while (rest.length > 0) {
            if (inThink) {
              const end = rest.indexOf("</think>");
              if (end >= 0) {
                process.stdout.write(dim(rest.slice(0, end)));
                rest = rest.slice(end + 8);
                inThink = false;
                process.stdout.write("\n");
              } else {
                process.stdout.write(dim(rest));
                rest = "";
              }
            } else {
              const start = rest.indexOf("<think>");
              if (start >= 0) {
                process.stdout.write(white(rest.slice(0, start)));
                inThink = true;
                rest = rest.slice(start + 7);
              } else {
                process.stdout.write(white(rest));
                rest = "";
              }
            }
          }
        }
      } else if (e.kind === "tool_result") {
        // Live tool lines are the mode's showToolOutput dial: min keeps the
        // transcript quiet (text still streams), other modes show status.
        if (!MODES[currentMode].showToolOutput) return;
        const m = (e.data as { message?: ToolResultMessage }).message;
        if (m) {
          const status = m.isError ? red("err") : green("ok");
          const preview = m.content.length > 90 ? m.content.slice(0, 90) + "…" : m.content;
          console.log(
            `\n  ${dim("tool " + m.toolName + " " + status + "  " + preview.replace(/\n/g, " "))}`,
          );
        }
      }
    },
  });
}

// ── Edit-distance for the /model suggestion ──────────────────────

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function suggestProvider(name: string): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const known of Object.keys(PROVIDER_URLS)) {
    const d = editDistance(name, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  return best && bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

// ── Key validation + masking (never log/echo the full key) ───────

const MIN_KEY_LENGTH = 8;

/**
 * Structural validation of an API key. Returns a human reason for
 * rejection, or null when the key is acceptable. NEVER logs, prints, or
 * forwards the key itself — only reason strings built from the key's
 * *shape* (length, whitespace, quoting) reach output.
 */
function validateApiKey(key: string): string | null {
  if (key.length < MIN_KEY_LENGTH) {
    return `Key too short: ${key.length} chars (minimum ${MIN_KEY_LENGTH})`;
  }
  if (/\s/.test(key)) {
    return "Key must not contain whitespace";
  }
  if (/["'`]/.test(key)) {
    return "Key must not contain quote characters";
  }
  return null;
}

/**
 * Non-reversible display mask — thin delegation to the shared maskSecret()
 * from packages/cli/src/config so CLI and config masking never drift.
 */
function maskKey(key: string): string {
  return maskSecret(key);
}

// ── Command dispatcher (transactional provider switching) ────────

interface ReplState {
  config: ProviderConfig;
  /** Live provider state: the committed config the agent is wired to. */
  committed: ProviderConfig;
}

function renderRecoverableError(title: string, action: string): void {
  console.log(`\n  ${yellow(marks.warn)} ${bold(title)}`);
  if (action) console.log(`  ${dim(marks.info + " " + action)}`);
  console.log();
}

async function dispatchCommand(
  input: string,
  state: ReplState,
  registry: ToolRegistry,
  rebuildAgent: (config: ProviderConfig) => void,
  xo?: { stats: SessionStats; setAgent: (a: Agent) => void; committed: () => ProviderConfig },
): Promise<void> {
  // /quit and /clear are handled by the caller (process-level).
  if (input === "/help") {
    console.log(`
  ${cyan("Session")}
    /status                 Provider, model, tokens, uptime
    /mode [min|medium|high|max]  Effort mode (default medium)
    /history                Prompts from this session
    /save                   Write transcript as markdown to the workspace
    /clear-chat             Reset conversation (fresh agent)

  ${cyan("Providers")}
    /model                  Show current provider and model
    /model <provider>       Switch (openai | deepseek | groq | together | openrouter | glm | opencode | ollama | mock)
    /model <provider> <m>   Switch provider and model
    /connections            Provider status table
    /key <provider> <key>   Set API key (>= 8 chars, saved to .env, never echoed fully)

  ${cyan("Agent")}
    /swarm <goal>           Gauntlet mode: plan -> builders -> critic -> repair
    /skills                 List indexed skills
    /tools                  List tools
    /workspace              Show workspace path

  ${cyan("REPL")}
    /clear                  Clear screen
    /help                   This help
    /quit                   Exit
`);
    return;
  }
  if (input === "/model") {
    console.log(`\n  Current: ${describeConfig(state.config)}`);
    console.log(`\n  Available providers:`);
    for (const [k, v] of Object.entries(PROVIDER_NAMES)) {
      console.log(`    ${k === state.committed.provider ? "* " : "  "}${k.padEnd(12)} ${v}`);
    }
    console.log();
    return;
  }
  if (input === "/mode" || input.startsWith("/mode ")) {
    const arg = input.slice(5).trim();
    if (arg.length === 0) {
      // Table of the 4 modes; asterisk marks the active one.
      console.log(`\n  Effort modes (session-only, not saved to .env):`);
      for (const m of VALID_MODES) {
        const active = m === currentMode;
        console.log(`    ${active ? "*" : " "} ${m.padEnd(8)} ${MODES[m].label}`);
      }
      console.log(`\n  ${dim("Switch with /mode <name>")}\n`);
      return;
    }
    if (!isMode(arg)) {
      throw new RecoverableCliError(
        `Unknown mode: ${arg}`,
        `Valid modes: ${VALID_MODES.join(" | ")} — usage: /mode <name>`,
      );
    }
    currentMode = arg;
    // Rebuild so maxTurns and the suffixed system prompt take effect.
    if (xo) xo.setAgent(wireAgentFor(xo.committed(), registry));
    console.log(`\n  ${green(marks.ok)} Mode: ${MODES[currentMode].label}\n`);
    return;
  }
  if (input.startsWith("/model ")) {
    const parts = input.slice(7).trim().split(/\s+/);
    const target = parts[0] as string;
    const targetModel = parts[1];
    if (!(target in PROVIDER_URLS)) {
      const suggestion = suggestProvider(target);
      let msg = `Unknown provider: ${target}`;
      if (suggestion) msg += ` — did you mean '${suggestion}'?`;
      throw new UnknownProviderError(target);
    }
    // Build candidate config, validate BEFORE touching the live one.
    // Read the provider's key from the live .env (user may have set it via /key).
    const freshEnv = loadConfig(PROJECT_ROOT);
    const candidateKey =
      target === freshEnv.provider
        ? freshEnv.apiKey
        : target === state.committed.provider
          ? state.committed.apiKey
          : "";
    const candidate: ProviderConfig = {
      ...state.committed,
      provider: target as ProviderName,
      baseUrl: PROVIDER_URLS[target] ?? "",
      model: targetModel ?? PROVIDER_MODELS[target] ?? "",
      apiKey: candidateKey,
    };
    assertSwitchable(candidate);
    // Initialize the candidate provider before committing.
    let candidateAgent: Agent;
    try {
      candidateAgent = wireAgentFor(candidate, registry);
    } catch (err: unknown) {
      if (err instanceof RecoverableCliError) throw err;
      throw new ProviderInitializationError(
        `Provider ${target} failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Commit only on success: rebuild the live agent onto the candidate.
    state.committed = candidate;
    state.config = candidate;
    rebuildAgent(candidate);
    void candidateAgent;
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", target);
    if (targetModel) saveEnvValue(PROJECT_ROOT, "ELYSIUM_MODEL", targetModel);
    console.log(`\n  ${green(marks.ok)} Active provider: ${describeConfig(candidate)}\n`);
    return;
  }
  if (input.startsWith("/key ")) {
    const parts = input.slice(5).trim().split(/\s+/);
    if (parts.length < 2) {
      throw new RecoverableCliError("Missing arguments", "Usage: /key <provider> <api-key>");
    }
    if (parts.length > 2) {
      throw new RecoverableCliError(
        "Key must be a single token",
        "Usage: /key <provider> <api-key> — no spaces inside the key",
      );
    }
    const prov = parts[0]!;
    const key = parts[1]!;
    if (!(prov in PROVIDER_URLS) && prov !== "mock") {
      throw new UnknownProviderError(prov);
    }
    if (CREDENTIAL_LESS.has(prov)) {
      throw new RecoverableCliError(
        "mock/ollama non richiedono chiave",
        `Nessuna azione necessaria: ${PROVIDER_NAMES[prov] ?? prov} funziona senza API key`,
      );
    }
    // Validated BEFORE anything is persisted: a rejected key leaves the
    // .env untouched and the committed provider unchanged.
    const rejection = validateApiKey(key);
    if (rejection !== null) {
      throw new RecoverableCliError(
        rejection,
        `Usage: /key ${prov} <api-key> (>= 8 chars, no spaces, no quotes)`,
      );
    }
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_API_KEY", key);
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", prov);
    console.log(
      `\n  ${green(marks.ok)} Key saved for ${PROVIDER_NAMES[prov] ?? prov} (${maskKey(key)})`,
    );
    console.log(`  → Now switch: /model ${prov}\n`);
    return;
  }
  if (input === "/connections") {
    console.log(`\n  Providers (configured in .env or via /key):`);
    for (const [name, url] of Object.entries(PROVIDER_URLS)) {
      const configured =
        name in CREDENTIAL_LESS ? "ready (no key needed)" : "key required (/key <provider> <key>)";
      console.log(
        `    ${name.padEnd(12)} ${String(PROVIDER_NAMES[name]).padEnd(16)} ${url.padEnd(40)} ${configured}`,
      );
    }
    console.log();
    return;
  }
  if (input === "/skills") {
    if (SKILLS.length === 0) {
      console.log(
        `\n  No skills indexed. Add a directory with a SKILL.md (frontmatter: name, description) under one of:`,
      );
      for (const root of skillRoots(PROJECT_ROOT)) console.log(`    ${root}`);
      console.log();
      return;
    }
    console.log(section("skills"));
    for (const s of SKILLS) {
      console.log(`  ${cyan(s.name)}  ${dim(s.description)}`);
      console.log(`    ${dim(s.file)}`);
    }
    console.log(
      `\n  ${dim("The agent reads a skill's SKILL.md with the read tool when the task matches.")}\n`,
    );
    return;
  }
  if (input === "/tools") {
    console.log(`\n  Available tools:`);
    for (const t of registry.list()) {
      console.log(`    ${t.name.padEnd(14)} ${t.description.slice(0, 65)}`);
    }
    console.log(`\n  Workspace: ${WORKSPACE}\n`);
    return;
  }
  if (input === "/workspace") {
    console.log(`\n  ${WORKSPACE}\n`);
    return;
  }
  if (input === "/status") {
    if (!xo) return;
    const st = xo.stats;
    const upMs = Date.now() - st.startedAt;
    const up =
      upMs >= 60000
        ? `${Math.floor(upMs / 60000)}m ${Math.floor((upMs % 60000) / 1000)}s`
        : `${Math.floor(upMs / 1000)}s`;
    const committed = xo.committed();
    console.log(section("session"));
    console.log(`  ${kv("provider", PROVIDER_NAMES[committed.provider] ?? committed.provider)}`);
    console.log(`  ${kv("model", committed.model)}`);
    console.log(`  ${kv("key", committed.apiKey ? maskSecret(committed.apiKey) : "(none)")}`);
    console.log(`  ${kv("turns", String(st.turns))}`);
    console.log(`  ${kv("tokens", String(st.tokensIn + st.tokensOut))}`);
    console.log(`  ${kv("uptime", up)}`);
    console.log(`  ${kv("workspace", WORKSPACE)}\n`);
    return;
  }
  if (input === "/history") {
    if (!xo) return;
    if (xo.stats.prompts.length === 0) {
      console.log(`\n  ${dim("no prompts yet this session")}\n`);
      return;
    }
    console.log(`\n  ${cyan("Prompts this session")}`);
    xo.stats.prompts.forEach((prompt, i) => {
      const oneLine = prompt.replace(/\s+/g, " ");
      const shown = oneLine.length > 70 ? oneLine.slice(0, 70) + "…" : oneLine;
      console.log(`  ${dim(String(i + 1).padStart(2))}. ${shown}`);
    });
    console.log();
    return;
  }
  if (input === "/clear-chat") {
    if (!xo) return;
    xo.setAgent(wireAgentFor(xo.committed(), registry));
    xo.stats.transcript.length = 0;
    xo.stats.turns = 0;
    xo.stats.tokensIn = 0;
    xo.stats.tokensOut = 0;
    console.log(`\n  ${marks.ok} Conversation reset (fresh agent, stats zeroed).\n`);
    return;
  }
  if (input === "/save") {
    if (!xo) return;
    const file = path.join(
      WORKSPACE,
      `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
    );
    const lines = [
      "# Elysium session transcript",
      "",
      `- date: ${new Date().toISOString()}`,
      `- provider: ${xo.committed().provider} (${xo.committed().model})`,
      `- turns: ${xo.stats.turns}, tokens: ${xo.stats.tokensIn} in / ${xo.stats.tokensOut} out`,
      "",
    ];
    for (const m of xo.stats.transcript) {
      lines.push(m.role === "user" ? "## > user" : "## elysium", "", m.text, "");
    }
    fs.writeFileSync(file, lines.join("\n"), "utf-8");
    console.log(`\n  ${marks.ok} Transcript saved: ${file}\n`);
    return;
  }
  if (input.startsWith("/swarm ")) {
    if (!xo) return;
    const goal = input.slice(7).trim();
    if (goal.length === 0) {
      throw new RecoverableCliError("Missing goal", "Usage: /swarm <what to achieve>");
    }
    const committed = xo.committed();
    if (!CREDENTIAL_LESS.has(committed.provider) && !committed.apiKey) {
      throw new MissingApiKeyError(committed.provider);
    }
    const sp = spinner();
    sp.start("swarm: planning…");
    // Ctrl+C/Esc abort seam: SIGINT handlers see the swarm as an in-flight
    // run via the shared seam; their abort() cancels this controller and
    // unwinds runSwarmGoal through its AbortSignal.
    const controller = new AbortController();
    const runSeam = (
      globalThis as { __elysiumRunSeam?: { start(a: { abort(): void }): void; end(): void } }
    ).__elysiumRunSeam;
    runSeam?.start({ abort: () => controller.abort() });
    const providerCfg = {
      baseUrl: committed.baseUrl,
      apiKey: committed.apiKey || "ollama",
      model: committed.model,
    };
    let view: SwarmView | null = null;
    let planned = false;
    try {
      const report = await runSwarmGoal({
        goal,
        provider: providerCfg,
        maxSubtasks: MODES[currentMode].maxSubtasks,
        signal: controller.signal,
        onEvent: (e: SwarmEvent) => {
          if (e.type === "plan") {
            sp.stop("plan ready");
            planned = true;
            const d = e.data as {
              subtasks?: Array<{ id: string; goal: string }>;
              workspacePath?: string;
            };
            view = createSwarmView();
            view.plan(goal, d.subtasks ?? [], d.workspacePath ?? "");
          } else if (e.type === "task_started") {
            view?.taskStarted((e.data as { taskId?: string }).taskId ?? "");
          } else if (e.type === "task_output") {
            const d = e.data as { taskId?: string; text?: string };
            if (d.taskId !== undefined && d.text !== undefined) view?.taskOutput(d.taskId, d.text);
          } else if (e.type === "task_tool") {
            const d = e.data as { taskId?: string; tool?: string; isError?: boolean };
            if (d.taskId !== undefined && d.tool !== undefined) {
              view?.taskTool(d.taskId, d.tool, d.isError === true);
            }
          } else if (e.type === "task_ended") {
            const d = e.data as {
              taskId?: string;
              status?: string;
              durationMs?: number;
              attempts?: number;
            };
            view?.taskEnded(d.taskId ?? "", d.status ?? "fail", d.durationMs ?? 0, d.attempts ?? 1);
          } else if (e.type === "critic") {
            const d = e.data as { taskId?: string; passed?: boolean; phase?: string };
            if (d.phase !== "start") view?.critic(d.taskId ?? "", d.passed === true);
          } else if (e.type === "repair") {
            const d = e.data as { taskId?: string; round?: number };
            view?.repair(d.taskId ?? "", d.round ?? 1);
          } else if (e.type === "error") {
            const d = e.data as { message?: string };
            if (d.message !== undefined) view?.error(d.message);
          }
        },
      });
      view?.finish();
      console.log(`\n  ${green(marks.ok)} swarm complete`);
      console.log(`  ${section("report")}`);
      console.log(
        `  ${report.allPassed ? green("all subtasks passed") : yellow("completed with failures")}`,
      );
      for (const sub of report.subtasks) {
        const icon = sub.result.status === "pass" ? green(marks.ok) : red(marks.err);
        console.log(`  ${icon} ${sub.task.id}: ${dim(sub.result.summary.slice(0, 100))}`);
      }
      for (const sc of report.scores) {
        console.log(
          `  ${cyan("quality")} ${sc.taskId.padEnd(12)} ${sc.weighted}/10 ${sc.passed ? green("pass") : red("fail")}`,
        );
      }
      console.log(`\n  ${dim("workspace: " + report.workspacePath)}\n`);
    } catch (err: unknown) {
      view?.finish();
      if (controller.signal.aborted) {
        // User-initiated cancellation (SIGINT/Esc via the run seam): a
        // cancelled swarm is not an error — settle quietly and return.
        if (!planned) sp.stop(undefined, "swarm cancelled");
        console.log(`\n  ${yellow(marks.warn)} Generation cancelled (Ctrl+C)\n`);
        return;
      }
      if (!planned) sp.stop(undefined, "swarm failed");
      throw err;
    } finally {
      runSeam?.end();
    }
    return;
  }
  if (input.startsWith("/")) {
    const cmd = input.split(/\s+/)[0] ?? "";
    console.log(`\n  ${yellow(marks.warn)} Unknown command: ${cmd}`);
    console.log(`  ${dim(marks.info + " /help lists available commands")}\n`);
    return;
  }
}

// ── REPL loop with command error boundary + Ctrl+C seam ──────────

async function runRepl(startConfig: ProviderConfig): Promise<void> {
  const registry = createToolRegistry();
  const stats = newSessionStats();
  const state: ReplState = { config: startConfig, committed: startConfig };
  let agent = wireAgentFor(state.committed, registry, { stats });

  console.log(box("ELYSIUM", "AI agent with tool use"));
  console.log();
  console.log(kv("provider", describeConfig(state.committed)));
  console.log(kv("cwd", process.cwd()));
  console.log(kv("artifacts", WORKSPACE));
  console.log(kv("mode", MODES[currentMode].label));
  console.log(kv("tools", "read write edit bash"));
  console.log(
    kv(
      "skills",
      SKILLS.length > 0 ? SKILLS.map((s) => s.name).join(", ") : "(none — add dirs under skills/)",
    ),
  );
  console.log(`  ${dim("Type /help for commands. Ctrl+C aborts a run; twice to quit.\n")}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${cyan("❯")} `,
    historySize: 100,
  });
  rl.prompt();

  // Serialize line handling: piped readline fires faster than async
  // handlers settle, so /quit could otherwise exit before earlier
  // commands finish (this caused the original "silent no-op" symptom).
  let lineQueue: Promise<void> = Promise.resolve();
  let working = false; // a run is in flight
  let warnedThisRun = false;
  rl.on("line", (raw: string) => {
    if (working) {
      // The agent is generating. Queue typed-ahead lines (so /quit is never
      // lost) but warn once per run that a new task cannot start mid-run.
      const t = raw.trim();
      if (t.length > 0 && !warnedThisRun) {
        warnedThisRun = true;
        console.log(
          `\n  ${yellow(marks.warn)} Elysium is working — "${t === "/quit" ? "/quit" : "input"}" queued; Esc cancels the run.\n`,
        );
      }
      lineQueue = lineQueue
        .then(() =>
          handleReplLine(raw, {
            state,
            registry,
            stats,
            setAgent: (a) => {
              agent = a;
            },
            getAgent: () => agent,
            setWorking: (w) => {
              working = w;
            },
          }),
        )
        .catch(() => undefined);
      return;
    }
    working = true;
    lineQueue = lineQueue
      .then(() =>
        handleReplLine(raw, {
          state,
          registry,
          stats,
          setAgent: (a) => {
            agent = a;
          },
          getAgent: () => agent,
          setWorking: (w) => {
            working = w;
          },
        }),
      )
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "readline was closed") return; // stdin EOF race after last line: benign
        console.error(`\n  ${marks.err} Command loop error: ${msg}\n`);
      })
      .finally(() => {
        working = false;
        warnedThisRun = false;
        rl.prompt();
      });
  });

  // stdin EOF (piped input or Ctrl+D): wait for the line queue to settle —
  // an in-flight agent run must finish and print before the process exits.
  rl.on("close", () => {
    lineQueue.then(() => process.exit(0)).catch(() => process.exit(0));
  });

  // ── Ctrl+C (SIGINT) seam: abort generation, not the process ──────
  // The abort/target pair are registered by the agent-turn path below:
  //   onRunStart(agent) — the runner says "this run is in flight NOW";
  //   onRunEnd()        — the runner says "the run has settled".
  // SIGINT: (1) if a run is in flight → agent.abort() once, report, return
  // to prompt (NO process.exit — paths like the serial queue settle first);
  // (2) idle → double-press within 3s exits, single press just warns.
  // The handler is registered on BOTH the readline interface and the
  // process: piped stdin delivers \x03 as a readline "SIGINT" event (no
  // OS signal exists), while a real terminal raises OS-level SIGINT.
  let inFlight: Agent | null = null;
  let lastCtrlC = 0; // ms timestamp of previous SIGINT, for the 3s window
  const DOUBLE_EXIT_WINDOW_MS = 3_000;

  const onRunStart = (a: Agent): void => {
    inFlight = a;
  };
  const onRunEnd = (): void => {
    inFlight = null;
  };

  const handleSigint = (): void => {
    const now = Date.now();
    const running = inFlight;
    if (running !== null) {
      running.abort(); // per-run AbortController inside the core Agent loop
      inFlight = null;
      console.log(`\n  ${yellow(marks.warn)} Generation aborted — back at the prompt.\n`);
      rl.prompt();
      return;
    }
    // Idle (no in-flight generation):
    if (lastCtrlC > 0 && now - lastCtrlC < DOUBLE_EXIT_WINDOW_MS) {
      process.exit(0);
    }
    lastCtrlC = now;
    console.log(`\n  ${yellow(marks.warn)} Press Ctrl+C again within 3s to exit.\n`);
    rl.prompt();
  };

  rl.on("SIGINT", handleSigint);
  process.on("SIGINT", handleSigint);

  // ── Esc key: abort the in-flight run; double-Esc (idle) exits ──
  // readline only emits keypress events when we opt in:
  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let lastEsc = 0;
  process.stdin.on(
    "keypress",
    (_ch: string, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (!key || key.name !== "escape") return;
      const now = Date.now();
      const running = inFlight;
      if (running !== null) {
        running.abort();
        inFlight = null;
        console.log(`\n  ${yellow(marks.warn)} Generation cancelled (Esc) — back at the prompt.`);
        rl.prompt();
        return;
      }
      // Idle: double-Esc within 3s exits (mirrors double-Ctrl+C).
      if (lastEsc > 0 && now - lastEsc < 3_000) process.exit(0);
      lastEsc = now;
    },
  );

  // Open the seam to the agent-turn path without a global. The start()
  // parameter is structural: anything abortable (Agent, AbortController
  // wrapper, swarm controller) satisfies it — no Agent import needed here.
  (
    globalThis as { __elysiumRunSeam?: { start(a: { abort(): void }): void; end(): void } }
  ).__elysiumRunSeam = {
    start: onRunStart,
    end: onRunEnd,
  };
}

interface ReplContext {
  state: ReplState;
  registry: ToolRegistry;
  stats: SessionStats;
  setAgent: (agent: Agent) => void;
  getAgent: () => Agent;
  setWorking: (working: boolean) => void;
}

async function handleReplLine(input: string, xo: ReplContext): Promise<void> {
  const line = input.trim();
  if (!line) return;
  if (line === "/quit" || line === "/exit") {
    console.log("\n  " + dim("session ended.") + "\n");
    process.exit(0);
  }
  if (line === "/clear") {
    console.clear();
    return;
  }

  // ── Command error boundary: recoverable errors keep the REPL alive ──
  if (line.startsWith("/")) {
    try {
      await dispatchCommand(
        line,
        xo.state,
        xo.registry,
        (nextConfig) => {
          xo.setAgent(wireAgentFor(nextConfig, xo.registry));
        },
        { stats: xo.stats, setAgent: xo.setAgent, committed: () => xo.state.committed },
      );
    } catch (err: unknown) {
      if (err instanceof RecoverableCliError) {
        emitCliError("recoverable_command_error", `${err.name}: ${err.message}`);
        renderRecoverableError(
          `${err.message} (provider stays: ${xo.state.committed.provider})`,
          err.action,
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        emitCliError("internal_command_error", msg);
        console.error(`\n  ✗ Internal command error (logged): ${msg}`);
        console.error("  The REPL stays alive. Please report this if it recurs.\n");
      }
    }
    return;
  }

  // ── Agent turn ──
  try {
    const t0 = Date.now();
    const agent = xo.getAgent();
    xo.stats.prompts.push(line);
    // Mark in-flight so SIGINT/Esc can abort exactly this run through the
    // Agent.abort() seam (a per-run AbortController inside the core loop).
    const seam = (
      globalThis as { __elysiumRunSeam?: { start(a: { abort(): void }): void; end(): void } }
    ).__elysiumRunSeam;
    seam?.start(agent);
    xo.setWorking(true);
    const sp = thinkingSpinner();
    activeSpinner = sp;
    sp.start("");
    liveStreamed = false;
    inThink = false;
    let result;
    try {
      result = await agent.run(line);
    } finally {
      seam?.end();
      xo.setWorking(false);
      activeSpinner?.stop();
      activeSpinner = null;
    }
    const dt = Date.now() - t0;
    if (liveStreamed) {
      // Deltas were already printed live; just close the block.
      process.stdout.write("\n");
    } else {
      // Nothing streamed (mock/quiet provider): replay the transcript.
      let printed = false;
      for (const m of result.messages) {
        if (m.role === "assistant" && m.text) {
          console.log(`\n${m.text}`);
          printed = true;
        } else if (m.role === "tool_result") {
          const icon = m.isError ? marks.err : marks.ok;
          const preview = m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content;
          console.log(`  ${icon} ${m.toolName}: ${preview}`);
        }
      }
      if (!printed) console.log("\n  (no response)");
    }
    // Session bookkeeping.
    if (xo.stats) {
      xo.stats.tokensIn += result.usage.inputTokens;
      xo.stats.tokensOut += result.usage.outputTokens;
      xo.stats.turns += result.turns;
      const lastA = [...result.messages].reverse().find((m) => m.role === "assistant");
      xo.stats.transcript.push({ role: "user", text: line });
      if (lastA && lastA.role === "assistant")
        xo.stats.transcript.push({ role: "assistant", text: lastA.text });
    }

    // Closing summary line: turn count, token totals, tokens/sec (output
    // tokens over wall-clock seconds, 1 decimal), wall time. Aborted runs
    // are flagged so partial output is never mistaken for a full answer.
    // A sub-millisecond run divides by zero — show an em dash rate instead
    // of Infinity.
    const tokensPerSec = dt > 0 ? (result.usage.outputTokens / (dt / 1000)).toFixed(1) : "—";
    const seconds = (dt / 1000).toFixed(1);
    const abortedSuffix = result.stopReason === "aborted" ? " | aborted" : "";
    const secs = dt / 1000;
    const tps = secs > 0 ? (result.usage.outputTokens / secs).toFixed(1) : "-";
    const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
    console.log(
      `  ${dim(`─ ${totalTokens} tok · ${tps} tok/s · ${(dt / 1000).toFixed(1)}s${result.stopReason === "aborted" ? " · aborted" : ""}`)}`,
    );
  } catch (err: unknown) {
    if (err instanceof RecoverableCliError) {
      renderRecoverableError(err.message, err.action);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      // A turn-budget exhaustion is a user-facing effort-dial condition, not
      // a provider/network failure: render it with its own remedy instead of
      // the generic provider error translation.
      if (msg.includes("max turns exceeded")) {
        emitCliError("max_turns_exceeded", msg);
        renderRecoverableError(
          "Limite turni raggiunto (mode: " + currentMode + ")",
          "Alza con /mode high|max o spezza il task",
        );
        return;
      }
      emitCliError("agent_run_error", msg);
      // Friendly translation for provider/network failures.
      const t = translateProviderError(err);
      console.error(`\n  ${red(marks.err)} ${yellow(t.title)}`);
      console.error(`  ${dim("→ " + t.hint)}`);
      console.error(`  ${dim("detail: " + t.detail)}\n`);
    }
  }
}

// ── Single task mode ─────────────────────────────────────────────

async function runSingleTask(config: ProviderConfig, task: string): Promise<void> {
  const registry = createToolRegistry();
  // Startup gate (fatal, entrypoint-level only): missing credentials for a
  // non-interactive single task CANNOT be recovered interactively.
  if (!(config.provider in PROVIDER_URLS) && config.provider !== "mock") {
    console.error(`  ⚠  Unknown provider: ${config.provider}`);
    process.exit(1);
  }
  if (!CREDENTIAL_LESS.has(config.provider) && !config.apiKey) {
    console.error(`\n  ⚠  No API key for ${PROVIDER_NAMES[config.provider] ?? config.provider}.`);
    console.error(`  → Add it to .env or run: pnpm agent, then /key ${config.provider} <key>\n`);
    process.exit(1);
  }
  const agent = wireAgentFor(config, registry);
  const t0 = Date.now();
  const result = await agent.run(task);
  const dt = Date.now() - t0;
  for (const m of result.messages) {
    if (m.role === "assistant" && m.text) console.log(`\n${m.text}`);
    else if (m.role === "tool_result")
      console.log(`  → [${m.toolName}] ${m.isError ? "✗ " : ""}${m.content.slice(0, 200)}`);
  }
  console.log(
    `\n─── ${result.turns} turns, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ${dt}ms ───`,
  );
}

function createToolRegistry(): ToolRegistry {
  const policy = { allowedRoots: [WORKSPACE, process.cwd()] };
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(policy)) registry.register(tool);
  return registry;
}

// ── Safety nets (entrypoint only, never inside core) ────────────

let replActive = false;

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  emitCliError("unhandled_rejection", msg);
  if (replActive) {
    console.error(`\n  ✗ [unhandledRejection, logged, still alive] ${msg}\n`);
    process.stdout.write("> ");
  } else {
    console.error(`  ✗ Unhandled rejection: ${msg}`);
  }
});

process.on("uncaughtException", (err) => {
  emitCliError("uncaught_exception", err.message);
  if (replActive) {
    console.error(`\n  ✗ [uncaughtException, logged, still alive] ${err.message}\n`);
    process.stdout.write("> ");
  } else {
    console.error(err);
    process.exit(1);
  }
});

function showHelp(): void {
  console.log(`
Elysium Harness — AI Agent

Usage:
  pnpm agent                           Interactive REPL
  pnpm agent "do something"            Single task
  pnpm agent --provider mock           Force offline mock mode
  pnpm agent --help                    Show this help

Providers: openai | deepseek | groq | together | openrouter | glm | opencode | ollama | mock
Configure: copy .env.example to .env, or /key <provider> <key> in the REPL.
Precedence: ELYSIUM_* environment variables win over .env file values.
Keys must be >= 8 chars and are shown masked (first 4 + … + last 4).
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let taskArg: string | null = null;
  let providerArg: string | null = null;
  if (argv.includes("--help") || argv.includes("-h")) {
    showHelp();
    return;
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task" && argv[i + 1]) {
      taskArg = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (argv[i] === "--provider" && argv[i + 1]) {
      providerArg = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (argv[i] !== undefined && !argv[i]!.startsWith("-")) taskArg = argv[i]!;
  }
  let config = loadConfig(PROJECT_ROOT);
  if (providerArg) config = { ...config, provider: providerArg as ProviderName };

  replActive = true;
  if (taskArg) {
    replActive = false;
    await runSingleTask(config, taskArg);
  } else {
    await runRepl(config);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
