#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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
import {
  Agent,
  type AgentMessage,
  type EventBus,
  MissingApiKeyError,
  MockProvider,
  OpenAICompatibleProvider,
  ProviderInitializationError,
  RecoverableCliError,
  type ToolCallPart,
  ToolRegistry,
  type ToolResultMessage,
  UnknownProviderError,
  createBuiltinTools,
  makeEvent,
} from "@elysium/core";
import { EventBus as RealEventBus } from "@elysium/core";
import { collectEnvSecretValues, gateBashCommand } from "../packages/cli/src/bash-gate";
import {
  PROVIDER_MODELS,
  PROVIDER_NAMES,
  PROVIDER_URLS,
  type ProviderConfig,
  type ProviderName,
  describeConfig,
  loadConfig,
  maskSecret,
  saveEnvValue,
} from "../packages/cli/src/config";
import { DEFAULT_REPL_BASH_POLICY, replBashPolicy } from "../packages/cli/src/config";
import { CLI_VERSION } from "../packages/cli/src/index";
import { probeServer, readMcpConfig } from "../packages/cli/src/mcp-client";
import { createMdRenderer } from "../packages/cli/src/md";
import {
  addMemoryEntry,
  clearMemory,
  loadMemory,
  memoryPromptBlock,
} from "../packages/cli/src/memory-store";
import { handleReplayCommand, handleResumeCommand } from "../packages/cli/src/repl-commands";
import { collectSkills, skillRoots, skillsPromptBlock } from "../packages/cli/src/skills";
import { type SwarmEvent, planGoal, runSwarmGoal } from "../packages/cli/src/swarm-mode";
import { type SwarmView, createSwarmView } from "../packages/cli/src/swarm-view";
import {
  HELP_CATALOG,
  bold,
  currentTheme,
  cyan,
  dim,
  green,
  helpScreen,
  kv,
  magenta,
  marks,
  neon,
  playRainIntro,
  red,
  section,
  setTheme,
  spinner,
  statusBar,
  thinkingSpinner,
  translateProviderError,
  welcomeScreen,
  white,
  yellow,
} from "../packages/cli/src/ui";
import { redactText } from "../packages/core/src/security/secret-guard";

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

/** System prompt for the current mode: base + skills index + operator memory + mode suffix. */
function systemPromptForMode(): string {
  return (
    SYSTEM_PROMPT +
    SKILLS_PROMPT_BLOCK +
    memoryPromptBlock(loadMemory(PROJECT_ROOT)) +
    MODES[currentMode].systemPromptSuffix
  );
}

// ── Session stats (for /status /history /save) ────────────────────

interface SessionStats {
  startedAt: number;
  prompts: string[];
  tokensIn: number;
  tokensOut: number;
  turns: number;
  transcript: Array<{ role: string; text: string }>;
  /** Rolling conversation history carried across prompts (bounded). */
  history: AgentMessage[];
  /** Edit volume: lines added/removed this session (write/edit tools). */
  added: number;
  removed: number;
}

/** History cap: messages kept across prompts (bounded context growth). */
const HISTORY_MAX_MESSAGES = 60;

function newSessionStats(): SessionStats {
  return {
    startedAt: Date.now(),
    prompts: [],
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    transcript: [],
    history: [],
    added: 0,
    removed: 0,
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

/**
 * Markdown-aware streaming writer: buffers deltas until a newline arrives,
 * then renders the complete line (headers, bullets, fences, bold, inline
 * code). Created fresh per turn; flushed at turn end for the trailing
 * partial line.
 */
const mdStream = (() => {
  let renderer: ReturnType<typeof createMdRenderer> | null = null;
  let buffer = "";
  const write = (delta: string): void => {
    if (renderer === null) renderer = createMdRenderer();
    buffer += delta;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      process.stdout.write(mdLine(renderer.feed(line)));
      process.stdout.write("\n");
      nl = buffer.indexOf("\n");
    }
  };
  const flush = (): void => {
    if (renderer === null) return;
    if (buffer.length > 0) {
      process.stdout.write(mdLine(renderer.flush(buffer)));
      buffer = "";
    }
  };
  const reset = (): void => {
    renderer = null;
    buffer = "";
  };
  return { write, flush, reset };
})();

/** Terminal-only answer styling: plain text outside a TTY. */
function mdLine(s: string): string {
  return process.stdout.isTTY === true ? s : s;
}

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
  // SecretGuard: exact env values collected once per process (len>=8, cap 200).
  const replEnvSecrets = collectEnvSecretValues();
  return new Agent({
    // maxTurns comes from the active effort mode; the system prompt is the
    // base prompt with the mode's suffix appended (empty for medium).
    systemPrompt: systemPromptForMode(),
    provider,
    tools: registry.list(),
    maxTurns: MODES[currentMode].maxTurns,
    executeTool: async (call, ctx): Promise<ToolResultMessage> => {
      // Bash policy gate (REPL path): every shell command passes the gate
      // before spawn — the same policy module the swarm uses. APPROVE reuses
      // the tool's existing confirm flow (operator gets the y/N prompt).
      if (call.name === "bash" && typeof call.arguments.command === "string") {
        const gate = gateBashCommand(replBashPolicy(), call.arguments.command, process.cwd());
        if (gate.action === "BLOCK") {
          return {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: `bash command blocked by policy: ${gate.reason ?? "denied"}`,
            isError: true,
          };
        }
      }
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
          // Approval gate: warn-flagged bash commands ask the operator first
          // (declined → the command never runs). The answer is typed into the
          // normal prompt: the readline handler sees pendingConfirm first.
          confirm: (command: string): Promise<boolean> => {
            process.stdout.write(
              `\n  ${yellow(marks.warn)} Comando flaggato dalla policy: ${white(command)}\n  ${yellow("Consenti? [y/N] ")}`,
            );
            return new Promise<boolean>((resolve) => {
              pendingConfirm = (answer) => {
                const allowed = answer === "y" || answer === "yes";
                if (!allowed) console.log(`  ${red(marks.err)} Annullato dall'operatore.`);
                resolve(allowed);
              };
            });
          },
        });
        // SecretGuard boundary (REPL): redact the tool result BEFORE it
        // returns to the agent loop / event bus. Raw output never leaves.
        const redactedResult: ToolResultMessage = {
          ...result,
          content: redactText(result.content ?? "", replEnvSecrets),
        };
        // Edit volume bookkeeping: for `write` re-read the produced file and
        // count real lines (the tool result content is a summary message, not
        // the file body). For `edit` count +/- lines in the diff-ish result.
        if (!result.isError && (call.name === "write" || call.name === "edit") && hooks?.stats) {
          const resultDetails = result.details as { path?: unknown } | undefined;
          const writtenPath = typeof resultDetails?.path === "string" ? resultDetails.path : null;
          if (call.name === "write" && writtenPath !== null && fs.existsSync(writtenPath)) {
            const body = fs.readFileSync(writtenPath, "utf-8");
            hooks.stats.added += body.split("\n").length;
          } else {
            const content = result.content ?? "";
            const adds = (content.match(/^\+/gm) ?? []).length;
            const dels = (content.match(/^-/gm) ?? []).length;
            if (adds + dels > 0) {
              hooks.stats.added += adds;
              hooks.stats.removed += dels;
            }
          }
        }
        // Session trail for /replay (best effort, never blocks execution).
        sessionEvents.push({
          type: "tool_call",
          name: call.name,
          tool: call.name,
          input: call.arguments,
        });
        sessionEvents.push({
          type: "tool_result",
          name: call.name,
          isError: redactedResult.isError === true,
        });
        return redactedResult;
      } catch (err: unknown) {
        sessionEvents.push({
          type: "tool_call",
          name: call.name,
          tool: call.name,
          input: call.arguments,
        });
        sessionEvents.push({ type: "tool_result", name: call.name, isError: true });
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
          // Render with think-awareness (dim inside <think>, white outside)
          // and markdown-awareness outside <think>: complete lines go through
          // the line renderer, trailing partial line waits for more deltas.
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
                mdStream.write(rest.slice(0, start));
                inThink = true;
                rest = rest.slice(start + 7);
              } else {
                mdStream.write(rest);
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
          const preview = m.content.length > 90 ? `${m.content.slice(0, 90)}…` : m.content;
          console.log(`\n  ${dim(`tool ${m.toolName} ${status}  ${preview.replace(/\n/g, " ")}`)}`);
        }
      }
    },
  });
}

// ── Edit-distance for the /model suggestion ──────────────────────

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) (dp[i] ?? [])[0] = i;
  for (let j = 0; j <= b.length; j++) (dp[0] ?? [])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = dp[i];
      const prev = dp[i - 1];
      if (row === undefined || prev === undefined) continue;
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]?.[b.length] ?? 0;
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

// ── Approval gate (warn-flagged commands) ─────────────────────────
/** Pending y/N answer the readline handler must deliver (null when none). */
let pendingConfirm: ((answer: string) => void) | null = null;

// ── Command dispatcher (transactional provider switching) ────────

interface ReplState {
  config: ProviderConfig;
  /** Live provider state: the committed config the agent is wired to. */
  committed: ProviderConfig;
}

function renderRecoverableError(title: string, action: string): void {
  console.log(`\n  ${yellow(marks.warn)} ${bold(title)}`);
  if (action) console.log(`  ${dim(`${marks.info} ${action}`)}`);
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
  if (input === "/help" || input.startsWith("/help ")) {
    const query = input.slice(5).trim();
    console.log(helpScreen(query));
    return;
  }
  if (input === "/model") {
    console.log(`\n  Current: ${describeConfig(state.config)}`);
    console.log("\n  Available providers:");
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
      console.log("\n  Effort modes (session-only, not saved to .env):");
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
    const prov = parts[0] ?? "";
    const key = parts[1] ?? "";
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
  if (input.startsWith("/plan ")) {
    if (!xo) return;
    const goal = input.slice(6).trim();
    if (goal.length === 0) {
      throw new RecoverableCliError(
        "Missing goal",
        "Usage: /plan <goal> — shows the subtask plan without executing",
      );
    }
    const committed = xo.committed();
    if (!CREDENTIAL_LESS.has(committed.provider) && !committed.apiKey) {
      throw new MissingApiKeyError(committed.provider);
    }
    const sp = spinner();
    sp.start("plan: decomposing…");
    const providerCfg = {
      baseUrl: committed.baseUrl,
      apiKey: committed.apiKey || "ollama",
      model: committed.model,
    };
    try {
      const plan = await planGoal({
        goal,
        provider: providerCfg,
        maxSubtasks: MODES[currentMode].maxSubtasks,
      });
      sp.stop("plan ready");
      console.log(section("plan"));
      console.log(
        `  ${dim(`source: ${plan.source} · ${plan.subtasks.length} subtask — esegui con /swarm <goal>`)}`,
      );
      for (const t of plan.subtasks) {
        console.log(`  ${neon(t.id.padEnd(8))} ${t.goal}`);
        for (const c of t.acceptanceCriteria) console.log(`        ${dim(`- ${c}`)}`);
      }
      console.log();
    } catch (err: unknown) {
      sp.stop(undefined, "plan failed");
      throw err;
    }
    return;
  }
  if (input === "/resume" || input.startsWith("/resume ")) {
    const arg = input.slice(7).trim() || undefined;
    const res = handleResumeCommand(process.cwd(), arg);
    console.log(section("resume"));
    for (const line of res.message.split("\n")) console.log(`  ${line}`);
    console.log();
    return;
  }
  if (input === "/replay" || input.startsWith("/replay ")) {
    const argJson = input.slice(7).trim() || undefined;
    const events = xo ? (xo.events as unknown[]) : [];
    if (events.length === 0 && argJson === undefined) {
      console.log(section("replay"));
      console.log(dim("  no recorded events in this session to replay"));
      console.log();
      return;
    }
    const res = handleReplayCommand(events, argJson);
    console.log(section("replay"));
    for (const line of res.message.split("\n")) console.log(`  ${line}`);
    console.log();
    return;
  }
  if (input === "/cost") {
    if (!xo) return;
    const st = xo.stats;
    console.log(section("cost"));
    console.log(`  ${kv("tokens in", String(st.tokensIn))}`);
    console.log(`  ${kv("tokens out", String(st.tokensOut))}`);
    console.log(`  ${kv("total", String(st.tokensIn + st.tokensOut))}`);
    console.log(`  ${kv("turns", String(st.turns))}`);
    console.log(`  ${dim("token counts only — pricing depends on the active provider plan")}`);
    console.log();
    return;
  }
  if (input === "/export" || input.startsWith("/export ")) {
    if (!xo) return;
    const fmt = input.slice(7).trim() === "json" ? "json" : "md";
    const file = path.join(
      WORKSPACE,
      `session-${new Date().toISOString().replace(/[:.]/g, "-")}.${fmt}`,
    );
    if (fmt === "json") {
      const payload = {
        date: new Date().toISOString(),
        provider: xo.committed().provider,
        model: xo.committed().model,
        turns: xo.stats.turns,
        tokens: { in: xo.stats.tokensIn, out: xo.stats.tokensOut },
        transcript: xo.stats.transcript,
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
    } else {
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
    }
    console.log(`\n  ${marks.ok} Session exported: ${file}\n`);
    return;
  }
  if (input === "/memory" || input.startsWith("/memory ")) {
    const arg = input.slice(7).trim();
    if (arg === "clear") {
      clearMemory(PROJECT_ROOT);
      console.log(`\n  ${marks.ok} Operator memory cleared.\n`);
      return;
    }
    if (arg.length === 0) {
      const entries = loadMemory(PROJECT_ROOT);
      console.log(section("memory"));
      if (entries.length === 0) {
        console.log(`  ${dim("vuota — aggiungi con /memory <nota>")}`);
      } else {
        for (const e of entries) console.log(`  ${dim("-")} ${e}`);
      }
      console.log(
        `\n  ${dim("iniettata nel system prompt · /memory <nota> aggiunge · /memory clear svuota")}\n`,
      );
      return;
    }
    const entries = addMemoryEntry(PROJECT_ROOT, arg);
    console.log(
      `\n  ${marks.ok} Nota salvata (${entries.length}/50). Sarà nel system prompt dai prossimi turni.\n`,
    );
    return;
  }
  if (input === "/mcp") {
    const servers = readMcpConfig(PROJECT_ROOT);
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log("\n  No MCP servers configured. Add a .mcp.json in the project root:");
      console.log(
        `  ${dim(`{ "mcpServers": { "nome": { "command": "npx", "args": ["-y", "pkg"] } } }`)}\n`,
      );
      return;
    }
    const sp = spinner();
    sp.start(`mcp: probing ${names.length} server…`);
    const results = await Promise.all(
      names.map((n) => probeServer(n, servers[n] ?? { command: "" })),
    );
    sp.stop("mcp probe done");
    console.log(section("mcp"));
    for (const r of results) {
      const icon = r.ok ? green(marks.ok) : red(marks.err);
      const detail = r.ok
        ? `${r.tools.length} tools${r.tools.length > 0 ? `: ${r.tools.slice(0, 5).join(", ")}` : ""}`
        : (r.error ?? "failed");
      console.log(`  ${icon} ${r.name.padEnd(14)} ${dim(detail)}`);
    }
    console.log();
    return;
  }
  if (input === "/review" || input.startsWith("/review ")) {
    if (!xo) return;
    const target = input.slice(7).trim();
    const committed = xo.committed();
    if (!CREDENTIAL_LESS.has(committed.provider) && !committed.apiKey) {
      throw new MissingApiKeyError(committed.provider);
    }
    const scope =
      target.length > 0
        ? `Limitati ai file sotto ${target}.`
        : "Analizza il diff completo (staged + unstaged).";
    const reviewPrompt = [
      "Esegui una CODE REVIEW del repository corrente.",
      scope,
      "Passi: 1) raccogli il diff con bash (git diff HEAD + git diff --cached), 2) leggi i file toccati se serve contesto,",
      "3) segnala: bug, rischi di sicurezza, violazioni delle convenzioni del repo, opportunità di semplificazione.",
      "Formato: elenco puntato con file:line per ogni punto, gravità (high/med/low), suggerimento concreto.",
      "Se il diff è vuoto, dillo e fermati. Niente modifiche ai file: solo analisi.",
    ].join(" ");
    const seam = (
      globalThis as { __elysiumRunSeam?: { start(a: { abort(): void }): void; end(): void } }
    ).__elysiumRunSeam;
    const sp = thinkingSpinner();
    activeSpinner = sp;
    sp.start("");
    liveStreamed = false;
    inThink = false;
    xo.stats.prompts.push(input);
    seam?.start(xo.getAgent());
    let result: Awaited<ReturnType<Agent["run"]>>;
    try {
      result = await xo.getAgent().run(reviewPrompt);
    } finally {
      seam?.end();
      activeSpinner?.stop();
      activeSpinner = null;
    }
    if (liveStreamed) {
      process.stdout.write("\n");
    } else {
      for (const m of result.messages) {
        if (m.role === "assistant" && m.text) console.log(`\n${m.text}`);
      }
    }
    xo.stats.tokensIn += result.usage.inputTokens;
    xo.stats.tokensOut += result.usage.outputTokens;
    xo.stats.turns += result.turns;
    xo.stats.transcript.push({ role: "user", text: input });
    console.log(
      `  ${dim(`─ review done · ${result.usage.inputTokens + result.usage.outputTokens} tok · ${result.turns} turns`)}`,
    );
    return;
  }
  let currentThemeMode = currentTheme();
  if (input === "/theme" || input.startsWith("/theme ")) {
    const arg = input.slice(6).trim();
    if (arg === "mono" || arg === "matrix") {
      setTheme(arg);
      currentThemeMode = arg;
      console.log(`\n  ${marks.ok} Theme: ${arg}${arg === "mono" ? " (brand accents off)" : ""}\n`);
      return;
    }
    console.log(
      `\n  Theme: ${currentThemeMode}  ${dim("· switch with /theme matrix | /theme mono")}\n`,
    );
    return;
  }
  if (input === "/agents") {
    if (!xo) return;
    const st = xo.stats;
    console.log(section("agents"));
    console.log(`  ${kv("session turns", String(st.turns))}`);
    console.log(
      `  ${kv("history", `${st.history.length} messages (cap ${HISTORY_MAX_MESSAGES})`)}`,
    );
    console.log(
      `  ${dim("live subagent panes: visible during /swarm runs — run /swarm <goal> and the view streams each builder")}`,
    );
    console.log();
    return;
  }
  if (input === "/connections") {
    console.log("\n  Providers (configured in .env or via /key):");
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
        "\n  No skills indexed. Add a directory with a SKILL.md (frontmatter: name, description) under one of:",
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
    console.log("\n  Available tools:");
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
      const shown = oneLine.length > 70 ? `${oneLine.slice(0, 70)}…` : oneLine;
      console.log(`  ${dim(String(i + 1).padStart(2))}. ${shown}`);
    });
    console.log();
    return;
  }
  if (input === "/clear-chat") {
    if (!xo) return;
    xo.setAgent(wireAgentFor(xo.committed(), registry));
    xo.stats.transcript.length = 0;
    xo.stats.history.length = 0;
    xo.stats.turns = 0;
    xo.stats.tokensIn = 0;
    xo.stats.tokensOut = 0;
    console.log(
      `\n  ${marks.ok} Conversation reset (fresh agent, history cleared, stats zeroed).\n`,
    );
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
        runsRoot: process.cwd(),
        gitCheckpoints: true,
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
              tokens?: { inputTokens: number; outputTokens: number };
            };
            view?.taskEnded(
              d.taskId ?? "",
              d.status ?? "fail",
              d.durationMs ?? 0,
              d.attempts ?? 1,
              d.tokens,
            );
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
      console.log(`\n  ${dim(`workspace: ${report.workspacePath}`)}\n`);
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
    console.log(`  ${dim(`${marks.info} /help lists available commands`)}\n`);
    return;
  }
}

// ── REPL loop with command error boundary + Ctrl+C seam ──────────

async function runRepl(startConfig: ProviderConfig): Promise<void> {
  const registry = createToolRegistry();
  const stats = newSessionStats();
  // Session event trail (for /replay): agent + tool events captured in order.
  const sessionEvents: unknown[] = [];
  const state: ReplState = { config: startConfig, committed: startConfig };
  let agent = wireAgentFor(state.committed, registry, { stats });

  // Matrix moment: falling 0/1 columns (TTY only, ~1.1s, ELYSIUM_RAIN_MS=0
  // to skip) — then the wordmark + welcome box print below it.
  await playRainIntro();
  console.log(
    welcomeScreen({
      version: CLI_VERSION,
      provider: PROVIDER_NAMES[state.committed.provider] ?? state.committed.provider,
      model: state.committed.model,
      session: `s-${Date.now().toString(36)}`,
      mode: MODES[currentMode].label,
      workspace: WORKSPACE,
      tools: [...registry.list().map((t) => t.name)],
      skills: SKILLS.map((s) => s.name),
    }),
  );
  console.log(
    `  ${dim(`mode ${MODES[currentMode].label} · workspace ${WORKSPACE} · cwd ${process.cwd()}`)}`,
  );
  console.log(`  ${dim("Type /help for commands. Ctrl+C aborts a run; twice to quit.\n")}`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${neon("❯")} `,
    historySize: 100,
    // Tab completion over the command catalog: prefixes match, empty prefix
    // offers the full list (readline shows it above the prompt).
    completer: (lineInput: string): [string[], string] => {
      const names = HELP_CATALOG.map((e) => e.name);
      const hits = names.filter((n) => n.startsWith(lineInput));
      return [hits.length > 0 ? hits : names, lineInput];
    },
  });
  rl.prompt();

  // Serialize line handling: piped readline fires faster than async
  // handlers settle, so /quit could otherwise exit before earlier
  // commands finish (this caused the original "silent no-op" symptom).
  let lineQueue: Promise<void> = Promise.resolve();
  let working = false; // a run is in flight
  let warnedThisRun = false;
  rl.on("line", (raw: string) => {
    // Approval gate answer has priority: it is delivered to the pending
    // confirm resolver instead of being queued as a prompt.
    if (pendingConfirm !== null) {
      const resolve = pendingConfirm;
      pendingConfirm = null;
      resolve(raw.trim());
      return;
    }
    if (working) {
      // The agent is generating. Non-command input STEERS the in-flight run
      // (the core Agent injects it between turns — the human redirect loop
      // from "Terminal Is All You Need"); slash commands still queue so
      // /quit is never lost. Esc cancels the run entirely.
      const t = raw.trim();
      if (t === "/quit") {
        console.log(`\n  ${dim("/quit queued — will run after the current turn.")}\n`);
      } else if (t.startsWith("/") && t.length > 1) {
        if (!warnedThisRun) {
          warnedThisRun = true;
          console.log(
            `\n  ${yellow(marks.warn)} Command queued — it runs after the current turn.\n`,
          );
        }
      } else if (t.length > 0) {
        inFlight?.steer(t);
        console.log(`  ${cyan("↳")} ${dim("steer inviato all'agente in esecuzione")}`);
        rl.prompt();
        return;
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
            committed: () => state.committed,
            events: sessionEvents,
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
          committed: () => state.committed,
          events: sessionEvents,
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
  /** Live provider config (read-only accessor for commands and the statusbar). */
  committed: () => ProviderConfig;
  /** Session event trail for /replay (tool_call/tool_result pairs, etc.). */
  events: unknown[];
}

async function handleReplLine(input: string, xo: ReplContext): Promise<void> {
  const line = input.trim();
  if (!line) return;
  if (line === "/quit" || line === "/exit") {
    console.log(`\n  ${dim("session ended.")}\n`);
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
    mdStream.reset();
    let result: Awaited<ReturnType<Agent["run"]>>;
    try {
      result = await agent.run(line, { history: xo.stats.history });
    } finally {
      seam?.end();
      xo.setWorking(false);
      activeSpinner?.stop();
      activeSpinner = null;
    }
    // Carry the conversation forward (bounded): what the model saw and
    // produced this turn feeds the next prompt's context.
    xo.stats.history = [...result.messages, ...xo.stats.history].slice(0, HISTORY_MAX_MESSAGES);
    const dt = Date.now() - t0;
    if (liveStreamed) {
      // Deltas were already printed live; flush the trailing partial line
      // through the markdown renderer, then close the block.
      mdStream.flush();
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
          const preview = m.content.length > 120 ? `${m.content.slice(0, 120)}…` : m.content;
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
    const strip = statusBar({
      model: xo.committed().model,
      mode: currentMode,
      tokens: xo.stats.tokensIn + xo.stats.tokensOut,
      turns: xo.stats.turns,
      historyMsgs: xo.stats.history.length,
      historyCap: HISTORY_MAX_MESSAGES,
      added: xo.stats.added,
      removed: xo.stats.removed,
    });
    if (strip.length > 0) {
      console.log(strip);
    } else {
      console.log(
        `  ${dim(`─ ${totalTokens} tok · ${tps} tok/s · ${(dt / 1000).toFixed(1)}s${result.stopReason === "aborted" ? " · aborted" : ""}`)}`,
      );
    }
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
          `Limite turni raggiunto (mode: ${currentMode})`,
          "Alza con /mode high|max o spezza il task",
        );
        return;
      }
      emitCliError("agent_run_error", msg);
      // Friendly translation for provider/network failures.
      const t = translateProviderError(err);
      console.error(`\n  ${red(marks.err)} ${yellow(t.title)}`);
      console.error(`  ${dim(`→ ${t.hint}`)}`);
      console.error(`  ${dim(`detail: ${t.detail}`)}\n`);
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
    if (argv[i] !== undefined && !argv[i]?.startsWith("-")) taskArg = argv[i] ?? "";
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
