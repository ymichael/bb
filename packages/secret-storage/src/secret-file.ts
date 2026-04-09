import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ReadOrCreateSecretFileArgs {
  bytes: number;
  dataDir: string;
  fileName: string;
  encoding?: BufferEncoding;
}

export async function readOrCreateSecretFile(
  args: ReadOrCreateSecretFileArgs,
): Promise<string> {
  const encoding = args.encoding ?? "base64";

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

  const generatedSecret = randomBytes(args.bytes).toString(encoding);
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
