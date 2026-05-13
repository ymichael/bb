// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FilePreview } from "./FilePreview";

afterEach(() => {
  cleanup();
});

describe("FilePreview", () => {
  it("renders sanitized HTML in markdown file previews", () => {
    const { container } = render(
      <FilePreview
        path="README.md"
        state={{
          kind: "ready",
          lineNumber: null,
          file: {
            name: "README.md",
            contents: [
              "# Readme",
              "",
              "<kbd>Cmd</kbd>",
              '<div onmouseover="alert(1)">Body</div>',
              "<script>alert(1)</script>",
            ].join("\n"),
          },
        }}
      />,
    );

    expect(container.querySelector("kbd")?.textContent).toBe("Cmd");
    expect(screen.getByText("Body").tagName).toBe("DIV");
    expect(screen.getByText("Body").getAttribute("onmouseover")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("alert(1)")).toBeNull();
  });
});
