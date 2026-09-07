export const DEFAULTS = {
  appVersion: "0.0.0-dev",
  logLevel: { prod: "info", dev: "debug" },
  secretToken: { dev: "dev-secret" },
  inferenceModel: "codex/gpt-5.6-luna",
  inferenceFallbackModel: "codex/gpt-5.4-mini",
  transcriptionModel: "codex/gpt-transcribe",
} as const;
