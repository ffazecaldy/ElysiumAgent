/**
 * packages/cli/src/decision/sanitize.ts — state minimization boundary.
 *
 * NOTHING leaves the harness toward a remote decision provider without
 * passing through here: SecretGuard redaction first, then projection to an
 * explicit allowlist of fields, then hard caps. The output must be safe to
 * log (it feeds the decision fingerprint / evidence).
 */

import { createHash } from "node:crypto";

import { redactObject, redactText } from "@elysium/core";

/** Hard cap per string field (chars). */
const MAX_STRING = 600;
/** Hard cap on the number of list items (files, tests...). */
const MAX_LIST = 24;
/** Values that never travel, whatever the caller asks for. */
const FORBIDDEN_KEYS = new Set([
  "env",
  "environment",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credentials",
  "dotenv",
  "rawoutput",
  "raw_output",
  "transcript",
  "stdout",
  "stderr",
  "fullfile",
  "filecontent",
  "file_content",
  "diff", // only sanitized diff summaries travel
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function capString(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[capped]` : value;
}

/**
 * Project + redact an arbitrary context object into a minimized, safe state.
 * - SecretGuard redaction (builtin patterns + exact values) on every string
 * - forbidden keys dropped (env/secrets/raw output/transcripts/full diffs)
 * - strings capped, lists truncated, depth flattened to primitives
 * - deterministic: same input → same output (key order preserved)
 */
export function minimizeState(
  context: Record<string, unknown>,
  extraSecretValues: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) continue;
    out[key] = projectValue(value, extraSecretValues);
  }
  return redactObject(out, extraSecretValues) as Record<string, unknown>;
}

function projectValue(
  value: unknown,
  secrets: string[],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return capString(redactText(value, secrets));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "object" && value !== null) {
    // Cycle guard: state can be any runtime object; a cyclic reference is
    // dropped rather than recursing to stack overflow (probe B7).
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, MAX_LIST).map((item) => projectValue(item, secrets, seen));
      }
      const rec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(normalizeKey(k))) continue;
        const projected = projectValue(v, secrets, seen);
        if (projected !== undefined) rec[k] = projected;
      }
      return rec;
    } finally {
      seen.delete(value);
    }
  }
  return undefined;
}

/**
 * JSON.stringify that survives pathological structures: cycles become
 * `[Circular]`, bigint/symbol/function/Error fall back to readable strings.
 * Deterministic for the same input (key order preserved) — the decision
 * fingerprint depends on it. Boundary rule: state objects can be anything a
 * tool/caller produced, never assumed JSON-clean.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function") return `[Function${v.name ? `: ${v.name}` : ""}]`;
    if (typeof v === "symbol") return v.toString();
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.map(walk);
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(item);
      }
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(walk(value)) ?? "null";
  } catch {
    return String(value);
  }
}

/** Deterministic hash of the state actually sent (for the decision record). */
export function stateHash(state: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex").slice(0, 16);
}
