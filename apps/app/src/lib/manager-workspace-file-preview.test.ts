import { describe, expect, it } from "vitest";
import {
  buildManagerWorkspaceFilePreview,
  normalizeManagerWorkspaceMimeType,
  parseManagerWorkspaceContentEncodingHeader,
  parseManagerWorkspaceSizeBytesHeader,
} from "./manager-workspace-file-preview";

describe("manager-workspace-file-preview", () => {
  it("builds text previews for utf8 file content", () => {
    const preview = buildManagerWorkspaceFilePreview({
      contentBytes: new TextEncoder().encode("export const value = 1;\n"),
      contentEncoding: "utf8",
      mimeType: "text/plain",
      path: "notes.txt",
      sizeBytes: 24,
    });

    expect(preview).toEqual({
      kind: "text",
      mimeType: "text/plain",
      path: "notes.txt",
      sizeBytes: 24,
      content: "export const value = 1;\n",
    });
  });

  it("builds image previews for image mime types", async () => {
    const preview = buildManagerWorkspaceFilePreview({
      contentBytes: Uint8Array.from([137, 80, 78, 71]),
      contentEncoding: "base64",
      mimeType: "image/png",
      path: "diagram.png",
      sizeBytes: 4,
    });

    expect(preview.kind).toBe("image");
    if (preview.kind !== "image") {
      throw new Error("Expected an image preview");
    }
    expect(preview.mimeType).toBe("image/png");
    await expect(preview.blob.arrayBuffer()).resolves.toEqual(
      Uint8Array.from([137, 80, 78, 71]).buffer,
    );
  });

  it("marks non-text, non-image files as unsupported", () => {
    const preview = buildManagerWorkspaceFilePreview({
      contentBytes: Uint8Array.from([0, 1, 2, 3]),
      contentEncoding: "base64",
      mimeType: "application/octet-stream",
      path: "archive.bin",
      sizeBytes: 4,
    });

    expect(preview).toEqual({
      kind: "unsupported",
      mimeType: "application/octet-stream",
      path: "archive.bin",
      sizeBytes: 4,
    });
  });

  it("normalizes manager workspace response headers", () => {
    expect(normalizeManagerWorkspaceMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeManagerWorkspaceMimeType(null)).toBe("application/octet-stream");
    expect(parseManagerWorkspaceContentEncodingHeader("utf8")).toBe("utf8");
    expect(parseManagerWorkspaceContentEncodingHeader("base64")).toBe("base64");
    expect(parseManagerWorkspaceContentEncodingHeader("gzip")).toBeUndefined();
    expect(parseManagerWorkspaceSizeBytesHeader("42", 10)).toBe(42);
    expect(parseManagerWorkspaceSizeBytesHeader("oops", 10)).toBe(10);
  });
});
