/**
 * Provider configuration — reads from env vars or .env file.
 * No external dependencies.
 */
import fs from "node:fs";
import path from "node:path";

export type ProviderName =
  | "openai"
  | "deepseek"
  | "groq"
  | "together"
  | "openrouter"
  | "ollama"
  | "glm"
  | "opencode"
  | "mock";

export interface ProviderConfig {
  provider: ProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  opencode: "http://127.0.0.1:11434/v1",
};

export const PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  together: "meta-llama/Llama-3-70b-chat-hf",
  openrouter: "anthropic/claude-sonnet-4",
  ollama: "gemma4:31b-cloud",
  glm: "glm-5.3-flash",
  opencode: "deepseek-v4-flash:cloud",
  mock: "mock",
};

export const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  groq: "Groq",
  together: "Together AI",
  openrouter: "OpenRouter",
  ollama: "Ollama (locale)",
  glm: "ZhiPu GLM",
  opencode: "OpenCode Go",
  mock: "Mock (offline)",
};

/** Strip one pair of matching surrounding quotes ("…" or '…') if present. */
function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Load .env file (simple KEY=VALUE parser). */
function loadEnvFile(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env");
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    result[trimmed.slice(0, eq).trim()] = stripQuotes(trimmed.slice(eq + 1).trim());
  }
  return result;
}

/** Load config from env vars, falling back to .env file. */
export function loadConfig(projectRoot?: string): ProviderConfig {
  const root = projectRoot ?? process.cwd();
  const fileEnv = loadEnvFile(root);
  const get = (key: string): string => process.env[key] ?? fileEnv[key] ?? "";

  const provider = (get("ELYSIUM_PROVIDER") || "mock").toLowerCase();
  const apiKey = get("ELYSIUM_API_KEY");
  const model = get("ELYSIUM_MODEL") || PROVIDER_MODELS[provider] || "gpt-4o-mini";
  const baseUrl = get("ELYSIUM_BASE_URL") || PROVIDER_URLS[provider] || "";

  return { provider: provider as ProviderName, baseUrl, apiKey, model };
}

/**
 * Default bash policy for the interactive REPL. Conservative deny-list
 * (destructive/escalation builtins from bash-policy) while leaving the
 * single-user operator full network access and the whole cwd writable —
 * the REPL runs attended, unlike swarm workers (network denied there).
 * Opt-out: ELYSIUM_BASH_POLICY=off disables the gate entirely.
 */
export const DEFAULT_REPL_BASH_POLICY = {
  denied: ["rm -rf", "git reset --hard", "git push", "sudo", "powershell -enc"],
  writableRoots: [process.cwd()],
  networkAllowed: true,
} as const;

/** Resolve the active REPL bash policy from the environment. */
export function replBashPolicy(): typeof DEFAULT_REPL_BASH_POLICY | undefined {
  if ((process.env.ELYSIUM_BASH_POLICY ?? "").toLowerCase() === "off") {
    return undefined;
  }
  return DEFAULT_REPL_BASH_POLICY;
}

/** Decision Layer mode (off | shadow | enforce). Default: shadow when a
 * TYPESAFE_API_KEY is present, else off — NEVER enforce automatically. */
export function decisionMode(): "off" | "shadow" | "enforce" {
  const raw = (process.env.ELYSIUM_DECISION_MODE ?? "").toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "off") return "off";
  if (raw === "shadow") return "shadow";
  return process.env.TYPESAFE_API_KEY ? "shadow" : "off";
}

/** Save a single key=value to the .env file. */
export function saveEnvValue(projectRoot: string, key: string, value: string): void {
  const envPath = path.join(projectRoot, ".env");
  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, "utf-8").split("\n");
  }
  // Quote values that contain whitespace or special chars; the paired double
  // quotes are stripped again by the loadEnvFile parser (stripQuotes).
  const stored = /[\s#"']/.test(value) ? JSON.stringify(value) : value;
  const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = `${key}=${stored}`;
  } else {
    lines.push(`${key}=${stored}`);
  }
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
}

/**
 * Mask a secret for display: first 3 + ellipsis + last 3 chars.
 * Shorter secrets render as "***" (nothing worth revealing).
 */
export function maskSecret(key: string): string {
  return key.length >= 16 ? `${key.slice(0, 3)}…${key.slice(-3)}` : "***";
}

/** Return a human-readable description of the current config. */
export function describeConfig(config: ProviderConfig): string {
  if (config.provider === "mock") return "MockProvider (deterministic, offline)";
  const name = PROVIDER_NAMES[config.provider] ?? config.provider;
  const masked = config.apiKey ? maskSecret(config.apiKey) : "(no key)";
  return `${name} | ${config.model} | key: ${masked}`;
}
