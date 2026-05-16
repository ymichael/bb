// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import {
  restoreMatchMedia,
  setupMatchMedia,
} from "@/test/helpers/match-media.js";
import { setPreferredTheme } from "@/hooks/useTheme";

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
  setPreferredTheme("system");
  document.documentElement.classList.remove("dark");
  restoreMatchMedia();
  vi.clearAllMocks();
});

describe("MarkdownPreview", () => {
  it("does not render raw HTML by default", () => {
    const { container } = render(
      <MarkdownPreview content="<span>Inline HTML</span>" />,
    );

    expect(container.querySelector("span")).toBeNull();
  });

  it("renders sanitized raw HTML when explicitly allowed", () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={[
          "Line one<br />line two",
          '<details open><summary>More</summary><div onmouseover="alert(1)">Body</div></details>',
          "<script>alert(1)</script>",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("br")).not.toBeNull();
    expect(screen.getByText("More").tagName).toBe("SUMMARY");
    expect(screen.getByText("Body").tagName).toBe("DIV");
    expect(screen.getByText("Body").getAttribute("onmouseover")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("alert(1)")).toBeNull();
  });

  it("strips unsafe links, image handlers, and embedded HTML", () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={[
          '<a href="javascript:alert(1)">Unsafe link</a>',
          '<img alt="Unsafe image" src="https://example.test/image.png" onerror="alert(1)" />',
          '<iframe src="https://example.test/embed"></iframe>',
          "<style>body { display: none; }</style>",
        ].join("\n")}
      />,
    );

    const link = screen.getByText("Unsafe link").closest("a");
    const image = screen.getByRole("img", { name: "Unsafe image" });

    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBeNull();
    expect(image.getAttribute("src")).toBe("https://example.test/image.png");
    expect(image.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
  });

  it("resolves raw HTML picture sources and preserves layout attributes", () => {
    setupMatchMedia();
    setPreferredTheme("dark");

    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={[
          '<p align="center">',
          "<picture>",
          '  <source media="(prefers-color-scheme: dark)" srcset="https://example.test/dark.png">',
          '  <source media="(prefers-color-scheme: light)" srcset="https://example.test/light.png">',
          '  <img alt="bb" src="https://example.test/light.png" width="128">',
          "</picture>",
          "</p>",
        ].join("\n")}
      />,
    );

    const image = screen.getByRole("img", { name: "bb" });
    const paragraph = image.closest("p");
    const sourceElements = Array.from(container.querySelectorAll("source"));
    const darkSource = sourceElements.find(
      (sourceElement) =>
        sourceElement.getAttribute("srcset") ===
        "https://example.test/dark.png",
    );
    const lightSource = sourceElements.find(
      (sourceElement) =>
        sourceElement.getAttribute("srcset") ===
        "https://example.test/light.png",
    );

    expect(paragraph?.getAttribute("align")).toBe("center");
    expect(image.getAttribute("width")).toBe("128");
    expect(darkSource?.getAttribute("media")).toBe("all");
    expect(lightSource?.getAttribute("media")).toBe("not all");
  });

  it("routes local file link clicks through the handler and prevents default navigation", () => {
    const onOpenLocalFileLink = vi.fn(() => true);
    render(
      <MarkdownPreview
        content="[Open absolute](/workspace/src/app.ts:12)"
        onOpenLocalFileLink={onOpenLocalFileLink}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open absolute" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledTimes(1);
    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 12,
      path: "/workspace/src/app.ts",
    });
  });

  it("leaves anchors untouched when no local file handler is supplied", () => {
    render(
      <MarkdownPreview content="[Open absolute](/workspace/src/app.ts:12)" />,
    );

    expect(
      screen.getByRole("link", { name: "Open absolute" }).getAttribute("href"),
    ).toBe("/workspace/src/app.ts:12");
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

  it("opens the clicked image in the lightbox", () => {
    setupMatchMedia();
    render(
      <MarkdownPreview
        content={[
          "![One](https://example.test/one.png)",
          "![Two](https://example.test/two.png)",
        ].join("\n")}
      />,
    );

    fireEvent.click(screen.getByRole("img", { name: "Two" }));

    expect(
      screen.getByRole("img", { name: "Expanded image" }).getAttribute("src"),
    ).toBe("https://example.test/two.png");
  });

  it("opens the clicked HTML image in the lightbox", () => {
    setupMatchMedia();
    render(
      <MarkdownPreview
        allowHtml
        content={[
          '<img alt="First" src="https://example.test/first.png">',
          '<img alt="Second" src="https://example.test/second.png">',
        ].join("\n")}
      />,
    );

    fireEvent.click(screen.getByRole("img", { name: "Second" }));

    expect(
      screen.getByRole("img", { name: "Expanded image" }).getAttribute("src"),
    ).toBe("https://example.test/second.png");
  });
});
