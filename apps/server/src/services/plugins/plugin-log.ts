import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PLUGIN_LOG_MAX_BYTES = 5 * 1024 * 1024;
const PLUGIN_LOG_FILE = "plugin.log";
const PLUGIN_LOG_ROTATED_FILE = "plugin.log.1";

type PluginLogLevel = "debug" | "info" | "warn" | "error";

function pluginLogsDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId, "logs");
}

export function appendPluginLogLine(
  dataDir: string,
  pluginId: string,
  level: PluginLogLevel,
  message: string,
): void {
  try {
    const dir = pluginLogsDir(dataDir, pluginId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, PLUGIN_LOG_FILE);
    try {
      if (statSync(file).size > PLUGIN_LOG_MAX_BYTES) {
        renameSync(file, join(dir, PLUGIN_LOG_ROTATED_FILE));
      }
    } catch {}
    const line = JSON.stringify({ ts: Date.now(), level, message });
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {}
}

function splitLines(content: string): string[] {
  return content.split("\n").filter((line) => line.length > 0);
}

export async function readPluginLogTail(
  dataDir: string,
  pluginId: string,
  tail: number,
): Promise<string[]> {
  const dir = pluginLogsDir(dataDir, pluginId);
  const lines: string[] = [];
  for (const name of [PLUGIN_LOG_ROTATED_FILE, PLUGIN_LOG_FILE]) {
    try {
      lines.push(...splitLines(await readFile(join(dir, name), "utf8")));
    } catch {}
  }
  return tail <= 0 ? [] : lines.slice(-tail);
}
