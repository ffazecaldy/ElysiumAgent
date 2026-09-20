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

/** Selectable UI theme: 'matrix' (brand palette) or 'mono' (brand → plain). */
export type Theme = "matrix" | "mono";

/** Module-level theme state; default 'matrix'. */
let activeTheme: Theme = "matrix";

/**
 * Switch the UI theme. In 'mono' the BRAND colorizers render plain text;
 * semantic status colors (green/yellow/red/dim/bold/white) are unchanged.
 * The COLORS_ENABLED gate still wins: when colors are disabled everything
 * stays plain regardless of theme.
 */
export function setTheme(theme: Theme): void {
  activeTheme = theme;
}

/** Current theme (module-level state). */
export function currentTheme(): Theme {
  return activeTheme;
}

function colorize(open: string, reset: string, brand = false): Colorize {
  return (s: string): string => {
    if (!COLORS_ENABLED) return s;
    if (brand && activeTheme === "mono") return s;
    return `\u001B[${open}m${s}\u001B[${reset}m`;
  };
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
export const cyan = colorize("36", "39", true);
export const green = colorize("32", "39");
export const yellow = colorize("33", "39");
export const red = colorize("31", "39");
export const magenta = colorize("35", "39", true);
export const white = colorize("97", "39");
export const blue = colorize("94", "39", true);

// ── Matrix palette (256-color brand accents — verde neon su nero) ──
// neon/lime/moss/pine/dGreen go bright→deep; used for brand moments
// (wordmark, section titles, prompt, pane headers). Semantic status colors
// (green/yellow/red) stay untouched for pass/warn/fail meaning.
export const neon = colorize("38;5;46", "39", true);
export const lime = colorize("38;5;40", "39", true);
export const moss = colorize("38;5;34", "39", true);
export const pine = colorize("38;5;28", "39", true);
export const dGreen = colorize("38;5;22", "39", true);

/** Shadow-font glyphs (verified spelling) used by {@link renderWordmark}. */
const SHADOW_LETTERS: Record<string, readonly string[]> = {
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  Y: ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  M: ["███╗   ███╗", "████╗ ████║", "██╔████╔██║", "██║╚██╔╝██║", "██║ ╚═╝ ██║", "╚═╝     ╚═╝"],
};
const WORDMARK_COLORS: readonly Colorize[] = [neon, lime, moss, pine, pine, dGreen];

/** Renders `text` as ANSI-shadow rows with the matrix gradient. */
function renderWordmark(text: string): string[] {
  const rows = ["", "", "", "", "", ""];
  for (const ch of text.toUpperCase()) {
    const glyph = SHADOW_LETTERS[ch];
    if (glyph === undefined) continue;
    for (let i = 0; i < 6; i += 1) rows[i] += `${glyph[i] ?? ""} `;
  }
  return rows.map((r, i) => WORDMARK_COLORS[i]?.(r.trimEnd()) ?? r);
}

/** Binary-rain art (static) shown in the welcome box left column. */
const BINARY_ART_ROWS: readonly string[] = [
  "1 0 1 1 0 1",
  "0 1 0 0 1 0",
  "1 1 0 1 0 0",
  "0 0 1 0 1 1",
  "1 0 1 0 0 1",
  "0 1 0 1 1 0",
  "1 0 0 1 0 1",
  "0 1 1 0 1 0",
];
const BINARY_ART_COLORS: readonly Colorize[] = [neon, pine, lime, moss, neon, pine, lime, dGreen];

/**
 * Digital rain intro: a small block of falling 0/1 columns played once at
 * startup ("matrix" style), in place, then cleared so the welcome screen
 * prints cleanly below the wordmark. TTY-only and skipped entirely when
 * ELYSIUM_RAIN_MS=0. Resolves when the block is cleared.
 */
export function playRainIntro(opts: { rows?: number; ms?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    if (!COLORS_ENABLED) {
      resolve();
      return;
    }
    const envMs = Number(process.env.ELYSIUM_RAIN_MS);
    const ms =
      process.env.ELYSIUM_RAIN_MS === "0"
        ? 0
        : Math.max(250, Number.isFinite(envMs) && envMs > 0 ? envMs : (opts.ms ?? 1100));
    if (ms <= 0) {
      resolve();
      return;
    }
    const rows = Math.max(4, opts.rows ?? 8);
    const cols = 6;
    const speeds = [1, 2, 1, 3, 2, 1];
    const offsets = [0, 4, 8, 2, 6, 10];
    let tick = 0;
    let painted = 0;
    let timer: NodeJS.Timeout | null = null;
    const bit = (): string => (Math.random() < 0.5 ? "0" : "1");

    const clearBlock = (): string => (painted > 0 ? `\u001B[${painted}A\r\u001B[J` : "");

    const render = (): void => {
      let out = painted > 0 ? `\u001B[${painted}A\r` : "";
      for (let r = 0; r < rows; r += 1) {
        let line = " ";
        for (let c = 0; c < cols; c += 1) {
          // Dense rain: every cell always shows a bit; brightness decays
          // with distance from the column head (classic matrix look from
          // frame one — no half-empty blocks on early ticks).
          const head = ((offsets[c] ?? 0) + tick * (speeds[c] ?? 1)) % (rows + 3);
          const delta = (head - r + rows + 3) % (rows + 3);
          let cell = `${dGreen(bit())} `;
          if (delta === 0) cell = `${neon(bit())} `;
          else if (delta === 1) cell = `${lime(bit())} `;
          else if (delta === 2) cell = `${moss(bit())} `;
          line += cell;
        }
        out += `\u001B[K${line.trimEnd()}\n`;
      }
      painted = rows;
      process.stdout.write(out);
    };

    render();
    // NOTE: deliberately NOT unref'd — at startup nothing else may keep the
    // loop alive, and an unref'd timer would let the process exit mid-rain.
    // The interval is always cleared on completion below.
    timer = setInterval(() => {
      tick += 1;
      render();
      if (tick * 70 >= ms) {
        if (timer !== null) clearInterval(timer);
        timer = null;
        process.stdout.write(clearBlock());
        resolve();
      }
    }, 70);
  });
}

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

// ESC built at runtime: a literal control char in the regex trips
// noControlCharactersInRegex; String.fromCharCode keeps the pattern exact.
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

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
 * Section header: uppercase label over a rule. Brand-colored (neon).
 */
export function section(title: string): string {
  return `\n  ${bold(neon(title.toUpperCase()))}\n  ${dim("─".repeat(Math.max(24, title.length + 2)))}`;
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
 * Full welcome screen (TTY): matrix-gradient wordmark + structured box —
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
  right.push(`${bold(lime("Tools"))}`);
  right.push(`  ${white(info.tools.join(" · "))}`);
  right.push("");
  right.push(`${bold(lime("Skills"))}`);
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

  // Left column: binary rain art top, model/session bottom.
  const leftTop = BINARY_ART_ROWS.map((rowTxt, i) => BINARY_ART_COLORS[i]?.(rowTxt) ?? rowTxt);
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
  const topTitle = `╭─ ${bold(lime(`Elysium Harness v${info.version}`))} `;
  const topRest = Math.max(0, inner + 2 - stripAnsi(topTitle).length);
  return [
    ...renderWordmark("ELYSIUM"),
    "",
    `${topTitle}${dim("─".repeat(topRest))}╮`,
    ...Array.from({ length: rowLines }, (_, i) => row(leftAll[i] ?? "", right[i] ?? "")),
    dim(`╰${"─".repeat(inner + 2)}╯`),
  ].join("\n");
}

/** 8-slot context-window bar: ▮ used / ▯ free, color-coded by pressure. */
function contextBar(msgs?: number, cap?: number): string {
  if (msgs === undefined || cap === undefined || cap <= 0) return "";
  const pct = Math.min(1, Math.max(0, msgs / cap));
  const filled = Math.min(8, Math.max(0, Math.round(pct * 8)));
  const blocks = "▮".repeat(filled) + "▯".repeat(8 - filled);
  const tint = pct >= 0.9 ? red : pct >= 0.7 ? yellow : green;
  return tint(`[${blocks}]`);
}

/**
 * Inverted status strip (dark-green bg, neon fg), width-aware: on wide
 * terminals (>=100 col) one line — `◆ model · mode · [context] · tok ·
 * turns · +A/−R · /help`; below that it packs on two lines (identity row,
 * counters row). Non-TTY: plain unpadded text, deterministic and greppable.
 * Call again (e.g. after /status or a turn) to print a refreshed one.
 */
export function statusBar(info: {
  model: string;
  mode: string;
  tokens: number;
  turns: number;
  /** Conversation messages vs context cap → drives the 8-slot ▮/▯ bar. */
  historyMsgs?: number;
  historyCap?: number;
  /** Diff counters; rendered as `+added/−removed` only when present. */
  added?: number;
  removed?: number;
}): string {
  const bar = contextBar(info.historyMsgs, info.historyCap);
  const diff =
    info.added === undefined && info.removed === undefined
      ? ""
      : `+${info.added ?? 0}/−${info.removed ?? 0}`;
  const head = [`◆ ${info.model}`, info.mode, bar].filter((s) => s.length > 0);
  const tail = [`${info.tokens} tok`, `${info.turns} turns`, diff, "/help"].filter(
    (s) => s.length > 0,
  );
  const termW = Math.max(60, process.stdout.columns ?? 100);
  const join = (segs: string[]): string => `  ${segs.join(" · ")} `;
  const paint = (text: string): string => {
    if (!COLORS_ENABLED) return text.trimEnd();
    const pad = " ".repeat(Math.max(0, termW - stripAnsi(text).length));
    return `\u001B[48;5;22m\u001B[38;5;46m${text}${pad}\u001B[0m`;
  };
  if (termW >= 100) return paint(join([...head, ...tail]));
  return [paint(join(head)), paint(join(tail))].join("\n");
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

// ── Dynamic help ──────────────────────────────────────────────────

/** One help entry: name, signature, one-line description, maturity. */
export interface HelpEntry {
  name: string;
  signature: string;
  description: string;
  group: string;
  maturity: "stable" | "beta" | "planned";
}

/**
 * Single source of truth for `/help` (and for future command registration):
 * stable commands are rendered grouped, `planned` ones land in "In arrivo"
 * so the roadmap is discoverable from the CLI itself.
 */
export const HELP_CATALOG: readonly HelpEntry[] = [
  {
    name: "/help",
    signature: "/help [parola]",
    description: "Questo help — filtra per parola",
    group: "REPL",
    maturity: "stable",
  },
  {
    name: "/clear",
    signature: "/clear",
    description: "Pulisci lo schermo",
    group: "REPL",
    maturity: "stable",
  },
  { name: "/quit", signature: "/quit", description: "Esci", group: "REPL", maturity: "stable" },
  {
    name: "/status",
    signature: "/status",
    description: "Provider, modello, token, uptime",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/mode",
    signature: "/mode [min|medium|high|max]",
    description: "Intensità di effort (default medium)",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/history",
    signature: "/history",
    description: "Prompt di questa sessione",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/save",
    signature: "/save",
    description: "Transcript markdown nel workspace",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/clear-chat",
    signature: "/clear-chat",
    description: "Resetta la conversazione",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/model",
    signature: "/model [provider] [model]",
    description: "Mostra o cambia provider/modello",
    group: "Provider",
    maturity: "stable",
  },
  {
    name: "/key",
    signature: "/key <provider> <key>",
    description: "Salva una API key in .env",
    group: "Provider",
    maturity: "stable",
  },
  {
    name: "/connections",
    signature: "/connections",
    description: "Tabella stato provider",
    group: "Provider",
    maturity: "stable",
  },
  {
    name: "/swarm",
    signature: "/swarm <goal>",
    description: "Gauntlet multi-agente con vista live",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/skills",
    signature: "/skills",
    description: "Skill indicizzate nel prompt",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/tools",
    signature: "/tools",
    description: "Tool registrati",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/workspace",
    signature: "/workspace",
    description: "Percorso del workspace",
    group: "Agent",
    maturity: "stable",
  },
  // — Promosso a stabile: implementato —
  {
    name: "/plan",
    signature: "/plan <goal>",
    description: "Piano (subtask + criteria) senza eseguire",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/review",
    signature: "/review [path]",
    description: "Code review guidata sul diff corrente",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/cost",
    signature: "/cost",
    description: "Token di sessione (in/out/total)",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/memory",
    signature: "/memory [nota|clear]",
    description: "Note operatore persistenti nel prompt",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/export",
    signature: "/export [md|json]",
    description: "Export della sessione",
    group: "Sessione",
    maturity: "stable",
  },
  {
    name: "/mcp",
    signature: "/mcp",
    description: "Server MCP da .mcp.json e loro tool",
    group: "Provider",
    maturity: "stable",
  },
  // — In arrivo: la roadmap è visibile dentro la CLI —
  {
    name: "/agents",
    signature: "/agents",
    description: "Stato subagent e cronologia conversazione",
    group: "Agent",
    maturity: "stable",
  },
  {
    name: "/theme",
    signature: "/theme [matrix|mono]",
    description: "Palette della CLI",
    group: "REPL",
    maturity: "stable",
  },
];

/**
 * Dynamic help screen: `query` (optional) filters by substring on
 * name+description. Stable commands grouped by section; planned ones in
 * "In arrivo" with a progress glyph. Deterministic in non-TTY too.
 */
export function helpScreen(query: string): string {
  const q = query.trim().toLowerCase();
  const match = (e: HelpEntry): boolean =>
    q.length === 0 ||
    e.name.includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.group.toLowerCase().includes(q);
  const lines: string[] = [];
  const stable = HELP_CATALOG.filter((e) => e.maturity !== "planned" && match(e));
  const planned = HELP_CATALOG.filter((e) => e.maturity === "planned" && match(e));
  lines.push(q.length > 0 ? `\n  ${neon(`help — filtro: "${q}"`)}` : `\n  ${neon("COMANDI")}`);
  if (stable.length === 0 && planned.length === 0) {
    lines.push(`  ${dim("nessun comando matcha — prova un'altra parola")}`);
    return lines.join("\n");
  }
  const groups = [...new Set(stable.map((e) => e.group))];
  for (const g of groups) {
    lines.push(`\n  ${bold(lime(g))}`);
    for (const e of stable.filter((x) => x.group === g)) {
      const args = e.signature.startsWith(e.name)
        ? e.signature.slice(e.name.length).trim()
        : e.signature;
      lines.push(`    ${neon(e.name.padEnd(12))} ${dim(args.padEnd(26))}${e.description}`);
    }
  }
  if (planned.length > 0) {
    lines.push(`\n  ${bold(neon("IN ARRIVO"))}  ${dim("survey in corso — quale vuoi prima?")}`);
    for (const e of planned) {
      const args = e.signature.startsWith(e.name)
        ? e.signature.slice(e.name.length).trim()
        : e.signature;
      lines.push(
        `    ${dim("··")} ${dim(e.name.padEnd(12))} ${dim(args.padEnd(26))}${dim(e.description)}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

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
      `\r\u001B[K  ${cyan(ORBIT[index] ?? "")} ${dim(`thinking${t} — Esc to cancel`)}`,
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
