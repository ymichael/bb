import { describe, expect, it } from "vitest";
import {
  buildEditDiff,
  extractResultText,
} from "./adapter-utils.js";

describe("adapter-utils", () => {
  it("extractResultText returns an empty string for nullish content", () => {
    expect(extractResultText(null)).toBe("");
    expect(extractResultText(undefined)).toBe("");
  });

  it("extractResultText preserves primitive content", () => {
    expect(extractResultText("done")).toBe("done");
    expect(extractResultText(42)).toBe("42");
    expect(extractResultText(false)).toBe("false");
  });

  it("extractResultText unwraps content wrappers", () => {
    expect(extractResultText({
      content: [{ type: "text", text: "wrapped result" }],
    })).toBe("wrapped result");
  });

  it("extractResultText summarizes Claude tool reference blocks", () => {
    expect(extractResultText([
      { type: "tool_reference", tool_name: "TodoWrite" },
      { type: "tool_reference", tool_name: "WebSearch" },
      { type: "tool_reference", tool_name: "WebFetch" },
    ])).toBe("Matched tools: TodoWrite, WebSearch, WebFetch");
  });

  it("extractResultText keeps mixed text and non-text blocks readable", () => {
    expect(extractResultText([
      { type: "text", text: "partial output" },
      { type: "image", url: "https://example.com/image.png" },
      { type: "file", path: "src/app.ts" },
    ])).toBe(
      "partial output\n[image: https://example.com/image.png]\n[file: src/app.ts]",
    );
  });

  it("buildEditDiff omits synthetic hunk headers when only snippet text is available", () => {
    const diff = buildEditDiff(
      "src/app.ts",
      "const enabled = false;\n",
      "const enabled = true;\n",
    );

    expect(diff).toContain("--- a/src/app.ts");
    expect(diff).toContain("+++ b/src/app.ts");
    expect(diff).toContain("-const enabled = false;");
    expect(diff).toContain("+const enabled = true;");
    expect(diff).not.toContain("@@");
  });

  it("buildEditDiff renders pure additions against /dev/null", () => {
    const diff = buildEditDiff(
      "src/new-file.ts",
      undefined,
      "export const enabled = true;\n",
    );

    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/src/new-file.ts");
    expect(diff).toContain("+export const enabled = true;");
  });

  it("buildEditDiff renders pure deletions to /dev/null", () => {
    const diff = buildEditDiff(
      "src/old-file.ts",
      "export const enabled = false;\n",
      undefined,
    );

    expect(diff).toContain("--- a/src/old-file.ts");
    expect(diff).toContain("+++ /dev/null");
    expect(diff).toContain("-export const enabled = false;");
  });
});
