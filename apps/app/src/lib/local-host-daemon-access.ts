import { isLoopbackHostname } from "./loopback-hostname";

export type LocalHostDaemonAccessState =
  | "available"
  | "denied"
  | "permission-required"
  | "unavailable"
  | "unsupported";

type LocalNetworkPermissionName = "loopback-network" | "local-network-access";

export interface LocalNetworkPermissionQuery {
  query(descriptor: {
    name: LocalNetworkPermissionName;
  }): Promise<{ state: PermissionState }>;
}

interface ResolveLocalHostDaemonAccessArgs {
  configuredPorts: readonly number[];
  hostname: string | null;
  isDesktop: boolean;
  permissions: LocalNetworkPermissionQuery | null;
  sessionAccessGranted: boolean;
}

const LOCAL_NETWORK_PERMISSION_NAMES: readonly LocalNetworkPermissionName[] = [
  "loopback-network",
  "local-network-access",
];

export function getBrowserLocalNetworkPermissionQuery(): LocalNetworkPermissionQuery | null {
  if (
    typeof navigator === "undefined" ||
    !("permissions" in navigator) ||
    navigator.permissions === undefined
  ) {
    return null;
  }

  return navigator.permissions as unknown as LocalNetworkPermissionQuery;
}

async function queryLoopbackPermissionState(
  permissions: LocalNetworkPermissionQuery | null,
): Promise<PermissionState | "unsupported"> {
  if (!permissions) {
    return "unsupported";
  }

  for (const name of LOCAL_NETWORK_PERMISSION_NAMES) {
    try {
      const result = await permissions.query({ name });
      return result.state;
    } catch {}
  }

  return "unsupported";
}

export async function resolveLocalHostDaemonAccess({
  configuredPorts,
  hostname,
  isDesktop,
  permissions,
  sessionAccessGranted,
}: ResolveLocalHostDaemonAccessArgs): Promise<LocalHostDaemonAccessState> {
  if (configuredPorts.length === 0) {
    return "unavailable";
  }

  if (
    sessionAccessGranted ||
    isDesktop ||
    (hostname !== null && isLoopbackHostname(hostname))
  ) {
    return "available";
  }

  const permissionState = await queryLoopbackPermissionState(permissions);
  switch (permissionState) {
    case "granted":
      return "available";
    case "denied":
      return "denied";
    case "prompt":
      return "permission-required";
    case "unsupported":
      return "unsupported";
  }
}

export function resolveLocalHostDaemonProbePorts(
  configuredPorts: readonly number[],
  accessState: LocalHostDaemonAccessState,
): readonly number[] {
  return accessState === "available" ? configuredPorts : [];
}
