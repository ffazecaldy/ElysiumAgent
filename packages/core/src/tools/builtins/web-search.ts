/** web_search builtin: Tavily / Brave providers with a keyless DuckDuckGo fallback. */
import type { Tool, ToolContext, ToolResult } from "../../types/tools";
import { argNumber, argString, err, ok, telemetry } from "../internal";
import { type WebToolOptions, fetchWithTimeout } from "./web-fetch";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type ProviderName = "tavily" | "brave" | "duckduckgo";

/**
 * Picks the search provider from the environment. Exported pure (of globals via
 * the explicit argument) so tests can assert the branching without network.
 */
export function pickProvider(env: Record<string, string | undefined> = process.env): ProviderName {
  if (env.TAVILY_API_KEY !== undefined && env.TAVILY_API_KEY !== "") return "tavily";
  if (env.BRAVE_API_KEY !== undefined && env.BRAVE_API_KEY !== "") return "brave";
  return "duckduckgo";
}

/** Collapses whitespace and decodes the entities that appear in scraped text. */
function clean(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses the DuckDuckGo HTML results page. Pure regex over anchor markup so it
 * can be exercised offline against a fixture. Returns at most `limit` hits;
 * malformed anchors (missing href) are skipped.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Results live in <a class="result__a" href="...">Title</a> optionally
  // followed by a <a class="result__snippet" ...>snippet</a> block.
  const anchorRe =
    /<a\s+[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\s+[^>]*class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  const snippetRe = /<a\s+[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
  for (const match of html.matchAll(anchorRe)) {
    if (results.length >= limit) break;
    const href = match[1];
    const titleHtml = match[2];
    const tail = match[3] ?? "";
    if (href === undefined || titleHtml === undefined) continue;
    const url = clean(href);
    if (url === "") continue;
    const snippetMatch = snippetRe.exec(tail);
    results.push({
      title: clean(titleHtml),
      url,
      snippet: snippetMatch !== null ? clean(snippetMatch[1] ?? "") : "",
    });
  }
  return results;
}

interface ProviderOutcome {
  provider: ProviderName;
  results: SearchResult[];
}

async function searchTavily(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const response = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`tavily responded ${response.status}`);
  }
  const data = (await response.json()) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
  };
  const rows = Array.isArray(data.results) ? data.results : [];
  return rows.slice(0, limit).map((row) => ({
    title: typeof row.title === "string" ? clean(row.title) : "",
    url: typeof row.url === "string" ? row.url : "",
    snippet: typeof row.content === "string" ? clean(row.content) : "",
  }));
}

async function searchBrave(
  apiKey: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const response = await fetchWithTimeout(
    url,
    { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } },
    signal,
  );
  if (!response.ok) {
    throw new Error(`brave responded ${response.status}`);
  }
  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
  };
  const rows = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  return rows.slice(0, limit).map((row) => ({
    title: typeof row.title === "string" ? clean(row.title) : "",
    url: typeof row.url === "string" ? row.url : "",
    snippet: typeof row.description === "string" ? clean(row.description) : "",
  }));
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
    },
    signal,
  );
  if (!response.ok) {
    throw new Error(`duckduckgo responded ${response.status}`);
  }
  const html = await response.text();
  return parseDuckDuckGoHtml(html, limit);
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "(no results)";
  return results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n ${r.snippet}`).join("\n");
}

/** web_search: Tavily/Brave when a key is present, keyless DuckDuckGo otherwise. */
export function createWebSearchTool(options: WebToolOptions): Tool {
  return {
    name: "web_search",
    description:
      "Web search (Tavily, Brave, or keyless DuckDuckGo depending on configured API keys). " +
      "Returns a formatted list of title, URL and snippet. Subject to the run's network flag.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "number",
          description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        },
      },
      required: ["query"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const t0 = Date.now();
      if (!options.network) {
        return err("network disabled for this run");
      }
      try {
        if (ctx.signal.aborted) {
          telemetry(ctx.emit, "web_search", Date.now() - t0, true);
          return err("aborted by caller");
        }
        const query = argString(args, "query");
        if (query === undefined || query.trim() === "") {
          telemetry(ctx.emit, "web_search", Date.now() - t0, true);
          return err("missing required argument 'query'");
        }
        let limit = argNumber(args, "limit") ?? DEFAULT_LIMIT;
        if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
        if (limit > MAX_LIMIT) limit = MAX_LIMIT;
        const provider = pickProvider(process.env);
        let outcome: ProviderOutcome;
        switch (provider) {
          case "tavily":
            outcome = {
              provider,
              results: await searchTavily(
                process.env.TAVILY_API_KEY ?? "",
                query,
                limit,
                ctx.signal,
              ),
            };
            break;
          case "brave":
            outcome = {
              provider,
              results: await searchBrave(process.env.BRAVE_API_KEY ?? "", query, limit, ctx.signal),
            };
            break;
          default:
            outcome = { provider, results: await searchDuckDuckGo(query, limit, ctx.signal) };
            break;
        }
        telemetry(ctx.emit, "web_search", Date.now() - t0, false);
        return ok(formatResults(outcome.results), {
          provider: outcome.provider,
          count: outcome.results.length,
        });
      } catch (e: unknown) {
        // Network failures never throw into the harness: isError result instead.
        telemetry(ctx.emit, "web_search", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(`web_search failed: ${message}`);
      }
    },
  };
}
