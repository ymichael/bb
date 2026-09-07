// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginOverviewMarkdown } from "./PluginOverviewMarkdown";

afterEach(cleanup);

const HOSTILE_MARKDOWN = [
  "# Heading",
  "",
  "<script>window.pwned = true</script>",
  "",
  'Text with <img src="x" onerror="alert(1)"> inline html and <b>bold</b>.',
  "",
  "![logo](https://example.com/logo.png)",
  "",
  "[safe](https://example.com/docs) [plain](http://example.com) [script](javascript:alert(1)) [relative](./README.md)",
  "",
  "Visit https://example.com/auto now.",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "- [ ] task",
  "",
  "```js",
  "const x = 1;",
  "```",
].join("\n");

describe("PluginOverviewMarkdown", () => {
  it("renders only the allowlisted markdown and https links", () => {
    const { container } = render(
      <PluginOverviewMarkdown markdown={HOSTILE_MARKDOWN} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).not.toContain("pwned");
    expect(container.textContent).not.toContain("onerror");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h3")?.textContent).toBe("Heading");
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe(
      "const x = 1;\n",
    );

    const links = [...container.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/docs",
      "https://example.com/auto",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(container.textContent).toContain("plain");
    expect(container.textContent).toContain("script");
    expect(container.textContent).toContain("relative");
    expect(container.textContent).toContain("task");
    expect(container.textContent).toContain("1");
  });
});
