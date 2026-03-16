import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const BB_ROOT_ENV = "BB_ROOT";

export function expandHomeDirectory(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function resolveBbRoot(env: NodeJS.ProcessEnv = process.env): string {
  const preferred = env[BB_ROOT_ENV]?.trim();
  if (preferred) {
    return resolve(expandHomeDirectory(preferred));
  }
  return resolve(homedir(), ".bb");
}

export function resolveBbPath(
  env: NodeJS.ProcessEnv = process.env,
  ...segments: readonly string[]
): string {
  return join(resolveBbRoot(env), ...segments);
}
