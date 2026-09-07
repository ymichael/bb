export const MOBILE_BRIDGE_VERSION = 2;

export const MINIMUM_MOBILE_BRIDGE_VERSION = 1;

export const NATIVE_BRIDGE_GLOBAL = "bb";

interface VersionPair {
  remoteVersion: number;
  localVersion: number;
}

export type BridgeCompatibility =
  | { kind: "supported" }
  | ({ kind: "older-peer" } & VersionPair)
  | ({ kind: "newer-peer" } & VersionPair)
  | ({ kind: "unsupported" } & VersionPair);

export function compareBridgeVersions(
  remoteVersion: number,
  localVersion: number = MOBILE_BRIDGE_VERSION,
): BridgeCompatibility {
  if (!Number.isInteger(remoteVersion) || remoteVersion < 1) {
    return { kind: "unsupported", remoteVersion, localVersion };
  }
  if (remoteVersion < MINIMUM_MOBILE_BRIDGE_VERSION) {
    return { kind: "unsupported", remoteVersion, localVersion };
  }
  if (remoteVersion === localVersion) return { kind: "supported" };
  return remoteVersion < localVersion
    ? { kind: "older-peer", remoteVersion, localVersion }
    : { kind: "newer-peer", remoteVersion, localVersion };
}

export function isBridgeUsable(compatibility: BridgeCompatibility): boolean {
  return compatibility.kind !== "unsupported";
}
