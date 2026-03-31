import { describe, expect, it } from "vitest";
import {
  buildFilePreview,
  normalizeFilePreviewMimeType,
} from "./file-preview";

describe("file-preview", () => {
  it("builds text previews for declared text mime types", () => {
    const preview = buildFilePreview({
      contentBytes: new TextEncoder().encode("export const value = 1;\n"),
      mimeType: "text/plain",
      name: "notes.txt",
      path: "notes.txt",
      url: "/files/notes.txt",
    });

    expect(preview).toEqual({
      kind: "text",
      mimeType: "text/plain",
      name: "notes.txt",
      path: "notes.txt",
      url: "/files/notes.txt",
      content: "export const value = 1;\n",
    });
  });

  it("builds text previews for utf8 content without a text mime type", () => {
    const preview = buildFilePreview({
      contentBytes: new TextEncoder().encode("{\"ok\":true}\n"),
      mimeType: "application/octet-stream",
      path: "result.log",
      url: "/files/result.log",
    });

    expect(preview).toEqual({
      kind: "text",
      mimeType: "application/octet-stream",
      path: "result.log",
      url: "/files/result.log",
      content: "{\"ok\":true}\n",
    });
  });

  it("builds image previews for image mime types", () => {
    const preview = buildFilePreview({
      contentBytes: Uint8Array.from([137, 80, 78, 71]),
      mimeType: "image/png",
      name: "diagram.png",
      path: "diagram.png",
      url: "/files/diagram.png",
    });

    expect(preview).toEqual({
      kind: "image",
      mimeType: "image/png",
      name: "diagram.png",
      path: "diagram.png",
      url: "/files/diagram.png",
    });
  });

  it("rejects declared text files with null bytes", () => {
    const preview = buildFilePreview({
      contentBytes: Uint8Array.from([97, 0, 98]),
      mimeType: "text/plain",
      path: "broken.txt",
      url: "/files/broken.txt",
    });

    expect(preview).toEqual({
      kind: "unsupported",
      mimeType: "text/plain",
      path: "broken.txt",
      url: "/files/broken.txt",
    });
  });

  it("marks non-text, non-image files as unsupported", () => {
    const preview = buildFilePreview({
      contentBytes: Uint8Array.from([0, 1, 2, 3]),
      mimeType: "application/octet-stream",
      path: "archive.bin",
      url: "/files/archive.bin",
    });

    expect(preview).toEqual({
      kind: "unsupported",
      mimeType: "application/octet-stream",
      path: "archive.bin",
      url: "/files/archive.bin",
    });
  });

  it("normalizes file preview mime types", () => {
    expect(normalizeFilePreviewMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(normalizeFilePreviewMimeType(null)).toBe("application/octet-stream");
  });
});
