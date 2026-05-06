// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "../src/primitives/markdown-preview.js";
import { restoreMatchMedia, setupMatchMedia } from "./helpers/match-media.js";

type ClipboardWriteText = (text: string) => Promise<void>;

function installClipboardWriteTextMock() {
  const writeText = vi.fn<ClipboardWriteText>();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  restoreMatchMedia();
  vi.clearAllMocks();
});

describe("MarkdownPreview", () => {
  it("renders GFM content as Markdown elements", () => {
    render(
      <MarkdownPreview
        content={[
          "# Storage Notes",
          "",
          "- [x] shipped",
          "",
          "| File | State |",
          "| --- | --- |",
          "| notes.md | done |",
        ].join("\n")}
      />,
    );

    expect(screen.getByRole("heading", { name: "Storage Notes" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("notes.md")).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("does not render raw HTML as DOM", () => {
    const { container } = render(
      <MarkdownPreview content={"# Safe\n\n<script>alert('x')</script>"} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert('x')</script>");
  });

  it("lets callers intercept local file links without changing other links", () => {
    const onOpenLocalFileLink = vi.fn(() => true);
    render(
      <MarkdownPreview
        content={
          "[Open file](/workspace/src/app.ts:12) [Docs](https://example.test)"
        }
        onOpenLocalFileLink={onOpenLocalFileLink}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open file" }));
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledTimes(1);
    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 12,
      path: "/workspace/src/app.ts",
    });
  });

  it("renders inline code and block code with copy affordance", () => {
    const writeText = installClipboardWriteTextMock();
    render(
      <MarkdownPreview
        content={[
          "Run `pnpm test` before merging.",
          "",
          "```ts",
          "const value = 1;",
          "```",
        ].join("\n")}
      />,
    );

    expect(screen.getByText("pnpm test").tagName).toBe("CODE");
    expect(screen.getByText("const value = 1;").tagName).toBe("CODE");

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(writeText).toHaveBeenCalledWith("const value = 1;");
  });

  it("opens Markdown images in the lightbox and navigates between them", () => {
    setupMatchMedia();
    render(
      <MarkdownPreview
        content={[
          "![One](https://example.test/one.png)",
          "![Two](https://example.test/two.png)",
        ].join("\n")}
      />,
    );

    fireEvent.click(screen.getByRole("img", { name: "One" }));

    expect(
      screen.getByRole("img", { name: "Expanded image" }).getAttribute("src"),
    ).toBe("https://example.test/one.png");

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(
      screen.getByRole("img", { name: "Expanded image" }).getAttribute("src"),
    ).toBe("https://example.test/two.png");

    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(
      screen.getByRole("img", { name: "Expanded image" }).getAttribute("src"),
    ).toBe("https://example.test/one.png");
  });
});
