export type HostMode = "dev" | "prod";

// Matches envsafe's convention: anything other than "production" is treated
// as dev. Keeping these two systems in sync is load-bearing — if they drift,
// scripts can pick the prod data dir while envsafe hands back dev defaults,
// which leaves the host daemon reading one auth.json while trying to talk to
// a different server URL.
export function resolveScriptMode(nodeEnv: string | undefined = process.env.NODE_ENV): HostMode {
  return nodeEnv === "production" ? "prod" : "dev";
}

export function resolveNodeEnvironment(mode: HostMode): "development" | "production" {
  return mode === "dev" ? "development" : "production";
}
