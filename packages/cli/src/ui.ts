/**
 * packages/cli/src/ui.ts — zero-dependency ANSI theme for the Elysium CLI.
 *
 * Design language: minimal professional terminal UI (Claude Code / Aider
 * school) — restrained color, typographic hierarchy, NO decorative emoji.
 * Status is conveyed with typographic markers ([ok] [!!] [..]) plus color,
 * so output stays clean, greppable, and screen-reader friendly.
 *
 * No external packages: raw SGR escape codes only. Colors are DISABLED when
 * either NO_COLOR is set (https://no-color.org) or stdout is not a TTY.
 * Disabled mode returns strings untouched, so piped/test output is plain.
 */

/** A function that wraps text in a color (or returns it untouched). */
export type Colorize = (s: string) => string;

const COLORS_ENABLED =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

function colorize(open: string, reset: string): Colorize {
  return (s: string): string => (COLORS_ENABLED ? `\u001B[${open}m${s}\u001B[${reset}m` : s);
}

// ── Semantic palette: every color HAS a role ──
// white  = the model's ANSWER (the star; everything else supports it)
// cyan   = labels, keys, metadata
// dim    = secondary info: thinking, tool details, footers
// green  = success, saved, pass
// yellow = warnings, cancellations, repair
// red    = errors, failures
// magenta = special modes (swarm, agent-to-agent activity)
export const dim = colorize("2", "22");
export const bold = colorize("1", "22");
export const cyan = colorize("36", "39");
export const green = colorize("32", "39");
export const yellow = colorize("33", "39");
export const red = colorize("31", "39");
export const magenta = colorize("35", "39");
export const white = colorize("97", "39");
export const blue = colorize("94", "39");

// ── Fire palette (256-color brand accents — "rosso fuoco") ──
// flame/amber/ember/fire/dRed go bright→deep; used for brand moments
// (wordmark, section titles, prompt, pane headers). Semantic status colors
// (green/yellow/red) stay untouched for pass/warn/fail meaning.
export const fire = colorize("38;5;196", "39");
export const ember = colorize("38;5;202", "39");
export const amber = colorize("38;5;208", "39");
export const flame = colorize("38;5;214", "39");
export const dRed = colorize("38;5;88", "39");

/** Fire wordmark rows for "ELYSIUM" (ANSI-shadow style), bright→deep. */
const FIRE_MARK_ROWS: readonly string[] = [
  "███████╗██╗  ██╗██╗   ██╗███████╗██╗██╗   ██╗███╗   ███╗",
  "██╔════╝╚██╗██╔╝╚██╗ ██╔╝██╔════╝██║██║   ██║████╗ ████║",
  "█████╗   ╚███╔╝  ╚████╔╝ █████╗  ██║██║   ██║██╔████╔██║",
  "██╔══╝   ██╔██╗   ╚██╔╝  ██╔══╝  ██║██║   ██║██║╚██╔╝██║",
  "███████╗██╔╝ ██╗   ██║   ███████╗██║╚██████╔╝██║ ╚═╝ ██║",
  "╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚═╝",
];
const FIRE_MARK_COLORS: readonly Colorize[] = [flame, amber, ember, fire, fire, dRed];

/** Blocky torch emblem for the welcome box left column (no backslashes). */
const FLAME_ART_ROWS: readonly string[] = [
  "   ▄█▄",
  "  ▀███▀",
  "   ███",
  "  ▄███▄",
  " ▄█████▄",
  "██▀███▀██",
  "   ███",
  "  ▄█ █▄",
];
const FLAME_ART_COLORS: readonly Colorize[] = [flame, amber, ember, fire, ember, amber, fire, dRed];

/** Typographic status markers — no emoji, greppable, color-independent. */
export const marks = {
  ok: "[ok]",
  err: "[!!]",
  warn: "[!!]",
  info: "--",
  run: ">>",
  prompt: ">",
} as const;

/** Alias kept for call-site readability: section headers, not decoration. */
export const icons = {
  ok: marks.ok,
  err: marks.err,
  warn: marks.warn,
  info: marks.info,
  spark: "",
  gear: marks.run,
} as const;

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Remove all ANSI SGR sequences from a rendered string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/** Approximate visible width (code points, ANSI stripped) for box math. */
function visualWidth(s: string): number {
  return Array.from(stripAnsi(s)).length;
}

/** Horizontal rule spanning the terminal width (or the given width). */
export function hr(width?: number): string {
  const w = width ?? Math.max(40, (process.stdout.columns ?? 100) - 4);
  return dim("─".repeat(w));
}

/** Aligned "label      value" status line with a 2-space gutter. */
export function kv(label: string, value: string): string {
  return `  ${dim(label.padEnd(12))}${value}`;
}

/**
 * Section header: uppercase label over a rule. Brand-colored (amber).
 */
export function section(title: string): string {
  return `\n  ${bold(amber(title.toUpperCase()))}\n  ${dim("─".repeat(Math.max(24, title.length + 2)))}`;
}

/** Info shown on the welcome screen. */
export interface WelcomeInfo {
  version: string;
  provider: string;
  model: string;
  session: string;
  mode: string;
  workspace: string;
  tools: string[];
  skills: string[];
}

/**
 * Full welcome screen (TTY): fire-gradient wordmark + structured box —
 * torch emblem and model/session on the left, Tools/Skills columns on the
 * right, count footer. Non-TTY: compact plain block (deterministic pipes).
 */
export function welcomeScreen(info: WelcomeInfo): string {
  const head = [
    `Elysium Harness v${info.version} · ${info.provider} · ${info.model}`,
    `session ${info.session}`,
  ];
  if (!COLORS_ENABLED) {
    return [
      "ELYSIUM",
      ...head,
      `tools: ${info.tools.join(" ")} | skills: ${info.skills.join(", ")}`,
    ].join("\n");
  }
  const termW = Math.max(80, process.stdout.columns ?? 100);
  const inner = Math.min(108, termW) - 4;
  const leftW = 16;
  const rightW = inner - leftW - 3;

  // Right column lines.
  const right: string[] = [];
  right.push(`${bold(flame("Tools"))}`);
  right.push(`  ${white(info.tools.join(" · "))}`);
  right.push("");
  right.push(`${bold(flame("Skills"))}`);
  const shown: string[] = [];
  let used = 0;
  for (const s of info.skills) {
    if (used + s.length + 2 > rightW - 2 || shown.length === 6) {
      break;
    }
    shown.push(s);
    used += s.length + 2;
  }
  right.push(
    `  ${dim(shown.join(", "))}${info.skills.length > shown.length ? dim(` +${info.skills.length - shown.length} more`) : ""}`,
  );
  right.push("");
  right.push(
    `  ${dim(`${info.tools.length} tools · ${info.skills.length} skills · /help for commands`)}`,
  );

  // Left column: torch art top, model/session bottom.
  const leftTop = FLAME_ART_ROWS.map((row, i) => FLAME_ART_COLORS[i]?.(row) ?? row);
  const leftBottom = [
    dim(truncatePlain(info.model, leftW - 1)),
    dim(info.session.slice(0, leftW - 1)),
  ];

  const rowLines = Math.max(leftTop.length + 2 + leftBottom.length, right.length);
  const leftAll: string[] = [...leftTop, "", ...leftBottom];
  const row = (l: string, r: string): string => {
    const lp = padRight(l, leftW);
    const rp = padRight(r, rightW);
    return `${dim("│")}${lp}${dim(" │ ")}${rp}${dim("│")}`;
  };
  const topTitle = `╭─ ${bold(flame(`Elysium Harness v${info.version}`))} `;
  const topRest = Math.max(0, inner + 2 - stripAnsi(topTitle).length);
  return [
    ...FIRE_MARK_ROWS.map((row2, i) => FIRE_MARK_COLORS[i]?.(row2) ?? row2),
    "",
    `${topTitle}${dim("─".repeat(topRest))}╮`,
    ...Array.from({ length: rowLines }, (_, i) => row(leftAll[i] ?? "", right[i] ?? "")),
    dim(`╰${"─".repeat(inner + 2)}╯`),
  ].join("\n");
}

/**
 * One-line inverted status strip (dark-red bg, flame fg). Non-TTY: empty.
 * Call again (e.g. after /status or a turn) to print a refreshed one.
 */
export function statusBar(info: {
  model: string;
  mode: string;
  tokens: number;
  turns: number;
}): string {
  if (!COLORS_ENABLED) return "";
  const termW = Math.max(60, process.stdout.columns ?? 100);
  const text = `  ◆ ${info.model} · ${info.mode} · ${info.tokens} tok · ${info.turns} turns · /help `;
  const visible = stripAnsi(text).length;
  const pad = " ".repeat(Math.max(0, termW - visible));
  return `\u001B[48;5;52m\u001B[38;5;214m${text}${pad}\u001B[0m`;
}

function truncatePlain(s: string, w: number): string {
  return s.length <= w ? s : `${s.slice(0, Math.max(1, w - 1))}…`;
}

function padRight(s: string, w: number): string {
  const visible = stripAnsi(s).length;
  return visible >= w ? s : `${s}${" ".repeat(w - visible)}`;
}

/**
 * Wordmark banner: rounded box, bold wordmark, dim tagline — restrained
 * (Raycast/Linear school: one box, no noise). Non-TTY: plain two lines so
 * piped/test output stays deterministic.
 */
export function box(title: string, subtitle = ""): string {
  if (!COLORS_ENABLED) {
    return [title, subtitle].filter((l) => l.length > 0).join("\n");
  }
  const termW = Math.max(40, (process.stdout.columns ?? 100) - 4);
  const inner = Math.min(64, termW) - 2;
  const row = (content: string): string => {
    const pad = Math.max(0, inner - visualWidth(content));
    return `${dim("│")}${content}${" ".repeat(pad)}${dim("│")}`;
  };
  return [
    dim(`╭${"─".repeat(inner)}╮`),
    row(`  ${bold(white(title))}`),
    ...(subtitle.length > 0 ? [row(`  ${dim(subtitle)}`)] : []),
    dim(`╰${"─".repeat(inner)}╯`),
  ].join("\n");
}

// ── Spinner ───────────────────────────────────────────────────────

/** Thinking spinner: orbiting dot around a center dot (thinking = orbit). */
const THINKING_FRAMES: readonly string[] = [
  "⠋ ⠁",
  "⠙ ⠉",
  "⠹ ⠙",
  "⠸ ⠜",
  "⠼ ⠣",
  "⠴ ⠡",
  "⠦ ⠋",
  "⠧ ⠇",
  "⠇ ⠏",
  "⠏ ⠋",
];

export interface Spinner {
  /** Begin animating `text`. No-op when output is not an animated TTY. */
  start(text: string): void;
  /** Stop animating; clear the frame line, then optionally print an outcome. */
  stop(okText?: string, errText?: string): void;
}

/**
 * Braille spinner on process.stdout.write + setInterval (the interval is
 * always cleared on stop, and unref'd so it never holds the process open).
 * Non-TTY: start() prints nothing and stop() only prints an outcome, so
 * piped/test output stays deterministic.
 */
export function spinner(frames: readonly string[] = THINKING_FRAMES): Spinner {
  const animated = COLORS_ENABLED;
  let timer: NodeJS.Timeout | null = null;
  let index = 0;
  let current = "";

  const clearLine = (): void => {
    if (animated) process.stdout.write("\r\u001B[K");
  };
  const render = (): void => {
    process.stdout.write(`\r\u001B[K  ${dim(frames[index] ?? "")} ${dim(current)}`);
  };

  return {
    start(text: string): void {
      current = text;
      if (!animated || timer !== null) return;
      render();
      timer = setInterval(() => {
        index = (index + 1) % frames.length;
        render();
      }, 80);
      timer.unref();
    },
    stop(okText?: string, errText?: string): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (animated) clearLine();
      if (okText !== undefined) console.log(`  ${green(marks.ok)} ${okText}`);
      else if (errText !== undefined) console.log(`  ${red(marks.err)} ${errText}`);
    },
  };
}

/**
 * Thinking spinner: a small "orbit" — a cyan rotating braille core with an
 * orbiting dim dot and a live elapsed-seconds counter. Reads as "the model
 * is thinking", not as a generic progress bar.
 * Non-TTY: renders nothing while running (deterministic piped output).
 */
export function thinkingSpinner(): Spinner {
  const ORBIT: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const animated = COLORS_ENABLED;
  let timer: NodeJS.Timeout | null = null;
  let index = 0;
  let text = "";
  let startedAt = 0;

  const render = (): void => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const t = secs > 0 ? ` ${secs}s` : "";
    process.stdout.write(
      `\r\u001B[K  ${cyan(ORBIT[index] ?? "")} ${dim("thinking" + t + " — Esc to cancel")}`,
    );
  };

  return {
    start(t: string): void {
      text = t;
      startedAt = Date.now();
      if (!animated || timer !== null) return;
      render();
      timer = setInterval(() => {
        index = (index + 1) % ORBIT.length;
        render();
      }, 90);
      timer.unref();
    },
    stop(okText?: string, errText?: string): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (animated) process.stdout.write("\r\u001B[K");
      if (okText !== undefined) console.log(`  ${green(marks.ok)} ${okText}`);
      else if (errText !== undefined) console.log(`  ${red(marks.err)} ${errText}`);
    },
  };
}

// ── Provider error translation ────────────────────────────────────

export interface TranslatedError {
  /** Short human headline (rendered big). */
  title: string;
  /** Actionable next step; rendered as `title - hint`. */
  hint: string;
  /** Raw provider detail, single-line, truncated to 120 chars (rendered dim). */
  detail: string;
}

/** Flatten an error plus its `cause` chain (max depth 5) into one string. */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const code = (cur as NodeJS.ErrnoException).code;
      if (typeof code === "string") parts.push(code);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * Map a provider/fetch failure to a human message BEFORE printing.
 * Detection runs on the full message+cause chain so wrapped provider
 * errors (`openai-compatible HTTP 429: {"error":{"code":1113,...}}`,
 * undici "fetch failed", errno codes) all translate correctly.
 */
export function translateProviderError(err: unknown): TranslatedError {
  const chain = errorChainText(err);
  const first = err instanceof Error ? err.message : String(err);
  const detail = first.replace(/\s+/g, " ").trim().slice(0, 120);
  const hay = chain.toLowerCase();

  const is429 = /\b429\b/.test(hay);
  const outOfCredits = /\b1113\b/.test(hay) || /balance|insufficient|余额|不足/.test(chain);
  if (is429 && outOfCredits) {
    return {
      title: "Provider account out of credits",
      hint: "recharge or /model <another>",
      detail,
    };
  }
  if (is429) {
    return { title: "Rate limited", hint: "wait or switch provider", detail };
  }
  if (/\b(?:401|403)\b/.test(hay)) {
    return {
      title: "Invalid or unauthorized API key",
      hint: "check /key <provider> <key>",
      detail,
    };
  }
  if (/\b404\b/.test(hay)) {
    return { title: "Model not found", hint: "/model <provider> <model>", detail };
  }
  if (
    /(fetch failed|enotfound|econnrefused|econnreset|eai_again|etimedout|request failed|network)/.test(
      hay,
    )
  ) {
    return { title: "Cannot reach the provider host", hint: "check connection", detail };
  }
  return { title: "Provider error", hint: "check /connections and retry", detail };
}
