/**
 * Tests for the minimal MCP stdio discovery client:
 * - probeServer: happy path via a fake newline-delimited JSON-RPC server,
 *   nonexistent command (no throw), non-responding server (timeout),
 * - readMcpConfig: empty dir, malformed JSON, write/read roundtrip.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeServer, readMcpConfig, type McpServerConfig } from "../src/mcp-client";

/** Fake MCP server: answers initialize + tools/list over stdout, one JSON per line. */
const FAKE_SERVER_SCRIPT = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf("\\n");
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } },
      }));
    } else if (msg.method === "tools/list") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "tool_a" }, { name: "tool_b" }] },
      }));
    }
  }
});
`;

/** Server that accepts the handshake silently and never answers anything. */
const SILENT_SERVER_SCRIPT = `
process.stdin.resume();
`;

function fakeServerConfig(script: string): McpServerConfig {
  return { command: "node", args: ["-e", script] };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("probeServer", () => {
  it("discovers tools from a responding server", async () => {
    const result = await probeServer("fake", fakeServerConfig(FAKE_SERVER_SCRIPT), 8000);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.tools).toEqual(["tool_a", "tool_b"]);
  }, 15000);

  it("returns ok:false without throwing on a nonexistent command", async () => {
    const result = await probeServer("missing", {
      command: "elysium-definitely-not-a-real-cmd-9x7",
    });
    expect(result.ok).toBe(false);
    expect(result.name).toBe("missing");
    expect(result.tools).toEqual([]);
    expect(typeof result.error).toBe("string");
    expect(result.error?.length).toBeGreaterThan(0);
  }, 15000);

  it("returns error 'timeout' when the server never responds", async () => {
    const result = await probeServer("silent", fakeServerConfig(SILENT_SERVER_SCRIPT), 200);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(result.tools).toEqual([]);
  }, 15000);
});

describe("readMcpConfig", () => {
  it("returns {} on a directory without .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-empty-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(readMcpConfig(dir)).toEqual({});
  });

  it("returns {} on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-bad-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".mcp.json"), "{ this is not json !!!");
    expect(readMcpConfig(dir)).toEqual({});
  });

  it("roundtrips a written .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-ok-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const expected = {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
      bare: { command: "some-server" },
    };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: expected }));
    expect(readMcpConfig(dir)).toEqual(expected);
  });
});
