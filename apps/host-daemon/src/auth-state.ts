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
    },
    null,
    2,
  );

  await fs.writeFile(authStatePath, `${payload}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

interface ResolveServerUrlArgs {
  providedServerUrl: string | undefined;
}

export function resolveServerUrl(args: ResolveServerUrlArgs): string | null {
  return typeof args.providedServerUrl === "string" &&
    args.providedServerUrl.trim().length > 0
    ? normalizeServerUrl(args.providedServerUrl.trim())
    : null;
}
