/**
 * Tests for the dynamic help screen and the switchable matrix/mono theme.
 * Run in non-TTY (vitest) so output is plain and deterministic; the theme
 * switch must therefore never crash and must restore correctly.
 */
import { afterEach, describe, expect, it } from "vitest";
import { currentTheme, helpScreen, setTheme } from "../src/ui";

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
