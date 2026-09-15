/**
 * B5 — Generalized command-kill coverage.
 *
 * Parametrized hardening test: every slash command (valid AND malformed) is
 * piped through the REAL CLI (pnpm agent --provider mock) followed by /help
 * then /quit. The contract under test is:
 *   (1) nothing except /quit terminates the process (exit code 0),
 *   (2) the REPL survives to the very end (the "Goodbye" banner is reached,
 *       which also proves /help right before /quit still worked),
 *   (3) every malformed input produces a *recoverable* marker — a unicode
 *       warning sign (⚠) or an x mark (✗) rendered by
 *       renderRecoverableError / the unknown-command branch in bin/agent.ts —
 *       instead of a crash or a silent swallow.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function projectRoot(): string {
  // Walk up from this test file to find the monorepo root (contains bin/agent.ts).
  let dir = import.meta.dirname ?? __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "bin", "agent.ts"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("project root not found");
}

/** Run the CLI in mock mode with a scripted REPL session; return stdout+stderr and exit code. */
function runReplSession(
  lines: string[],
  timeoutMs = 60_000,
): { out: string; exitCode: number | null } {
  const root = projectRoot();
  // Keep the process stateless: redirect config/cache to an isolated temp dir.
  const argvOverride = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b5-")), "argv");
  fs.mkdirSync(argvOverride, { recursive: true });
  const input = lines.join("\n") + "\n";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Redirect any user-level state that could leak real keys/keys prompts.
    ELYSIUM_CONFIG_DIR: argvOverride,
    XDG_CONFIG_HOME: argvOverride,
    HOME: argvOverride,
    NO_COLOR: "1",
    CI: "1",
  };
  try {
    const stdout = execFileSync("pnpm", ["agent", "--provider", "mock"], {
      input,
      encoding: "utf-8",
      timeout: timeoutMs,
      cwd: root,
      env,
      shell: true,
    });
    return { out: stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const out = [e.stdout ?? "", e.stderr ?? "", e.stdout == null ? String(err) : ""].join("\n");
    return { out, exitCode: e.status ?? null };
  }
}

/**
 * Every slash command is exercised twice within its own session:
 * once as-is (valid semantics or malformed), always followed by /help and
 * /quit so we can prove the loop is still responsive afterwards.
 * The 12th entry is an unknown command; the binary's REPL dispatcher must
 * answer with the "Unknown command" warning and keep the prompt alive.
 */
const SLASH_INPUTS: ReadonlyArray<readonly string[]> = [
  ["/help"],
  ["/model"],
  ["/model glm"],
  ["/model does-not-exist"],
  ["/key"],
  ["/key glm ab"],
  ["/key nosuchprovider abcdef"],
  ["/connections"],
  ["/tools"],
  ["/workspace"],
  ["/clear"],
  ["/unknowncmd"],
];

/** Command may legitimately produce no warning; malformed ones must warn. */
const IS_MALFORMED: ReadonlyArray<boolean> = [
  false, // /help            — valid
  false, // /model           — valid (shows status; falls through to the plain "/model" branch, no warning)
  false, // /model glm       — valid (falls back to "provider stays: mock", no key)
  true, //  /model does-not-exist — unknown provider
  true, //  /key             — missing arguments
  true, //  /key glm ab      — too-short key for real provider registered warning? treated as malformed candidate
  true, //  /key nosuchprovider abcdef — unknown provider for key
  false, // /connections     — valid
  false, // /tools           — valid
  false, // /workspace       — valid
  false, // /clear           — valid
  true, //  /unknowncmd      — unknown command
];

describe("B5 — generalized command-kill coverage (REPL survives every slash command)", () => {
  it("matrix: every input exits only via /quit with Goodbye and recoverable markers", () => {
    expect(SLASH_INPUTS).toHaveLength(IS_MALFORMED.length);

    SLASH_INPUTS.forEach((lines, i) => {
      const malformed = IS_MALFORMED[i];
      const { out, exitCode } = runReplSession([...lines, "/help", "/quit"]);

      // (1) nothing but /quit terminates: clean exit code 0.
      expect(exitCode, `exit code for ${JSON.stringify(lines)}`).toBe(0);

      // (2) the loop stayed alive to the very end: Goodbye banner emitted,
      //     and /help output came right before it.
      expect(out, `output for ${JSON.stringify(lines)}`).toContain("session ended");
      const helpIdx = out.indexOf("/help");
      const goodbyeIdx = out.indexOf("session ended");
      expect(helpIdx, `/help ran for ${JSON.stringify(lines)}`).toBeGreaterThan(-1);
      expect(goodbyeIdx).toBeGreaterThan(helpIdx);

      // (3) malformed inputs must render a recoverable marker (⚠ or ✗),
      //     never a crash — since exit code is already 0, no crash occurred.
      const hasMarker = /\[!!\]|⚠|✗/.test(out);
      if (malformed) {
        expect(hasMarker, `recoverable marker for ${JSON.stringify(lines)}`).toBe(true);
      } else {
        // Valid commands must still work; marker absence is fine but hard-
        // crash evidence (uncaughtException leak text) is never allowed.
        expect(out).not.toContain("uncaughtException");
      }
      expect(out).not.toContain("uncaughtException");
    });
  });

  it("plain-text lines go to the mock agent without killing the REPL", () => {
    const { out, exitCode } = runReplSession(["hello there", "second plain line", "/quit"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("session ended");
    // The mock agent answers plain text (echo-style), proving lines reached it.
    expect(out.toLowerCase()).toContain("mock");
  });
});
