/**
 * Plain default values for all BB configuration.
 *
 * Zero dependencies — safe to import from repo scripts that run before any
 * workspace package build has happened.
 */

export const DEFAULTS = {
  dataDir: { prod: ".bb", dev: ".bb-dev" },
  logFormat: { prod: "json", dev: "pretty" },
  logLevel: { prod: "info", dev: "debug" },
  secretToken: { dev: "dev-secret" },
  serverPort: { prod: 3000, dev: 3334 },
  hostDaemonPort: { prod: 3001, dev: 3002 },
  serverUrl: { prod: "http://localhost:3000", dev: "http://localhost:3334" },
  appPort: { dev: 5173 },
  inferenceModel: "openai/gpt-4o-mini",
};
