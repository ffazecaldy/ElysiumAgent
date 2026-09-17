/**
 * packages/cli/src/cloud/puter.ts — Puter implementation of the cloud
 * integration seam, based on the Puter CLI (@heyputer/cli) documented at
 * docs.puter.com/cli.
 *
 * Design notes:
 * - Uses `puter` CLI via execFileSync (shell:false) — the CLI stores the
 *   auth token itself after `puter login` (browser-based flow). We never
 *   handle tokens.
 * - `available()` checks the CLI binary AND login state (`puter whoami`).
 * - Reports are uploaded with `puter fs cp -r` into the user's Puter drive
 *   (~/elysium/reports/<runId>), then shared with a SIGNED, TEMPORARY read
 *   URL via `puter fs readurl` semantics when supported by the installed
 *   CLI; the URL expiry follows the provider default (24h) — callers must
 *   treat it as ephemeral.
 * - Profile persistence uses the CLI KV (`puter kv set/get`) on the user's
 *   account — cross-device by construction.
 *
 * All commands are best-effort: missing CLI / not logged in → available()
 * false and every method resolves to null/throws nothing.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import type { CloudIntegrationProvider } from "./provider";

/** Runs the puter CLI; returns stdout or null when the command fails. */
function puter(args: string[]): string | null {
  try {
    return execFileSync("puter", args, {
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** True when the CLI exists and the user is logged in. */
function cliAvailable(): boolean {
  if (puter(["--version"]) === null) return false;
  return puter(["whoami"]) !== null;
}

/** Puter-backed cloud provider (user-pays: the operator's own account). */
export const puterProvider: CloudIntegrationProvider = {
  id: "puter",
  label: "Puter (user-pays cloud)",

  available(): boolean {
    return cliAvailable();
  },

  async publishReport(artifactDir: string, files: string[]): Promise<{ url: string | null }> {
    if (!cliAvailable() || files.length === 0) return { url: null };
    const runId = path.basename(artifactDir);
    const remoteDir = `~/elysium/reports/${runId}`;
    for (const file of files) {
      const res = puter(["fs", "cp", path.join(artifactDir, file), `${remoteDir}/${file}`]);
      if (res === null) return { url: null };
    }
    // Temporary signed read URL for the report index (provider default expiry).
    const url = puter(["fs", "readurl", `${remoteDir}/report.json`]);
    return { url };
  },

  async loadProfile(): Promise<Record<string, string> | null> {
    if (!cliAvailable()) return null;
    const raw = puter(["kv", "get", "elysium:profile:v1"]);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
      return null;
    } catch {
      return null;
    }
  },

  async saveProfile(data: Record<string, string>): Promise<void> {
    if (!cliAvailable()) return;
    puter(["kv", "set", "elysium:profile:v1", JSON.stringify(data)]);
  },
};
