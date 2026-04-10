import { BlockList, isIP } from "node:net";
import { ApiError } from "../../errors.js";

const unreachableSandboxPublicUrlBlockList = new BlockList();
unreachableSandboxPublicUrlBlockList.addAddress("0.0.0.0", "ipv4");
unreachableSandboxPublicUrlBlockList.addAddress("127.0.0.1", "ipv4");
unreachableSandboxPublicUrlBlockList.addAddress("::", "ipv6");
unreachableSandboxPublicUrlBlockList.addAddress("::1", "ipv6");
unreachableSandboxPublicUrlBlockList.addSubnet("10.0.0.0", 8, "ipv4");
unreachableSandboxPublicUrlBlockList.addSubnet("169.254.0.0", 16, "ipv4");
unreachableSandboxPublicUrlBlockList.addSubnet("172.16.0.0", 12, "ipv4");
unreachableSandboxPublicUrlBlockList.addSubnet("192.168.0.0", 16, "ipv4");
unreachableSandboxPublicUrlBlockList.addSubnet("fc00::", 7, "ipv6");
unreachableSandboxPublicUrlBlockList.addSubnet("fe80::", 10, "ipv6");

export interface PublicServerUrlConfig {
  publicUrl?: string;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isReachablePublicServerUrl(publicUrl: string): boolean {
  const parsedUrl = new URL(publicUrl);
  if (parsedUrl.protocol !== "https:") {
    return false;
  }
  const normalizedHostname = normalizeHostname(parsedUrl.hostname);
  const ipVersion = isIP(normalizedHostname);

  if (normalizedHostname === "localhost") {
    return false;
  }
  if (ipVersion === 4) {
    return !unreachableSandboxPublicUrlBlockList.check(normalizedHostname, "ipv4");
  }
  if (ipVersion === 6) {
    return !unreachableSandboxPublicUrlBlockList.check(normalizedHostname, "ipv6");
  }
  return true;
}

export function hasConfiguredReachablePublicServerUrl(
  config: PublicServerUrlConfig,
): boolean {
  return config.publicUrl !== undefined && isReachablePublicServerUrl(config.publicUrl);
}

export function requireReachablePublicServerUrl(
  config: PublicServerUrlConfig,
): string {
  if (config.publicUrl === undefined) {
    throw new ApiError(
      501,
      "not_configured",
      "Sandbox provisioning requires BB_PUBLIC_URL to be configured",
    );
  }
  if (new URL(config.publicUrl).protocol !== "https:") {
    throw new ApiError(
      409,
      "invalid_request",
      "Sandbox provisioning requires BB_PUBLIC_URL to use https",
    );
  }
  if (!isReachablePublicServerUrl(config.publicUrl)) {
    throw new ApiError(
      409,
      "invalid_request",
      "Sandbox provisioning requires BB_PUBLIC_URL to be reachable from the internet",
    );
  }
  return config.publicUrl;
}
