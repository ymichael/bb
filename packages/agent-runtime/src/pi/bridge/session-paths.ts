import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PI_BRIDGE_SESSION_DIR_ENV = "BB_PI_BRIDGE_SESSION_DIR";

export interface ResolvePiBridgeSessionDirArgs {
  env: NodeJS.ProcessEnv;
}

export interface ResolvePiSessionFilePathArgs
  extends ResolvePiBridgeSessionDirArgs {
  sessionPath?: string;
  threadId: string;
}

export function resolvePiBridgeSessionDir(
  args: ResolvePiBridgeSessionDirArgs,
): string {
  const configuredSessionDir = args.env[PI_BRIDGE_SESSION_DIR_ENV]?.trim();
  if (configuredSessionDir) {
    return resolve(configuredSessionDir);
  }

  return join(homedir(), ".bb", "pi-bridge-sessions");
}

export function resolvePiSessionFilePath(
  args: ResolvePiSessionFilePathArgs,
): string {
  if (args.sessionPath?.trim()) {
    return resolve(args.sessionPath);
  }

  return join(
    resolvePiBridgeSessionDir({ env: args.env }),
    `${sanitizeSessionKey(args.threadId)}.jsonl`,
  );
}

function sanitizeSessionKey(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}
