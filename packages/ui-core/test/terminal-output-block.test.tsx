import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalOutputBlock } from "../src/thread-timeline/rows/TerminalOutputBlock.js";

describe("TerminalOutputBlock", () => {
  it("renders nothing when both command and output are absent", () => {
    const html = renderToStaticMarkup(
      <TerminalOutputBlock isExpanded={false} />,
    );

    expect(html).toBe("");
  });
});
