/**
 * Minimal MCP (Model Context Protocol) stdio client — discovery only.
 *
 * Speaks just enough JSON-RPC over a child process's stdin/stdout to ask a
 * server what tools it exposes (initialize → notifications/initialized →
 * tools/list). No tool invocation, no resources, no prompts: this exists for
 * the `/mcp` command's server listing.
 *
 * Every entry point is total: `readMcpConfig` returns {} on anything unexpected
 * and `probeServer` always resolves to a result, never throws.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One MCP server entry from `.mcp.json`. */
export interface McpServerConfig {
  command: string;
  args?: string[];
}

/** Outcome of probing a single MCP server. */
export interface McpProbeResult {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

/** The `.mcp.json` shape: {"mcpServers": {name: {command, args?}}}. */
interface RawMcpFile {
  mcpServers?: unknown;
}

/**
 * Read `<projectRoot>/.mcp.json` tolerantly: missing file, malformed JSON,
 * missing/wrong-typed `mcpServers` or per-server fields all yield {} (or a
 * partial map with only the valid entries), never a throw.
 */
export function readMcpConfig(projectRoot: string): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(join(projectRoot, ".mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as RawMcpFile | null;
    if (!parsed || typeof parsed !== "object") return {};
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [serverName, value] of Object.entries(servers as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const command = (value as { command?: unknown }).command;
      if (typeof command !== "string" || command.length === 0) continue;
      const config: McpServerConfig = { command };
      const args = (value as { args?: unknown }).args;
      if (Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        config.args = args as string[];
      }
      out[serverName] = config;
    }
    return out;
  } catch {
    return {};
  }
}

/** One pending JSON-RPC request awaiting its response (result OR error). */
type Pending = Map<number, (response: unknown) => void>;

/**
 * Probe an MCP stdio server: spawn it, run the initialize handshake, ask for
 * tools/list, collect tool names, kill the process. Resolves {ok:false} with
 * an error on spawn failure, early exit, a JSON-RPC error response, or when
 * `timeoutMs` elapses — never throws.
 */
export async function probeServer(
  name: string,
  cfg: McpServerConfig,
  timeoutMs = 4000,
): Promise<McpProbeResult> {
  const result: McpProbeResult = { name, ok: false, tools: [] };
  let child: ChildProcess;
  try {
    child = spawn(cfg.command, cfg.args ?? [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  return await driveHandshake(child, result, timeoutMs);
}

/** Run the JSON-RPC discovery sequence over an already-spawned child. */
function driveHandshake(
  child: ChildProcess,
  result: McpProbeResult,
  timeoutMs: number,
): Promise<McpProbeResult> {
  return new Promise<McpProbeResult>((resolve) => {
    let buffer = "";
    let settled = false;
    let stderrTail = "";
    const pending: Pending = new Map();

    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      if (error !== undefined) {
        result.ok = false;
        result.error = error;
      } else {
        result.ok = true;
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    child.on("error", (err: Error) => finish(`spawn failed: ${err.message}`));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-500);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      const why = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      const lastStderr = stderrTail.trim().split("\n").pop();
      finish(`server exited early (${why})${lastStderr ? `: ${lastStderr}` : ""}`);
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt >= 0) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // tolerate stray non-JSON output
        }
        if (!message || typeof message !== "object") continue;
        const { id, error } = message as { id?: unknown; error?: unknown };
        if (error !== undefined && error !== null) {
          const msg = (error as { message?: unknown }).message;
          finish(`json-rpc error: ${typeof msg === "string" ? msg : JSON.stringify(error)}`);
          return;
        }
        if (typeof id !== "number" || !pending.has(id)) continue;
        const respond = pending.get(id);
        pending.delete(id);
        respond?.((message as { result?: unknown }).result);
      }
    });

    const send = (message: object): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* stdin closed — the exit/error handlers will settle the result */
      }
    };

    const request = (id: number, message: object): Promise<unknown> => {
      return new Promise<unknown>((respond) => {
        pending.set(id, respond);
        send(message);
      });
    };

    void (async () => {
      try {
        send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "elysium", version: "0.1.0" },
          },
        });
        const initResult = await request(1, {});
        if (!initResult || typeof initResult !== "object") {
          finish("initialize returned no result");
          return;
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const listResult = (await request(2, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        })) as { tools?: unknown } | undefined;
        const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
        result.tools = tools.flatMap((tool) => {
          const toolName = (tool as { name?: unknown } | null)?.name;
          return typeof toolName === "string" ? [toolName] : [];
        });
        finish();
      } catch (err) {
        finish(err instanceof Error ? err.message : String(err));
      }
    })();
  });
}
