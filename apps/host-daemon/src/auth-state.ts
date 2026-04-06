import fs from "node:fs/promises";
import path from "node:path";
import {
  HOST_AUTH_FILE_NAME,
  hostAuthStateSchema,
  normalizeServerUrl,
  type HostAuthState,
} from "@bb/host-daemon-contract";

function getAuthStatePath(dataDir: string): string {
  return path.join(dataDir, HOST_AUTH_FILE_NAME);
}

export async function readHostAuthState(
  dataDir: string,
): Promise<HostAuthState | null> {
  const authStatePath = getAuthStatePath(dataDir);

  try {
    const raw = await fs.readFile(authStatePath, "utf8");
    return hostAuthStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeHostAuthState(
  dataDir: string,
  authState: HostAuthState,
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const authStatePath = getAuthStatePath(dataDir);
  const payload = JSON.stringify(
    {
      hostId: authState.hostId,
      hostKey: authState.hostKey,
      hostType: authState.hostType,
      serverUrl: normalizeServerUrl(authState.serverUrl),
    },
    null,
    2,
  );

  await fs.writeFile(authStatePath, `${payload}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export interface ResolveServerUrlArgs {
  persistedServerUrl: string | null;
  providedServerUrl: string | undefined;
}

export function resolveServerUrl(args: ResolveServerUrlArgs): string | null {
  const normalizedProvided =
    typeof args.providedServerUrl === "string" && args.providedServerUrl.trim().length > 0
      ? normalizeServerUrl(args.providedServerUrl.trim())
      : null;

  if (
    args.persistedServerUrl &&
    normalizedProvided &&
    args.persistedServerUrl !== normalizedProvided
  ) {
    throw new Error(
      `Configured server URL ${normalizedProvided} does not match persisted auth state ${args.persistedServerUrl}`,
    );
  }

  return args.persistedServerUrl ?? normalizedProvided;
}
