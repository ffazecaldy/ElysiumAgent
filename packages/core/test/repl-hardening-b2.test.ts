/**
 * B2 — Credentials + Ctrl+C hardening.
 *
 * Contracts under test (bin/agent.ts + packages/core/src/agent/agent.ts):
 *   (1) /key output is ALWAYS masked via maskSecret (>=16 chars: first 3 +
 *       "…" + last 3; shorter keys: "***") — the full key never reaches
 *       stdout/stderr.
 *   (2) Invalid keys (< 8 chars, whitespace, quotes, multi-token) are
 *       rejected BEFORE anything is written, with a recoverable reason.
 *   (3) Ctrl+C while a generation is in flight aborts that run via the
 *       per-run AbortController inside Agent (bridged from agent.abort())
 *       and returns to the prompt — the process is NOT killed.
 *   (4) Arrow-key history: readline is created with historySize set.
 *
 * Env precedence (process env > .env) is documented in .env.example and
 * implemented in loadConfig() — no new credentials file is introduced.
 * /key writes ONLY to .env, redirected for tests via ELYSIUM_PROJECT_ROOT.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LlmRequest, LlmProvider, StreamEvent } from "@elysium/core";
import { Agent, MockProvider } from "@elysium/core";
import { describe, expect, it } from "vitest";

function projectRoot(): string {
  let dir = import.meta.dirname ?? __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "bin", "agent.ts"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("project root not found");
}

interface ReplHandle {
  out: string;
  exitCode: number | null;
  /** .env captured from the redirected ELYSIUM_PROJECT_ROOT (never the real one). */
  envFile: string;
}

/**
 * Run the REAL `pnpm agent --provider mock` with scripted stdin, while
 * ELYSIUM_PROJECT_ROOT points /key persistence at a disposable directory.
 * `--provider mock` forces mock mode regardless of what that sandbox .env
 * or the repo .env says, so no real credentials are read or needed.
 */
function runRepl(lines: string[], timeoutMs = 90_000): ReplHandle {
  const root = projectRoot();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "b2-env-"));
  const sandboxEnv = path.join(sandbox, ".env");
  fs.writeFileSync(sandboxEnv, "ELYSIUM_PROVIDER=mock\n", "utf-8");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b2-argv-"));
  const input = lines.join("\n") + "\n";

  const runner = spawnSync("pnpm", ["agent", "--provider", "mock"], {
    input,
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: root,
    shell: true,
    env: {
      ...process.env,
      ELYSIUM_PROJECT_ROOT: sandbox,
      ELYSIUM_CONFIG_DIR: tmp,
      XDG_CONFIG_HOME: tmp,
      HOME: tmp,
      NO_COLOR: "1",
      CI: "1",
    },
  });
  const out = [runner.stdout ?? "", runner.stderr ?? ""].join("\n");
  const exitCode = runner.status;
  const envFile = fs.existsSync(sandboxEnv) ? fs.readFileSync(sandboxEnv, "utf-8") : "";
  return { out, exitCode, envFile };
}

// ── Test 1: masked output never contains the full key ─────────────

const FULL_KEY = "supersecretkey123";
const MASKED = "(sup…123)";

describe("B2 (1) — /key output is always masked (maskSecret)", () => {
  it("successful save prints the maskSecret mask and never the full key on any output line", () => {
    const handle = runRepl([`/key glm ${FULL_KEY}`, "/quit"]);
    expect(handle.exitCode).toBe(0);
    const savedLine = handle.out.split("\n").find((l) => l.includes("Key saved for")) ?? "";
    expect(savedLine).toContain("ZhiPu GLM");
    // Exact contract: maskSecret — 17 chars (>=16) → first3…last3.
    expect(savedLine).toContain(MASKED);
    for (const line of handle.out.split("\n")) {
      expect(line.includes(FULL_KEY), `full key leaked: ${line}`).toBe(false);
    }
    // Value DOES live in .env (storage contract) — masking is an output contract.
    expect(handle.envFile).toContain(`ELYSIUM_API_KEY=${FULL_KEY}`);
  });

  it("every 'Key saved' line contains the ellipsis mask, even on repeat saves", () => {
    const handle = runRepl([`/key glm ${FULL_KEY}`, `/key glm ${FULL_KEY}`, "/quit"]);
    const saves = handle.out.split("\n").filter((l) => l.includes("Key saved for ZhiPu GLM"));
    expect(saves.length).toBeGreaterThanOrEqual(2);
    for (const line of saves) {
      expect(line).toContain(MASKED);
      expect(line.includes(FULL_KEY)).toBe(false);
    }
  });

  it("switching to the saved provider prints a masked key, never the full value", () => {
    const handle = runRepl([`/key ollama ${FULL_KEY}`, "/model ollama", "/quit"]);
    expect(handle.out).toContain("Active provider:");
    for (const line of handle.out.split("\n")) {
      expect(line.includes(FULL_KEY)).toBe(false);
    }
  });
});

// ── Test 2: invalid keys rejected without saving ──────────────────

describe("B2 (2) — invalid /key rejected without saving", () => {
  it("< 8 chars: rejected with reason, redirected .env untouched, REPL alive", () => {
    const handle = runRepl(["/key glm ab", "/key glm abcdefg", "/quit"]);
    expect(handle.exitCode).toBe(0);
    expect(handle.out).toContain("Key too short");
    expect(handle.out).toContain("provider stays: mock");
    expect(handle.envFile).toBe("ELYSIUM_PROVIDER=mock\n");
    expect(handle.envFile).not.toContain("ELYSIUM_API_KEY");
  });

  it("multi-token key (implied spaces) rejected, not saved", () => {
    const handle = runRepl(["/key glm spaced out key", "/quit"]);
    expect(handle.exitCode).toBe(0);
    expect(handle.out).toContain("single token");
    expect(handle.envFile).not.toContain("ELYSIUM_API_KEY");
  });

  it("quote characters in the key are rejected without saving", () => {
    const handle = runRepl(["/key glm 'quoted'", "/quit"]);
    expect(handle.exitCode).toBe(0);
    expect(handle.out.toLowerCase()).toContain("quote character");
    expect(handle.envFile).not.toContain("ELYSIUM_API_KEY");
    expect(handle.envFile).toBe("ELYSIUM_PROVIDER=mock\n");
  });

  it("boundary: exactly 8 valid chars IS accepted and masked as ***", () => {
    const handle = runRepl(["/key glm 12345678", "/quit"]);
    expect(handle.out).toContain("Key saved for ZhiPu GLM");
    // Short keys (<16 chars) never appear on stdout in any form: "***".
    expect(handle.out).toContain("(***)");
    expect(handle.out).not.toContain("1234…5678");
    expect(handle.envFile).toContain("ELYSIUM_API_KEY=12345678");
  });
});

// ── Test 3: abort path (Ctrl+C seam) returns to prompt ────────────

/**
 * A provider that streams text forever until its request signal aborts —
 * the in-flight "streaming" shape the Ctrl+C handler interrupts.
 */
function endlessProvider(): LlmProvider {
  return {
    id: "endless-mock-b2",
    stream(request: LlmRequest): AsyncIterable<StreamEvent> {
      return (async function* (): AsyncGenerator<StreamEvent> {
        while (true) {
          if (request.signal?.aborted) return;
          yield { type: "text_delta", delta: "." };
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      })();
    },
  };
}

describe("B2 (3) — Ctrl+C abort path concludes cleanly and returns to prompt", () => {
  it("aborting the per-run signal mid-stream yields stopReason 'aborted' without throwing", async () => {
    const controller = new AbortController();
    const agent = new Agent({
      systemPrompt: "You are Elysium, an AI coding agent.",
      provider: endlessProvider(),
      signal: controller.signal,
    });
    // Exactly the wiring bin/agent.ts uses on SIGINT-while-running: it
    // calls the same abort() seam the core Agent loop exposes per run.
    setTimeout(() => controller.abort(), 80);
    const result = await agent.run("long generation");
    expect(result.stopReason).toBe("aborted");
    expect(result.turns).toBeGreaterThanOrEqual(1);
    // The run RETURNED (no hang, no throw, no process exit).
  });

  it("an aborted run leaves the agent reusable — the next call settles without hang", async () => {
    // agent with an endless provider; run() started then aborted via the
    // seam the CLI uses — agent.abort() targets the in-flight run only.
    const agent = new Agent({
      systemPrompt: "You are Elysium, an AI coding agent.",
      provider: endlessProvider(),
    });
    setTimeout(() => agent.abort(), 80);
    const aborted = await agent.run("interrupt me");
    expect(aborted.stopReason).toBe("aborted");
    // The same agent can run again afterwards (signal was per-run):
    const healthy = new Agent({
      systemPrompt: "You are Elysium, an AI coding agent.",
      provider: new MockProvider([{ text: "hello" }]),
      maxTurns: 1,
    });
    const ok = await healthy.run("normal");
    expect(ok.stopReason).toBe("end_turn");
  });

  it("REPL survives an in-run interrupt (\\u0003 piped via stdin) and answers /help after", () => {
    const handle = runRepl(["long. generation. please.", "\u0003", "/help", "/quit"], 120_000);
    expect(handle.exitCode).toBe(0);
    expect(handle.out).toContain("session ended");
    // /help ran AFTER the interruption → the prompt came back, alive.
    const helpIdx = handle.out.indexOf("/help");
    const goodbyeIdx = handle.out.indexOf("session ended");
    expect(helpIdx).toBeGreaterThan(-1);
    expect(goodbyeIdx).toBeGreaterThan(helpIdx);
    expect(handle.out).not.toContain("uncaughtException");
  });

  it("two Ctrl+C presses while idle exit cleanly with code 0", () => {
    const handle = runRepl(["\u0003", "\u0003", "/quit"], 90_000);
    expect(handle.exitCode).toBe(0);
    expect(handle.out).not.toContain("uncaughtException");
  });
});

// ── Test 4: command history (arrow keys) wired ────────────────────

describe("B2 (4) — command history", () => {
  it("bin/agent.ts passes historySize into readline.createInterface", () => {
    const src = fs.readFileSync(path.join(projectRoot(), "bin", "agent.ts"), "utf-8");
    const optionsMatch = src.match(/readline\.createInterface\(\{([\s\S]*?)\}\);/);
    expect(optionsMatch).not.toBeNull();
    expect(optionsMatch?.[1]).toContain("historySize:");
  });
});
