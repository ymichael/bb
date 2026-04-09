export type HostMode = "dev" | "prod";

export function resolveScriptMode(nodeEnv: string | undefined = process.env.NODE_ENV): HostMode {
  return nodeEnv === "development" ? "dev" : "prod";
}

export function resolveNodeEnvironment(mode: HostMode): "development" | "production" {
  return mode === "dev" ? "development" : "production";
}
