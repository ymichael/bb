import { describe, expect, it } from "vitest";
import { parseThreadTimelineLocalFileLink } from "../src/thread-timeline/localFileLinks.js";

describe("parseThreadTimelineLocalFileLink", () => {
  it("parses an absolute file path with a line suffix", () => {
    expect(
      parseThreadTimelineLocalFileLink("/Users/me/project/src/file.ts:12"),
    ).toEqual({
      lineNumber: 12,
      path: "/Users/me/project/src/file.ts",
    });
  });

  it("parses an absolute file path without a line suffix", () => {
    expect(
      parseThreadTimelineLocalFileLink("/Users/me/project/src/file.ts"),
    ).toEqual({
      lineNumber: null,
      path: "/Users/me/project/src/file.ts",
    });
  });

  it("rejects non-local absolute URLs", () => {
    expect(
      parseThreadTimelineLocalFileLink("https://example.com/file.ts"),
    ).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(parseThreadTimelineLocalFileLink("//example.com/file.ts")).toBeNull();
  });

  it("rejects the filesystem root path", () => {
    expect(parseThreadTimelineLocalFileLink("/")).toBeNull();
  });

  it("rejects directory paths", () => {
    expect(parseThreadTimelineLocalFileLink("/Users/me/project/src/")).toBeNull();
  });
});
