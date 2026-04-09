import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULTS } from "../../packages/config/src/defaults.shared.mjs";

function resolveTildePath(pathValue) {
  return pathValue.startsWith("~/")
    ? resolve(homedir(), pathValue.slice(2))
    : resolve(pathValue);
}

export function resolveDataDir(args) {
  const preferred = process.env.BB_DATA_DIR?.trim();
  if (preferred) {
    return resolveTildePath(preferred);
  }

  return resolve(homedir(), args.defaultDirName);
}

export function resolveServerUrl(args) {
  return process.env.BB_SERVER_URL ?? DEFAULTS.serverUrl[args.mode];
}

export function resolveServerPort(args) {
  return Number(process.env.BB_SERVER_PORT ?? DEFAULTS.serverPort[args.mode]);
}

export function resolveHostDaemonPort(args) {
  return Number(process.env.BB_HOST_DAEMON_PORT ?? DEFAULTS.hostDaemonPort[args.mode]);
}

export function resolveNodeEnvironment(args) {
  return process.env.NODE_ENV ?? (args.mode === "dev" ? "development" : "production");
}

export function resolveDefaultDataDirName(args) {
  return args.mode === "dev" ? DEFAULTS.dataDir.dev : DEFAULTS.dataDir.prod;
}

export { DEFAULTS };
