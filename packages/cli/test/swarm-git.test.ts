/** swarm-git tests: unit (checkpoint/rollback on a real temp repo, no-op
 * mode) + runtime integration (runSwarmGoal with gitCheckpoints:true leaves
 * a real git repo with elysium/* tags in the run workspace). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSwarmGit } from "../src/swarm-git";
import { runSwarmGoal } from "../src/swarm-mode";

const tmpDirs: string[] = [];
function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `swarm-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf-8",
    shell: false,
  }).trim();
}

describe("createSwarmGit", () => {
  it("checkpoints produce real tags and rollbackFiles restores content byte-exact", () => {
    const dir = makeTempDir();
    const swarmGit = createSwarmGit(dir);
    const file = path.join(dir, "code.txt");
    fs.writeFileSync(file, "v1");

    expect(swarmGit.checkpoint("plan")).not.toBeNull();
    const tags = git(dir, ["tag"]);
    expect(tags).toContain("elysium/plan");
    expect(Number(git(dir, ["rev-list", "--count", "HEAD"]))).toBeGreaterThanOrEqual(1);

    fs.writeFileSync(file, "v2-broken");
    const rolled = swarmGit.rollbackFiles(["code.txt"], "plan");
    expect(rolled).toBe(1);
    expect(fs.readFileSync(file, "utf-8")).toBe("v1");
  });

  it("enabled:false is a full no-op (no tags, no throw)", () => {
    const dir = makeTempDir();
    const swarmGit = createSwarmGit(dir, { enabled: false });
    expect(swarmGit.checkpoint("plan")).toBeNull();
    expect(swarmGit.rollbackFiles(["x.txt"], "plan")).toBe(0);
    expect(() => git(dir, ["tag"])).toThrow(); // no repo was created
  });

  it("missing tag rollback counts 0 successes without throwing", () => {
    const dir = makeTempDir();
    const swarmGit = createSwarmGit(dir);
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "x");
    expect(swarmGit.rollbackFiles(["a.txt"], "never-tagged")).toBe(0);
  });
});

// ── Runtime integration: the live swarm path leaves real git tags ──

interface ScriptedServer {
  url: string;
  close: () => Promise<void>;
}

async function startScriptedServer(): Promise<ScriptedServer> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
      const flat = parsed.messages.map((m) => String(m.content)).join(" ");
      const sse = (payload: unknown): void => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      };
      if (flat.includes("Decompose the goal")) {
        sse({
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  subtasks: [{ id: "a", goal: "Write file", acceptanceCriteria: ["file exists"] }],
                }),
              },
            },
          ],
        });
        return;
      }
      if (flat.includes("Judge if the result")) {
        sse({
          choices: [{ index: 0, delta: { content: JSON.stringify({ passed: true, gaps: [] }) } }],
        });
        return;
      }
      sse({ choices: [{ index: 0, delta: { content: "Done. file exists" } }] });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("runSwarmGoal gitCheckpoints integration", () => {
  it("the real run workspace becomes a git repo with elysium/plan and elysium/task-<id> tags", async () => {
    const server = await startScriptedServer();
    try {
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "test-key", model: "mock" },
        gitCheckpoints: true,
      });
      const ws = report.workspacePath;
      const tags = git(ws, ["tag"]);
      expect(tags).toContain("elysium/plan");
      expect(tags).toContain("elysium/task-a");
    } finally {
      await server.close();
    }
  }, 20000);

  it("default (no flag) creates NO repo — hermetic back-compat", async () => {
    const server = await startScriptedServer();
    try {
      const report = await runSwarmGoal({
        goal: "Write file",
        provider: { baseUrl: server.url, apiKey: "test-key", model: "mock" },
      });
      const dotGit = path.join(report.workspacePath, ".git");
      expect(fs.existsSync(dotGit)).toBe(false);
    } finally {
      await server.close();
    }
  }, 20000);
});
