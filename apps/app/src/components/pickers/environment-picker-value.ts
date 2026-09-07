type EnvironmentHostMode = "local" | "worktree";

interface ParsedHostEnvironmentValue {
  type: "host";
  hostId: string;
  mode: EnvironmentHostMode;
}

interface ParsedReuseEnvironmentValue {
  type: "reuse";
  environmentId: string | null;
}

export const REUSE_VALUE_WITHOUT_ENVIRONMENT = "reuse";

export type ParsedEnvironmentValue =
  | ParsedHostEnvironmentValue
  | ParsedReuseEnvironmentValue
  | null;

export function encodeHostValue(
  hostId: string,
  mode: EnvironmentHostMode,
): string {
  return `host:${hostId}:${mode}`;
}

export function encodeReuseValue(environmentId: string): string {
  return `reuse:${environmentId}`;
}

export function parseEnvironmentValue(value: string): ParsedEnvironmentValue {
  if (value === REUSE_VALUE_WITHOUT_ENVIRONMENT) {
    return { type: "reuse", environmentId: null };
  }
  if (value.startsWith("host:")) {
    const parts = value.split(":");
    const hostId = parts[1];
    const mode = parts[2];
    if (hostId && (mode === "local" || mode === "worktree")) {
      return { type: "host", hostId, mode };
    }
  }
  if (value.startsWith("reuse:")) {
    const environmentId = value.slice("reuse:".length);
    if (environmentId.length > 0) {
      return { type: "reuse", environmentId };
    }
  }
  return null;
}
