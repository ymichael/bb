import path from "node:path";

export function resolveCodexHome(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.resolve(env.CODEX_HOME?.trim() || path.join(homeDir, ".codex"));
}
