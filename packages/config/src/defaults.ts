/**
 * Plain default values for all BB configuration.
 *
 * Zero runtime dependencies — safe to import from config consumers and
 * tooling entrypoints that only need the raw default values.
 *
 * @bb/config uses these as its envsafe default/devDefault values.
 */
export const DEFAULTS = {
  dataDir: { prod: ".bb", dev: ".bb-dev", devHostDaemon: ".bb-dev-host-daemon" },
  logLevel: { prod: "info", dev: "debug" },
  secretToken: { dev: "dev-secret" },
  serverPort: { prod: 3000, dev: 3334 },
  hostDaemonPort: { prod: 3001, dev: 3002 },
  serverUrl: { prod: "http://localhost:3000", dev: "http://localhost:3334" },
  inferenceModel: "openai/gpt-4o-mini",
  sandboxActivityExtensionDebounceMs: 30_000,
  sandboxIdleThresholdMs: 300_000,
} as const;
