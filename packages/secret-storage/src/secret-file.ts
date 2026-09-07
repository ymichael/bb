import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface ReadOrCreateSecretFileArgs {
  bytes: number;
  dataDir: string;
  encoding: BufferEncoding;
  fileName: string;
}

export async function readOrCreateSecretFile(
  args: ReadOrCreateSecretFileArgs,
): Promise<string> {
  await mkdir(args.dataDir, { recursive: true });
  const secretPath = join(args.dataDir, args.fileName);

  try {
    const existing = (await readFile(secretPath, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }

  const generatedSecret = randomBytes(args.bytes).toString(args.encoding);
  try {
    await writeFile(secretPath, `${generatedSecret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return generatedSecret;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode !== "EEXIST") {
      throw error;
    }
  }

  const racedSecret = (await readFile(secretPath, "utf8")).trim();
  if (racedSecret.length === 0) {
    throw new Error(`Failed to initialize secret at ${secretPath}`);
  }
  return racedSecret;
}

export async function writeSecretFile(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function deleteSecretFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
