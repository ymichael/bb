import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const BB_APP_RUNTIME_FILE_NAME = "bb-app-runtime.json";

const bbAppRuntimeFileSchema = z.object({
  entryPath: z.string().min(1),
  pid: z.number().int().positive(),
  surface: z.string().min(1),
  serverUrl: z.string().min(1),
  startedAt: z.string().min(1),
  version: z.string().min(1),
});

export type BbAppRuntimeFile = z.infer<typeof bbAppRuntimeFileSchema>;

interface WriteBbAppRuntimeFileArgs {
  dataDir: string;
  entryPath: string;
  pid: number;
  serverUrl: string;
  startedAt: string;
  surface: string;
  version: string;
}

export function formatBbAppRuntimeFilePath(dataDir: string): string {
  return join(dataDir, BB_APP_RUNTIME_FILE_NAME);
}

function defaultIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeBbAppRuntimeFile(
  args: WriteBbAppRuntimeFileArgs,
): Promise<void> {
  const runtimeFile: BbAppRuntimeFile = {
    entryPath: args.entryPath,
    pid: args.pid,
    serverUrl: args.serverUrl,
    startedAt: args.startedAt,
    surface: args.surface,
    version: args.version,
  };
  await mkdir(args.dataDir, { recursive: true });
  await writeFile(
    formatBbAppRuntimeFilePath(args.dataDir),
    `${JSON.stringify(runtimeFile, null, 2)}\n`,
    "utf8",
  );
}

export async function claimBbAppRuntimeFile(
  args: WriteBbAppRuntimeFileArgs & { isRunning?: (pid: number) => boolean },
): Promise<boolean> {
  const isRunning = args.isRunning ?? defaultIsRunning;
  const existing = await readBbAppRuntimeFile(args.dataDir);
  if (
    existing !== null &&
    existing.pid !== args.pid &&
    isRunning(existing.pid)
  ) {
    return false;
  }
  await writeBbAppRuntimeFile(args);
  return true;
}

async function clearBbAppRuntimeFile(dataDir: string): Promise<void> {
  await rm(formatBbAppRuntimeFilePath(dataDir), { force: true });
}

export async function clearOwnBbAppRuntimeFile(args: {
  dataDir: string;
  pid: number;
}): Promise<boolean> {
  const runtimeFile = await readBbAppRuntimeFile(args.dataDir);
  if (runtimeFile === null || runtimeFile.pid !== args.pid) {
    return false;
  }
  await clearBbAppRuntimeFile(args.dataDir);
  return true;
}

export function bbAppRuntimeVerifyTokens(entryPath: string): string[] {
  return [entryPath, basename(entryPath)];
}

export async function readBbAppRuntimeFile(
  dataDir: string,
): Promise<BbAppRuntimeFile | null> {
  let rawContents: string;
  try {
    rawContents = await readFile(formatBbAppRuntimeFilePath(dataDir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = bbAppRuntimeFileSchema.safeParse(JSON.parse(rawContents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
