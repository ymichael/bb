import type { Host } from "@bb/domain";
import type { IconName } from "@/components/ui/icon.js";

/**
 * Canonical icon for a known persistent host (the user's machine,
 * always-on remotes). The single in-app source of truth — everything that
 * displays a known environment/host should import this rather than
 * referencing the underlying icon name directly.
 */
export const PersistentHostIconName: IconName = "Laptop";

/**
 * Icon name for a host based on its type. Persistent hosts get
 * PersistentHostIconName; ephemeral hosts (E2B sandboxes, etc.) get
 * "Container".
 */
export function getHostIconName(host: Host | undefined | null): IconName {
  return host?.type === "ephemeral" ? "Container" : PersistentHostIconName;
}
