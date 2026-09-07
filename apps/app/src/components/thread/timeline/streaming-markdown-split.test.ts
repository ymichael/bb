import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "./streaming-markdown-split";

function expectSplit(text: string, settled: string) {
  const split = splitStreamingMarkdown(text);
  expect(split).not.toBeNull();
  expect(split?.settled).toBe(settled);
  expect(split?.tail).toBe(text.slice(settled.length));
  expect(`${split?.settled}${split?.tail}`).toBe(text);
}

describe("splitStreamingMarkdown", () => {
  it("returns null when there is no blank line followed by a complete line", () => {
    expect(splitStreamingMarkdown("")).toBeNull();
    expect(splitStreamingMarkdown("Only one paragraph so far")).toBeNull();
    expect(splitStreamingMarkdown("Para one.\n\nPara two still")).toBeNull();
    expect(splitStreamingMarkdown("\n\nleading blanks\n")).toBeNull();
  });

  it("splits at the last blank line whose next line is complete", () => {
    expectSplit("Para one.\n\nPara two.\n\nPara three", "Para one.\n\n");
    expectSplit(
      "Para one.\n\nPara two.\n\nPara three.\nmore",
      "Para one.\n\nPara two.\n\n",
    );
  });

  it("only moves the boundary forward as text streams in", () => {
    const chunks = [
      "# Title\n",
      "\n",
      "Intro paragraph.\n",
      "\n",
      "```ts\n",
      "const a = 1;\n",
      "\n",
      "const b = 2;\n",
      "```\n",
      "\n",
      "1. first\n",
      "\n",
      "2. second\n",
      "\n",
      "Closing",
      " words.\n",
      "\n",
      "Done.\n",
    ];
    let text = "";
    let previousSettledLength = 0;
    for (const chunk of chunks) {
      text += chunk;
      const split = splitStreamingMarkdown(text);
      const settledLength = split?.settled.length ?? 0;
      expect(settledLength).toBeGreaterThanOrEqual(previousSettledLength);
      if (split !== null) {
        expect(text.startsWith(split.settled)).toBe(true);
      }
      previousSettledLength = settledLength;
    }
  });

  it("does not split inside an open fenced code block", () => {
    const text = "Intro.\n\n```js\nline one\n\nline two\n\nline three\n";
    expectSplit(text, "Intro.\n\n");
    const closed = `${text}\`\`\`\n\nAfter the fence.\n`;
    expectSplit(
      closed,
      "Intro.\n\n```js\nline one\n\nline two\n\nline three\n```\n\n",
    );
  });

  it("requires the closing fence to match the opening marker", () => {
    const text = "Intro.\n\n````md\n```\ninner\n```\n\ntext\n";
    expectSplit(text, "Intro.\n\n");
    const tilde = "Intro.\n\n~~~\n```\n\nx\n";
    expectSplit(tilde, "Intro.\n\n");
  });

  it("does not split inside an open $$ math block", () => {
    const text = "Formula:\n\n$$\na = b\n\nc = d\n";
    expectSplit(text, "Formula:\n\n");
    const closed = `${text}$$\n\nDone.\n`;
    expectSplit(closed, "Formula:\n\n$$\na = b\n\nc = d\n$$\n\n");
  });

  it("treats inline $$x$$ spans as closed math", () => {
    expectSplit(
      "Price is $$x$$ here.\n\nNext para.\n\nTail\n",
      "Price is $$x$$ here.\n\nNext para.\n\n",
    );
  });

  it("does not split between items of a loose list or before indented continuation", () => {
    expectSplit(
      "Intro.\n\n- one\n\n- two\n\n- three\n\nAfter list.\n",
      "Intro.\n\n- one\n\n- two\n\n- three\n\n",
    );
    expectSplit(
      "Intro.\n\n1. one\n\n   continued\n\n2. two\n\nAfter.\n",
      "Intro.\n\n1. one\n\n   continued\n\n2. two\n\n",
    );
  });

  it("splits before a heading that follows a blank line", () => {
    const split = splitStreamingMarkdown("Intro text.\n\n## Section\n\nBody");
    expect(split?.settled).toBe("Intro text.\n\n");
    expect(split?.tail).toBe("## Section\n\nBody");
    expectSplit(
      "Intro text.\n\n## Section\n\nBody paragraph.\n\nMore",
      "Intro text.\n\n## Section\n\n",
    );
  });
});
