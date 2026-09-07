import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function safePluginSegment(pluginId: string): string {
  return encodeURIComponent(pluginId);
}

export async function ensurePluginProcessDataDir(args: {
  daemonDataDir: string;
  pluginId: string;
  kind: "host-data" | "bridge-data";
}): Promise<string> {
  const directory = join(
    args.daemonDataDir,
    "plugins",
    safePluginSegment(args.pluginId),
    args.kind,
  );
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function createPluginProcessTempDir(args: {
  pluginId: string;
  prefix: string;
}): Promise<string> {
  return mkdtemp(
    join(tmpdir(), `${args.prefix}-${safePluginSegment(args.pluginId)}-`),
  );
}
