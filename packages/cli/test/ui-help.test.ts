/**
 * Tests for the dynamic help screen, the switchable matrix/mono theme, and
 * the width-aware statusBar. Run in non-TTY (vitest) so output is plain and
 * deterministic; the theme switch must therefore never crash and must
 * restore correctly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { currentTheme, helpScreen, setTheme, statusBar } from "../src/ui";

afterEach(() => {
  setTheme("matrix"); // restore default for other test files
});

describe("helpScreen", () => {
  it("full help lists COMANDI and /swarm", () => {
    const out = helpScreen("");
    expect(out).toContain("COMANDI");
    expect(out).toContain("/swarm");
  });

  it("filter 'cost' shows /cost as stable (promoted from planned)", () => {
    const out = helpScreen("cost");
    expect(out).toContain("/cost");
    expect(out).toContain("Sessione");
  });

  it("unknown filter says no command matches", () => {
    const out = helpScreen("zzznessuno");
    expect(out).toContain("nessun comando");
  });
});

describe("theme switching", () => {
  it("defaults to matrix", () => {
    setTheme("matrix");
    expect(currentTheme()).toBe("matrix");
  });

  it("switches to mono and back without crashing, brand text stays sane", () => {
    expect(currentTheme()).toBe("matrix");
    setTheme("mono");
    expect(currentTheme()).toBe("mono");
    // Brand colorizers become identity in mono: strings stay readable.
    const full = helpScreen("");
    expect(full).toContain("COMANDI");
    expect(full).toContain("/swarm");
    const filtered = helpScreen("cost");
    expect(filtered).toContain("/cost");
    expect(filtered).toContain("Sessione");
    setTheme("matrix");
    expect(currentTheme()).toBe("matrix");
    expect(helpScreen("")).toContain("/swarm");
  });
});

describe("statusBar", () => {
  const base = { model: "glm-test", mode: "medium", tokens: 1534, turns: 7 };

  const setCols = (n: number | undefined): void => {
    Object.defineProperty(process.stdout, "columns", {
      value: n,
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => setCols(undefined));

  it("wide terminal: single line with ◆, tok, context bar and ±lines", () => {
    setCols(120);
    const out = statusBar({ ...base, historyMsgs: 42, historyCap: 60, added: 12, removed: 3 });
    expect(out).toContain("◆");
    expect(out).toContain("tok");
    expect(out).toContain("+12/−3");
    expect(out).toContain("▮"); // 42/60 ≈ 70% → filled blocks on the bar
    expect(out).toContain("/help");
    expect(out.includes("\n")).toBe(false);
  });

  it("narrow terminal: packs on two lines and keeps the context bar", () => {
    setCols(70);
    const out = statusBar({ ...base, historyMsgs: 42, historyCap: 60 });
    expect(out.split("\n").length - 1).toBeGreaterThanOrEqual(1);
    expect(out).toContain("▮");
    expect(out).toContain("tok");
    expect(out).toContain("turns");
  });

  it("no history info → no context bar segments", () => {
    setCols(120);
    const out = statusBar(base);
    expect(out).not.toContain("▮");
    expect(out).not.toContain("▯");
    expect(out).toContain("/help");
  });
});
