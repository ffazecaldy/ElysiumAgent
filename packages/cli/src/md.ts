/**
 * packages/cli/src/md.ts — line-based markdown → ANSI renderer for the REPL.
 *
 * The model answers in markdown; raw terminals show literal `**` and
 * backticks. This renderer transforms one COMPLETE line at a time (stateful
 * across lines for ``` fences) so the streaming path can feed it as lines
 * arrive. In non-TTY/piped mode it degrades to plain-text stripping —
 * deterministic output for tests.
 */

import { bold, dim, neon } from "./ui";

export interface MdRenderer {
  /** Feed one complete line (no trailing newline); returns the rendered line. */
  feed(line: string): string;
  /** Flush a trailing partial line (no newline arrived); inline-styled only. */
  flush(line: string): string;
}

const color = (): boolean => process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

/** Inline transforms: bold, inline code, links. */
function inline(s: string, styled: boolean): string {
  if (!styled) {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  }
  return s
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t))
    .replace(/__([^_]+)__/g, (_, t: string) => bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => neon(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => `${t} ${dim(`(${u})`)}`);
}

/**
 * Creates a stateful line renderer. Handles: fenced code blocks (indented,
 * fence markers dimmed), ATX headers (bold), `-`/`*` bullets (typographic
 * `•`), blockquotes (dim bar), bold/inline-code/links. Everything else
 * passes through with inline transforms.
 */
export function createMdRenderer(): MdRenderer {
  let inFence = false;
  const feed = (line: string): string => {
    const styled = color();
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return styled ? dim(line.trim()) : line.trim();
    }
    if (inFence) return `  ${line}`;
    const header = /^#{1,6}\s+(.*)$/.exec(line);
    if (header !== null) {
      const text = header[1] ?? "";
      return styled ? bold(text) : text;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "", styled)}`;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      const text = inline(quote[1] ?? "", styled);
      return styled ? dim(`▏ ${text}`) : `> ${text}`;
    }
    return inline(line, styled);
  };
  const flush = (line: string): string => inline(line, color());
  return { feed, flush };
}
