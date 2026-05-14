import { BlockList, isIP } from "node:net";

const loopbackAddressBlockList = new BlockList();
loopbackAddressBlockList.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddressBlockList.addAddress("::1", "ipv6");

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
}

export function isLoopbackAddress(value: string): boolean {
  const normalized = normalizeHostname(value);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return loopbackAddressBlockList.check(normalized, "ipv4");
  }
  if (ipVersion === 6) {
    return loopbackAddressBlockList.check(normalized, "ipv6");
  }
  return false;
}

export function isLoopbackHostname(value: string): boolean {
  const normalized = normalizeHostname(value);
  return normalized === "localhost" || isLoopbackAddress(normalized);
}
