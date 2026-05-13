import { describe, expect, it } from "vitest";
import {
  buildLocalFileAnchorHref,
  parseLocalFileHref,
} from "./markdown-local-file-link.js";

describe("parseLocalFileHref", () => {
  it("returns null for empty or missing hrefs", () => {
    expect(parseLocalFileHref(undefined)).toBeNull();
    expect(parseLocalFileHref("")).toBeNull();
  });

  it("returns null for non-absolute hrefs", () => {
    expect(parseLocalFileHref("apps/app/src/main.tsx")).toBeNull();
    expect(parseLocalFileHref("README.md")).toBeNull();
    expect(parseLocalFileHref("https://example.test")).toBeNull();
  });

  it("parses absolute paths with no line number", () => {
    expect(parseLocalFileHref("/workspace/src/app.ts")).toEqual({
      path: "/workspace/src/app.ts",
      lineNumber: null,
    });
  });

  it("parses absolute paths with a :N line suffix", () => {
    expect(parseLocalFileHref("/workspace/src/app.ts:12")).toEqual({
      path: "/workspace/src/app.ts",
      lineNumber: 12,
    });
  });

  it("parses absolute paths with a #LN line suffix", () => {
    expect(parseLocalFileHref("/workspace/src/app.ts#L12")).toEqual({
      path: "/workspace/src/app.ts",
      lineNumber: 12,
    });
  });

  it("parses file:// URLs with a #LN line suffix", () => {
    expect(
      parseLocalFileHref("file:///workspace/src/file-url.ts#L4"),
    ).toEqual({
      path: "/workspace/src/file-url.ts",
      lineNumber: 4,
    });
  });

  it("parses deeply nested worktree paths", () => {
    expect(
      parseLocalFileHref(
        "/Users/michael/.bb-dev/worktrees/env_7m3cieyz6q/bb/apps/app/src/views/thread-detail/ThreadTimelinePane.tsx:145",
      ),
    ).toEqual({
      path: "/Users/michael/.bb-dev/worktrees/env_7m3cieyz6q/bb/apps/app/src/views/thread-detail/ThreadTimelinePane.tsx",
      lineNumber: 145,
    });
  });

  it("rejects file:// URLs with query strings", () => {
    expect(parseLocalFileHref("file:///workspace/app.ts?foo=1")).toBeNull();
  });

  it("rejects hrefs with a hash that is not #LN", () => {
    expect(parseLocalFileHref("/workspace/app.ts#section")).toBeNull();
  });

  it("rejects double-leading-slash paths", () => {
    expect(parseLocalFileHref("//workspace/app.ts")).toBeNull();
  });

  it("rejects zero-line line suffixes", () => {
    expect(parseLocalFileHref("/workspace/app.ts:0")).toBeNull();
    expect(parseLocalFileHref("/workspace/app.ts#L0")).toBeNull();
  });

  it("decodes percent-encoded path segments", () => {
    expect(parseLocalFileHref("/work%20space/app.ts:3")).toEqual({
      path: "/work space/app.ts",
      lineNumber: 3,
    });
  });
});

describe("buildLocalFileAnchorHref", () => {
  it("returns the original href when the link is null", () => {
    expect(buildLocalFileAnchorHref(null, "https://example.test")).toBe(
      "https://example.test",
    );
  });

  it("returns the original href when the path is not absolute", () => {
    expect(
      buildLocalFileAnchorHref(
        { path: "apps/app/main.tsx", lineNumber: 4 },
        "apps/app/main.tsx:4",
      ),
    ).toBe("apps/app/main.tsx:4");
  });

  it("returns the original href when the path has no line and no file-like basename", () => {
    expect(
      buildLocalFileAnchorHref(
        { path: "/workspace/somedir", lineNumber: null },
        "/workspace/somedir",
      ),
    ).toBe("/workspace/somedir");
  });

  it("rewrites absolute paths with a line number to file:// URLs with #LN", () => {
    expect(
      buildLocalFileAnchorHref(
        { path: "/workspace/src/app.ts", lineNumber: 12 },
        "/workspace/src/app.ts:12",
      ),
    ).toBe("file:///workspace/src/app.ts#L12");
  });

  it("rewrites absolute paths with a file-like basename even without a line", () => {
    expect(
      buildLocalFileAnchorHref(
        { path: "/workspace/README.md", lineNumber: null },
        "/workspace/README.md",
      ),
    ).toBe("file:///workspace/README.md");
  });

  it("percent-encodes spaces in path segments", () => {
    expect(
      buildLocalFileAnchorHref(
        { path: "/work space/app.ts", lineNumber: 3 },
        "/work space/app.ts:3",
      ),
    ).toBe("file:///work%20space/app.ts#L3");
  });
});
