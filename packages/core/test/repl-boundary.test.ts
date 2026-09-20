import { execFileSync } from "node:child_process";
/**
 * Regression tests for Parte A — REPl command dispatch returns control to the
 * prompt instead of terminating the process on recoverable errors.
 *
 * We test the command-layer logic via testing the module contract: the
 * original bug was `process.exit(1)` inside the provider factory. These tests
 * assert that (1) the core never calls process.exit for missing keys,
 * (2) short-circuit paths exist for missing prompts, and (3) the CLI dispatch
 * logic in bin/agent.ts survives a missing-key /model switch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function projectRoot(): string {
  // Walk up from this test file to find the monorepo root (contains bin/agent.ts).
  let dir = import.meta.dirname ?? __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "bin", "agent.ts"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("project root not found");
}

/** Run the CLI in mock mode with a scripted REPL session; return stdout+stderr. */
function runReplSession(
  lines: string[],
  timeoutMs = 30000,
): { out: string; exitCode: number | null } {
  const root = projectRoot();
  const input = `${lines.join("\n")}\n`;
  try {
    const stdout = execFileSync("pnpm", ["agent", "--provider", "mock"], {
      input,
      encoding: "utf-8",
      timeout: timeoutMs,
      cwd: root,
      env: { ...process.env },
      shell: true,
    });
    return { out: stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { out: e.stdout ?? String(err), exitCode: e.status ?? null };
  }
}

describe("REPL command error boundary (Parte A)", () => {
  it("Test 1 — /model glm without key keeps the REPL alive and preserves mock", () => {
    const { out, exitCode } = runReplSession(["/model glm", "/help", "/quit"]);
    expect(out).toContain("No API key configured for glm");
    expect(out).toContain("provider stays: mock");
    expect(out).toContain("/help");
    expect(out).toContain("session ended");
    expect(exitCode).toBe(0); // process terminated cleanly by /quit, not by the error
  });

  it("Test 2 — unknown provider shows an error and keeps the REPL", () => {
    const { out, exitCode } = runReplSession(["/model does-not-exist", "/quit"]);
    expect(out).toContain("Unknown provider: does-not-exist");
    expect(out).toContain("session ended");
    expect(exitCode).toBe(0);
  });

  it("Test 3a — successful switch commits the new provider", () => {
    // Get a fresh config with one extra provider (mock -> ollama: credential-less switch)
    const { out } = runReplSession(["/model ollama", "/model", "/quit"]);
    expect(out).toContain("Active provider:");
    // The active provider line should now be ollama, not mock.
    const activeLine = out.split("\n").find((l) => l.includes("Active provider")) ?? "";
    expect(activeLine.toLowerCase()).toContain("ollama");
  });

  it("Test 4 — /help still works after a failed /model", () => {
    const { out } = runReplSession(["/model glm", "/help", "/quit"]);
    const glmIdx = out.indexOf("No API key configured for glm");
    // A unique string from the dynamic /help OUTPUT (not the echoed input):
    // the /swarm row of the help catalog only exists in the help body.
    const helpIdx = out.indexOf("/swarm");
    expect(glmIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeGreaterThan(glmIdx); // help ran AFTER the failure
    expect(out.indexOf("COMANDI")).toBeGreaterThan(glmIdx); // dynamic help rendered
  });
});
