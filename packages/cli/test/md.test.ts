/** Markdown line renderer tests (deterministic: non-TTY = plain stripping). */
import { describe, expect, it } from "vitest";
import { createMdRenderer } from "../src/md";

describe("createMdRenderer", () => {
  it("strips bold and inline code markers in plain mode", () => {
    const md = createMdRenderer();
    expect(md.feed("parliamo di **loop** e `prompt`")).toBe("parliamo di loop e prompt");
  });

  it("renders headers as plain text without hashes", () => {
    const md = createMdRenderer();
    expect(md.feed("## Titolo")).toBe("Titolo");
  });

  it("converts bullets to typographic dots", () => {
    const md = createMdRenderer();
    expect(md.feed("- prima voce")).toBe("• prima voce");
    expect(md.feed("* seconda voce")).toBe("• seconda voce");
  });

  it("indents fenced code and strips fence markers", () => {
    const md = createMdRenderer();
    md.feed("```python");
    expect(md.feed("def f():")).toBe("  def f():");
    expect(md.feed("```")).toBeDefined();
    expect(md.feed("dopo il fence")).toBe("dopo il fence");
  });

  it("converts links to text (url)", () => {
    const md = createMdRenderer();
    expect(md.feed("vedi [docs](https://x.y)")).toBe("vedi docs (https://x.y)");
  });

  it("flush inline-styles a trailing partial line", () => {
    const md = createMdRenderer();
    expect(md.flush("riga **senza** newline")).toBe("riga senza newline");
  });
});
