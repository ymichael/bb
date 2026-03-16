import type { EnvironmentCapabilities } from "@bb/core";

export function supportsPrimaryCheckoutMetadata(
  capabilities?: Pick<
    EnvironmentCapabilities,
    "promote_primary_checkout" | "demote_primary_checkout"
  >,
): boolean {
  if (!capabilities) {
    return false;
  }

  return (
    capabilities.promote_primary_checkout === true ||
    capabilities.demote_primary_checkout === true
  );
}
