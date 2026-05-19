import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildUserMessageContent,
  type ClaudeContentBlockParam,
} from "../prompt-input-content.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const tempDirs: string[] = [];

async function createStagingDir(): Promise<string> {
  const dir = await mkdtemp(
    path.join(tmpdir(), "bb-prompt-input-content-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

function isContentBlockArray(
  content: unknown,
): content is ClaudeContentBlockParam[] {
  return Array.isArray(content);
}

describe("buildUserMessageContent", () => {
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns a plain string for a text-only input array", async () => {
    const content = await buildUserMessageContent([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(content).toBe("hello\nworld");
  });

  it("returns undefined for an empty input array", async () => {
    expect(await buildUserMessageContent([])).toBeUndefined();
  });

  it("returns undefined when no text or attachments are present", async () => {
    expect(await buildUserMessageContent([{ type: "unsupported" }])).toBeUndefined();
  });

  it("inlines a local PNG image as a base64 ImageBlockParam", async () => {
    const dir = await createStagingDir();
    const imagePath = path.join(dir, "000-screenshot.png");
    await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const content = await buildUserMessageContent([
      { type: "text", text: "look at this" },
      { type: "localImage", path: imagePath },
    ]);

    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "look at this" });
    expect(content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: TINY_PNG_BASE64,
      },
    });
  });

  it("inlines a JPEG image and preserves jpeg media_type from extension", async () => {
    const dir = await createStagingDir();
    const imagePath = path.join(dir, "000-photo.jpeg");
    await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const content = await buildUserMessageContent([
      { type: "localImage", path: imagePath },
    ]);

    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg" },
    });
  });

  it("passes a URL image through as an ImageBlockParam with url source", async () => {
    const content = await buildUserMessageContent([
      { type: "image", url: "https://example.com/cat.png" },
    ]);
    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    });
  });

  it("renders a text-like local file as a DocumentBlockParam with PlainTextSource", async () => {
    const dir = await createStagingDir();
    const filePath = path.join(dir, "000-notes.md");
    await writeFile(filePath, "# Hello\nthis is the doc body");

    const content = await buildUserMessageContent([
      {
        type: "localFile",
        path: filePath,
        name: "notes.md",
        sizeBytes: 28,
      },
    ]);

    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content[0]).toEqual({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "# Hello\nthis is the doc body",
      },
      title: "notes.md",
    });
  });

  it("renders a PDF local file as a DocumentBlockParam with Base64PDFSource", async () => {
    const dir = await createStagingDir();
    const filePath = path.join(dir, "000-paper.pdf");
    const pdfBytes = Buffer.from("%PDF-1.4 hello", "utf8");
    await writeFile(filePath, pdfBytes);

    const content = await buildUserMessageContent([
      {
        type: "localFile",
        path: filePath,
        name: "paper.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdfBytes.length,
      },
    ]);

    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: pdfBytes.toString("base64"),
      },
      title: "paper.pdf",
    });
  });

  it("falls back to a text marker for unsupported binary file types", async () => {
    const dir = await createStagingDir();
    const filePath = path.join(dir, "000-archive.zip");
    await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const content = await buildUserMessageContent([
      {
        type: "localFile",
        path: filePath,
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: 4,
      },
    ]);

    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({ type: "text" });
    const block = content[0];
    if (block.type !== "text") throw new Error("expected text block");
    expect(block.text).toContain("archive.zip");
    expect(block.text).toContain(filePath);
  });

  it("emits a text marker (not a thrown error) when a local image is missing on disk", async () => {
    const content = await buildUserMessageContent([
      { type: "text", text: "see image" },
      { type: "localImage", path: "/nonexistent/path/missing.png" },
    ]);
    if (!isContentBlockArray(content)) {
      throw new Error("Expected ContentBlockParam[] content");
    }
    expect(content[0]).toEqual({ type: "text", text: "see image" });
    expect(content[1]).toMatchObject({ type: "text" });
    const block = content[1];
    if (block.type !== "text") throw new Error("expected text block");
    expect(block.text).toContain("/nonexistent/path/missing.png");
  });

  it("returns the raw string for a string input (legacy code path)", async () => {
    expect(await buildUserMessageContent("just a string")).toBe("just a string");
  });
});
