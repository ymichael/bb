import { execFile } from "node:child_process";
import { brotliDecompress, gunzip } from "node:zlib";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const decompressBrotli = promisify(brotliDecompress);
const decompressGzip = promisify(gunzip);
const scriptPath = resolve(
  import.meta.dirname,
  "../../../scripts/precompress-app-dist.mjs",
);

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("app asset precompression", () => {
  it("writes valid Brotli and gzip sidecars only for eligible assets", async () => {
    const distDir = await mkdtemp(resolve(tmpdir(), "bb-precompress-test-"));
    const compressibleBody = Buffer.from("compressible bb asset\n".repeat(400));
    const assetPath = resolve(distDir, "app.js");
    const documentPath = resolve(distDir, "index.html");
    const smallPath = resolve(distDir, "small.js");
    const binaryPath = resolve(distDir, "image.png");
    await Promise.all([
      writeFile(assetPath, compressibleBody),
      writeFile(documentPath, compressibleBody),
      writeFile(smallPath, "small"),
      writeFile(binaryPath, compressibleBody),
    ]);

    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      distDir,
    ]);

    expect(stdout).toContain("precompressed 2 files (2 br, 2 gzip)");
    await expect(
      decompressBrotli(await readFile(`${assetPath}.br`)),
    ).resolves.toEqual(compressibleBody);
    await expect(
      decompressGzip(await readFile(`${assetPath}.gz`)),
    ).resolves.toEqual(compressibleBody);
    await expect(
      decompressBrotli(await readFile(`${documentPath}.br`)),
    ).resolves.toEqual(compressibleBody);
    await expect(pathExists(`${smallPath}.br`)).resolves.toBe(false);
    await expect(pathExists(`${binaryPath}.br`)).resolves.toBe(false);
  });
});
