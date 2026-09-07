// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

const katexChunkLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("./markdown-katex.js", async (importOriginal) => {
  katexChunkLoads.count += 1;
  return importOriginal();
});

afterEach(() => {
  cleanup();
});

describe("MarkdownPreview lazy KaTeX", () => {
  it("does not load the KaTeX chunk for content without $$ math", async () => {
    const { container } = render(
      <MarkdownPreview
        content={"Plain prose with $5 and $x$ and \\$10 escaped."}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(katexChunkLoads.count).toBe(0);
    expect(container.textContent).toContain("$5");
  });

  it("loads the chunk once and re-renders every mounted preview with KaTeX", async () => {
    const first = render(<MarkdownPreview content={"One: $$a^2$$"} />);
    const second = render(<MarkdownPreview content={"Two: $$b^2$$"} />);

    await waitFor(() => {
      expect(first.container.querySelector(".katex")).not.toBeNull();
      expect(second.container.querySelector(".katex")).not.toBeNull();
    });
    expect(katexChunkLoads.count).toBe(1);

    const third = render(<MarkdownPreview content={"Three: $$c^2$$"} />);
    expect(third.container.querySelector(".katex")).not.toBeNull();
    expect(katexChunkLoads.count).toBe(1);
  });
});
