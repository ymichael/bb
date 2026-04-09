import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULTS } from "./defaults.shared.mjs";

/**
 * @typedef {"production" | "development"} RuntimeMode
 */

/**
 * @param {string} pathValue
 */
function resolveTildePath(pathValue) {
  return pathValue.startsWith("~/")
    ? resolve(homedir(), pathValue.slice(2))
    : resolve(pathValue);
}

/**
 * @param {string | undefined} [nodeEnv]
 * @returns {RuntimeMode}
 */
export function resolveModeFromNodeEnvironment(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "development" ? "development" : "production";
}

/**
 * @template TValue
 * @param {{ development: TValue; production: TValue; nodeEnv?: string | undefined }} args
 * @returns {TValue}
 */
export function resolveModeValue(args) {
  return resolveModeFromNodeEnvironment(args.nodeEnv) === "development"
    ? args.development
    : args.production;
}

/**
 * @param {{ defaultDirName: string }} args
 */
export function resolveDataDir(args) {
  const preferred = process.env.BB_DATA_DIR?.trim();
  if (preferred) {
    return resolveTildePath(preferred);
  }

  return resolve(homedir(), args.defaultDirName);
}

export function resolveDefaultDataDirName() {
  return resolveModeValue({
    development: DEFAULTS.dataDir.dev,
    production: DEFAULTS.dataDir.prod,
  });
}

export function resolveServerUrl() {
  return process.env.BB_SERVER_URL ?? resolveModeValue({
    development: DEFAULTS.serverUrl.dev,
    production: DEFAULTS.serverUrl.prod,
  });
}

export function resolveServerPort() {
  return Number(process.env.BB_SERVER_PORT ?? resolveModeValue({
    development: DEFAULTS.serverPort.dev,
    production: DEFAULTS.serverPort.prod,
  }));
}

export function resolveHostDaemonPort() {
  return Number(process.env.BB_HOST_DAEMON_PORT ?? resolveModeValue({
    development: DEFAULTS.hostDaemonPort.dev,
    production: DEFAULTS.hostDaemonPort.prod,
  }));
}

export function resolveNodeEnvironment() {
  return resolveModeFromNodeEnvironment();
}

export { DEFAULTS };
