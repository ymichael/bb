import { describe, expect, it } from "vitest";
import {
  buildEditDiff,
  buildShellEnvOverrides,
  extractResultText,
  normalizeProviderCommandOutput,
} from "./adapter-utils.js";

describe("adapter-utils", () => {
  function countChangedLines(diff: string | undefined): {
    added: number;
    removed: number;
  } {
    let added = 0;
    let removed = 0;
    for (const line of diff?.split("\n") ?? []) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      if (line.startsWith("+")) added += 1;
      if (line.startsWith("-")) removed += 1;
    }
    return { added, removed };
  }

  it("drops environment names a shell would refuse", () => {
    expect(
      buildShellEnvOverrides({
        "BAD.KEY": "ignored",
        API_URL: "https://example.com",
      }),
    ).toEqual({ API_URL: "https://example.com" });
  });

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
    expect(
      extractResultText({
        content: [{ type: "text", text: "wrapped result" }],
      }),
    ).toBe("wrapped result");
  });

  it("extractResultText summarizes Claude tool reference blocks", () => {
    expect(
      extractResultText([
        { type: "tool_reference", tool_name: "TodoWrite" },
        { type: "tool_reference", tool_name: "WebSearch" },
        { type: "tool_reference", tool_name: "WebFetch" },
      ]),
    ).toBe("Matched tools: TodoWrite, WebSearch, WebFetch");
  });

  it("extractResultText keeps mixed text and non-text blocks readable", () => {
    expect(
      extractResultText([
        { type: "text", text: "partial output" },
        { type: "image", url: "https://example.com/image.png" },
        { type: "file", path: "src/app.ts" },
      ]),
    ).toBe(
      "partial output\n[image: https://example.com/image.png]\n[file: src/app.ts]",
    );
  });

  it("normalizeProviderCommandOutput strips exact placeholder text", () => {
    expect(
      normalizeProviderCommandOutput({
        text: "(no output)\n",
        emptyPlaceholders: ["(no output)"],
      }),
    ).toBeUndefined();
  });

  it("normalizeProviderCommandOutput preserves real whitespace output", () => {
    expect(
      normalizeProviderCommandOutput({
        text: " \n",
        emptyPlaceholders: ["(no output)"],
      }),
    ).toBe(" \n");
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

  it("buildEditDiff avoids reporting unchanged whole-file lines as edits", () => {
    const diff = buildEditDiff(
      "src/app.ts",
      ["alpha", "beta", "gamma", "delta"].join("\n") + "\n",
      ["alpha", "beta", "GAMMA", "delta"].join("\n") + "\n",
    );

    expect(diff).toContain("-gamma");
    expect(diff).toContain("+GAMMA");
    expect(diff).not.toContain("-alpha");
    expect(diff).not.toContain("+alpha");
    expect(countChangedLines(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("buildEditDiff normalizes CRLF-only differences", () => {
    expect(
      buildEditDiff("src/app.ts", "alpha\r\nbeta\r\n", "alpha\nbeta\n"),
    ).toBeUndefined();
  });

  it("buildEditDiff counts content changes in CRLF files without inflating every line", () => {
    const diff = buildEditDiff(
      "src/app.ts",
      "alpha\r\nbeta\r\ngamma\r\n",
      "alpha\nBETA\ngamma\n",
    );

    expect(diff).toContain("-beta");
    expect(diff).toContain("+BETA");
    expect(countChangedLines(diff)).toEqual({ added: 1, removed: 1 });
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
    expect(countChangedLines(diff)).toEqual({ added: 1, removed: 0 });
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
    expect(countChangedLines(diff)).toEqual({ added: 0, removed: 1 });
  });
});
