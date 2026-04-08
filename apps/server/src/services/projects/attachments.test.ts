import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAttachment } from "./attachments.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-attachments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("project attachments", () => {
  it("reads attachments from inside the project attachment directory", async () => {
    const dataDir = await makeTempDir();
    const attachmentDir = join(dataDir, "attachments", "proj_test");
    const attachmentPath = join(attachmentDir, "notes.txt");

    await mkdir(attachmentDir, { recursive: true });
    await writeFile(attachmentPath, "hello", "utf8");

    const result = await readAttachment(dataDir, "proj_test", "notes.txt");

    expect(result.content.toString("utf8")).toBe("hello");
    expect(result.mimeType).toBe("text/plain");
  });

  it("rejects POSIX traversal outside the project attachment directory", async () => {
    const dataDir = await makeTempDir();

    await expect(readAttachment(dataDir, "proj_test", "../secret.txt")).rejects.toMatchObject(
      {
        status: 400,
        body: expect.objectContaining({
          code: "invalid_request",
          message: "Attachment path escapes project directory",
        }),
      },
    );
  });

  it("rejects Windows-style traversal outside the project attachment directory", async () => {
    const dataDir = await makeTempDir();

    await expect(readAttachment(dataDir, "proj_test", "..\\secret.txt")).rejects.toMatchObject(
      {
        status: 400,
        body: expect.objectContaining({
          code: "invalid_request",
          message: "Attachment path escapes project directory",
        }),
      },
    );
  });
});
