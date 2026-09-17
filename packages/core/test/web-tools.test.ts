/**
 * Tests for the web builtins (web_fetch / web_search):
 * - local http server for fetch behaviours (no real internet),
 * - pure stripHtml and parseDuckDuckGoHtml against inline fixtures,
 * - provider branching via pickProvider with stubbed fetch,
 * - network=false gate that never touches global fetch.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool, parseHttpUrl, stripHtml } from "../src/tools/builtins/web-fetch";
import {
  createWebSearchTool,
  parseDuckDuckGoHtml,
  pickProvider,
} from "../src/tools/builtins/web-search";
import { createBuiltinTools } from "../src/tools/registry";
import type { Tool, ToolContext } from "../src/types/tools";

const noopCtx: ToolContext = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  emit: () => undefined,
};

/** Minimal local http server with a route table; ephemeral port like swarm-mode tests. */
interface TestServer {
  url: string;
  close: () => Promise<void>;
}

interface Route {
  status?: number;
  headers?: Record<string, string>;
  location?: string;
  body: string | Buffer;
}

function startServer(routes: (requestUrl: string) => Route): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    const route = routes(request.url ?? "/");
    if (route.location !== undefined) {
      response.writeHead(route.status ?? 302, {
        location: route.location,
        ...(route.headers ?? {}),
      });
      response.end();
      return;
    }
    response.writeHead(route.status ?? 200, {
      "content-type": "text/plain; charset=utf-8",
      ...(route.headers ?? {}),
    });
    response.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/** Executes a tool and narrows the result for assertions. */
async function run(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean; details?: unknown }> {
  const result = await tool.execute(args, noopCtx);
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web_fetch", () => {
  it("fetches a 200 text body and reports details", async () => {
    const server = await startServer(() => ({ body: "hello world" }));
    try {
      const tool = createWebFetchTool({ network: true });
      const result = await run(tool, { url: `${server.url}/hello` });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("hello world");
      const details = result.details as { url: string; status: number; bytes: number };
      expect(details.status).toBe(200);
      expect(details.url).toBe(`${server.url}/hello`);
      expect(details.bytes).toBe(11);
    } finally {
      await server.close();
    }
  });

  it("follows redirects to the final resource", async () => {
    const server = await startServer((requestUrl) =>
      requestUrl === "/redirect" ? { location: "/target", body: "" } : { body: "landing page" },
    );
    try {
      const tool = createWebFetchTool({ network: true });
      const result = await run(tool, { url: `${server.url}/redirect` });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("landing page");
      const details = result.details as { status: number };
      expect(details.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("rejects binary content-types with an isError result", async () => {
    const server = await startServer(() => ({
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([0, 1, 2, 3]),
    }));
    try {
      const tool = createWebFetchTool({ network: true });
      const result = await run(tool, { url: `${server.url}/bin` });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("octet-stream");
    } finally {
      await server.close();
    }
  });

  it("truncates bodies larger than 100KB with a note", async () => {
    const big = "a".repeat(150 * 1024);
    const server = await startServer(() => ({ body: big }));
    try {
      const tool = createWebFetchTool({ network: true });
      const result = await run(tool, { url: `${server.url}/big` });
      expect(result.isError).toBe(false);
      expect(result.content.endsWith("\n[truncated at 100KB]")).toBe(true);
      const body = result.content.replace(/\n\[truncated at 100KB\]$/, "");
      expect(body.length).toBe(100 * 1024);
      const details = result.details as { bytes: number };
      expect(details.bytes).toBe(100 * 1024);
    } finally {
      await server.close();
    }
  });

  it("refuses non-http URLs without performing any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tool = createWebFetchTool({ network: true });
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "not-a-url"]) {
      const result = await run(tool, { url });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("http");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports network errors as isError results instead of throwing", async () => {
    const tool = createWebFetchTool({ network: true });
    const result = await run(tool, { url: "http://127.0.0.1:9/unreachable" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("web_fetch failed");
  });
});

describe("stripHtml", () => {
  it("removes script and style blocks and all tags", () => {
    const html = [
      "<html><head>",
      "<script>var x = 1 < 2; evil();</script>",
      "<style>body { color: red; }</style>",
      "</head><body><h1>Title</h1><p>Body <b>text</b>.</p></body></html>",
    ].join("");
    const text = stripHtml(html);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color");
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).toContain("Title");
    expect(text.replace(/\s+/g, " ")).toContain("Body text");
  });

  it("decodes entities including &amp;", () => {
    expect(stripHtml("<p>Fish &amp; Chips &lt;3 &quot;q&quot;</p>")).toBe('Fish & Chips <3 "q"');
  });

  it("round-trips plain text untouched", () => {
    expect(stripHtml("just plain text")).toBe("just plain text");
  });
});

describe("parseHttpUrl", () => {
  it("accepts http and https, rejects other schemes and garbage", () => {
    expect(parseHttpUrl("http://example.com/")?.protocol).toBe("http:");
    expect(parseHttpUrl("https://example.com/x?y=1")?.protocol).toBe("https:");
    expect(parseHttpUrl("file:///etc/passwd")).toBeUndefined();
    expect(parseHttpUrl("ftp://x/")).toBeUndefined();
    expect(parseHttpUrl("::garbage::")).toBeUndefined();
  });
});

describe("parseDuckDuckGoHtml", () => {
  const FIXTURE = [
    "<html><body>",
    '<div class="result results_links">',
    '<h2><a rel="nofollow" class="result__a" href="https://a.example/1">First &amp; foremost</a></h2>',
    '<a class="result__snippet" href="//a.example/1">Snippet <b>one</b>.</a>',
    "</div>",
    '<div class="result results_links">',
    '<h2><a rel="nofollow" class="result__a" href="https://b.example/2">Second</a></h2>',
    '<a class="result__snippet" href="//b.example/2">Snippet two.</a>',
    "</div>",
    '<div class="result results_links">',
    '<h2><a rel="nofollow" class="result__a" href="https://c.example/3">Third</a></h2>',
    '<a class="result__snippet" href="//c.example/3">Snippet three.</a>',
    "</div>",
    "</body></html>",
  ].join("");

  it("extracts title, url and snippet from three results", () => {
    const results = parseDuckDuckGoHtml(FIXTURE, 5);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "First & foremost",
      url: "https://a.example/1",
      snippet: "Snippet one.",
    });
    expect(results[1]?.title).toBe("Second");
    expect(results[1]?.url).toBe("https://b.example/2");
    expect(results[2]?.title).toBe("Third");
  });

  it("honours the limit", () => {
    expect(parseDuckDuckGoHtml(FIXTURE, 2)).toHaveLength(2);
  });

  it("returns an empty array when the html has no results", () => {
    expect(parseDuckDuckGoHtml("<html><body>No results here</body></html>", 5)).toEqual([]);
  });
});

describe("pickProvider", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.TAVILY_API_KEY = undefined;
    process.env.BRAVE_API_KEY = undefined;
  });
  afterEach(() => {
    process.env = original;
  });

  it("prefers tavily when TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "tav";
    process.env.BRAVE_API_KEY = "brv";
    expect(pickProvider(process.env)).toBe("tavily");
  });

  it("falls back to brave with only BRAVE_API_KEY", () => {
    process.env.BRAVE_API_KEY = "brv";
    expect(pickProvider(process.env)).toBe("brave");
  });

  it("uses duckduckgo without any key", () => {
    expect(pickProvider(process.env)).toBe("duckduckgo");
  });

  it("ignores empty-string keys", () => {
    process.env.TAVILY_API_KEY = "";
    expect(pickProvider(process.env)).toBe("duckduckgo");
  });
});

describe("web_search", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.TAVILY_API_KEY = undefined;
    process.env.BRAVE_API_KEY = undefined;
  });
  afterEach(() => {
    process.env = original;
  });

  it("branches to tavily and formats results when TAVILY_API_KEY is set", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: "Tav Result", url: "https://t.example/", content: "Tav <b>snippet</b>." },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const tool = createWebSearchTool({ network: true });
    const result = await run(tool, { query: "hello", limit: 3 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1. Tav Result — https://t.example/");
    expect(result.content).toContain("Tav snippet.");
    const details = result.details as { provider: string; count: number };
    expect(details.provider).toBe("tavily");
    expect(details.count).toBe(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(calledUrl).toBe("https://api.tavily.com/search");
    expect(calledInit.method).toBe("POST");
    const body = JSON.parse(calledInit.body) as {
      api_key: string;
      query: string;
      max_results: number;
    };
    expect(body.api_key).toBe("test-key");
    expect(body.max_results).toBe(3);
  });

  it("branches to brave with only BRAVE_API_KEY set", async () => {
    process.env.BRAVE_API_KEY = "brave-key";
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [
                { title: "Brave Result", url: "https://b.example/", description: "Brave snippet." },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const tool = createWebSearchTool({ network: true });
    const result = await run(tool, { query: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Brave Result");
    const details = result.details as { provider: string };
    expect(details.provider).toBe("brave");
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(String(calledUrl).startsWith("https://api.search.brave.com/res/v1/web/search?q=")).toBe(
      true,
    );
    expect(calledInit.headers["X-Subscription-Token"]).toBe("brave-key");
  });

  it("falls back to duckduckgo parsing without keys", async () => {
    const ddgHtml = [
      '<a class="result__a" href="https://d.example/1">Ddg Result</a>',
      '<a class="result__snippet" href="//d.example/1">Ddg snippet.</a>',
    ].join("");
    const fetchSpy = vi.fn(
      async () => new Response(ddgHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const tool = createWebSearchTool({ network: true });
    const result = await run(tool, { query: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1. Ddg Result — https://d.example/1");
    expect(result.content).toContain("Ddg snippet.");
    const details = result.details as { provider: string; count: number };
    expect(details.provider).toBe("duckduckgo");
    expect(details.count).toBe(1);
  });

  it("returns an isError result on provider errors instead of throwing", async () => {
    process.env.TAVILY_API_KEY = "bad-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const tool = createWebSearchTool({ network: true });
    const result = await run(tool, { query: "hello" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("web_search failed");
  });
});

describe("network gating", () => {
  it("web tools register through createBuiltinTools but refuse without network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tools = createBuiltinTools({ allowedRoots: [process.cwd()] }, { network: false });
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    const fetchTool = tools.find((t) => t.name === "web_fetch") as Tool;
    const searchTool = tools.find((t) => t.name === "web_search") as Tool;
    const r1 = await run(fetchTool, { url: "https://example.com/" });
    const r2 = await run(searchTool, { query: "hello" });
    expect(r1.isError).toBe(true);
    expect(r1.content).toBe("network disabled for this run");
    expect(r2.isError).toBe(true);
    expect(r2.content).toBe("network disabled for this run");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaults to network enabled (retrocompatible signature)", async () => {
    const tools = createBuiltinTools({ allowedRoots: [process.cwd()] });
    const names = tools.map((t) => t.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
    // Real behaviour is exercised by the web_fetch server tests above.
    const fetchTool = tools.find((t) => t.name === "web_fetch") as Tool;
    const server = await startServer(() => ({ body: "gated on" }));
    try {
      const result = await run(fetchTool, { url: `${server.url}/` });
      expect(result.isError).toBe(false);
      expect(result.content).toBe("gated on");
    } finally {
      await server.close();
    }
  });
});
