import fs from "node:fs/promises";
import path from "node:path";

export const COMMAND_CURSOR_FILE_NAME = "command-cursor";

interface CursorIo {
  mkdir?: typeof fs.mkdir;
  readFile?: typeof fs.readFile;
  writeFile?: typeof fs.writeFile;
  rename?: typeof fs.rename;
  rm?: typeof fs.rm;
  randomSuffix?: () => string;
}

export async function readCommandCursor(
  dataDir: string,
  io: CursorIo = {},
): Promise<number> {
  const readFile = io.readFile ?? fs.readFile;
  const cursorPath = path.join(dataDir, COMMAND_CURSOR_FILE_NAME);

  try {
    const rawValue = await readFile(cursorPath, "utf8");
    const cursor = Number.parseInt(rawValue.trim(), 10);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error(`Invalid command cursor in ${cursorPath}`);
    }
    return cursor;
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export async function writeCommandCursor(
  dataDir: string,
  cursor: number,
  io: CursorIo = {},
): Promise<void> {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error(`Command cursor must be a non-negative integer: ${cursor}`);
  }

  const mkdir = io.mkdir ?? fs.mkdir;
  const writeFile = io.writeFile ?? fs.writeFile;
  const rename = io.rename ?? fs.rename;
  const rm = io.rm ?? fs.rm;
  const randomSuffix = io.randomSuffix ?? (() => `${Date.now()}`);

  await mkdir(dataDir, { recursive: true });

  const cursorPath = path.join(dataDir, COMMAND_CURSOR_FILE_NAME);
  const tempPath = `${cursorPath}.tmp-${randomSuffix()}`;

  try {
    await writeFile(tempPath, `${cursor}\n`, "utf8");
    await rename(tempPath, cursorPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
