/** web_fetch builtin: HTTP(S) GET with a content-type allowlist and a 100KB body cap. */
import type { Tool, ToolContext, ToolResult } from "../../types/tools";
import { argString, err, ok, telemetry } from "../internal";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 100 * 1024;

/** Options accepted by the web builtins (network gating). */
export interface WebToolOptions {
  /** When false the tool registers but refuses every run without any fetch. */
  network: boolean;
}

/** Decodes the common named/numeric HTML entities found in scraped text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** Basic HTML cleanup: drops script/style blocks, strips tags, decodes entities. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Parses an http/https URL; returns undefined for anything else (never throws). */
export function parseHttpUrl(raw: string): URL | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
  } catch {
    // Not a parsable absolute URL.
  }
  return undefined;
}

/** True when a content-type is accepted fetchable text (text/*, JSON, XHTML). */
function isAllowedContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.startsWith("application/json") ||
    ct.startsWith("application/xhtml")
  );
}

/**
 * fetch() with a hard internal timeout (15s) and an optional external abort
 * signal. The internal controller always wins over any init.signal.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let externalAborted = false;
  const onExternal = (): void => {
    externalAborted = true;
    controller.abort(new Error("aborted by caller"));
  };
  if (externalSignal?.aborted) {
    externalAborted = true;
    controller.abort(new Error("aborted by caller"));
  } else {
    externalSignal?.addEventListener("abort", onExternal, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s`)),
    FETCH_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: unknown) {
    if (externalAborted) throw new Error("aborted by caller");
    throw e;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternal);
  }
}

interface BodyRead {
  text: string;
  /** Bytes actually kept (capped at MAX_BODY_BYTES when truncated). */
  bytes: number;
  truncated: boolean;
}

/** Reads the response body keeping at most MAX_BODY_BYTES, then cancels the stream. */
async function readBodyCapped(response: Response): Promise<BodyRead> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text), truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BODY_BYTES - total;
    if (room <= 0) {
      truncated = true;
      reader.cancel().catch(() => undefined);
      break;
    }
    if (value.length > room) {
      chunks.push(Buffer.from(value.slice(0, room)));
      total = MAX_BODY_BYTES;
      // One extra read to confirm the sender really had more bytes queued.
      const next = await reader.read();
      truncated = !next.done;
      reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total, truncated };
}

/** web_fetch: GET a URL, text-like content-types only, body capped at 100KB. */
export function createWebFetchTool(options: WebToolOptions): Tool {
  return {
    name: "web_fetch",
    description:
      "Fetch an http(s) URL with GET (15s timeout). Only text/*, application/json and " +
      "application/xhtml bodies are accepted; the body is capped at 100KB and HTML is " +
      "reduced to plain text. Non-network-safe by default: subject to the run's network flag.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL to fetch" },
      },
      required: ["url"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const t0 = Date.now();
      if (!options.network) {
        return err("network disabled for this run");
      }
      try {
        if (ctx.signal.aborted) {
          telemetry(ctx.emit, "web_fetch", Date.now() - t0, true);
          return err("aborted by caller");
        }
        const rawUrl = argString(args, "url");
        if (rawUrl === undefined || rawUrl.trim() === "") {
          telemetry(ctx.emit, "web_fetch", Date.now() - t0, true);
          return err("missing required argument 'url'");
        }
        const parsed = parseHttpUrl(rawUrl);
        if (parsed === undefined) {
          telemetry(ctx.emit, "web_fetch", Date.now() - t0, true);
          return err(`only http/https URLs are supported, got: ${rawUrl}`);
        }
        const response = await fetchWithTimeout(
          parsed.toString(),
          { redirect: "follow" },
          ctx.signal,
        );
        const contentType = response.headers.get("content-type") ?? "";
        if (!isAllowedContentType(contentType)) {
          telemetry(ctx.emit, "web_fetch", Date.now() - t0, true);
          return err(
            `unsupported content-type '${contentType || "missing"}' for ${parsed.toString()} (allowed: text/*, application/json, application/xhtml+xml)`,
          );
        }
        const { text, bytes, truncated } = await readBodyCapped(response);
        const content = contentType.toLowerCase().includes("html") ? stripHtml(text) : text;
        const body = truncated ? `${content}\n[truncated at 100KB]` : content;
        telemetry(ctx.emit, "web_fetch", Date.now() - t0, false);
        return ok(body, { url: parsed.toString(), status: response.status, bytes });
      } catch (e: unknown) {
        // Network/DNS/abort failures surface as isError results, never a throw.
        telemetry(ctx.emit, "web_fetch", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(`web_fetch failed: ${message}`);
      }
    },
  };
}
