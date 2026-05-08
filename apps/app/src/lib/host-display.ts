import type { Host } from "@bb/domain";
import { Container, Laptop } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Canonical icon for a known persistent host (the user's machine,
 * always-on remotes). The single in-app source of truth — everything that
 * displays a known environment/host should import this rather than
 * referencing the underlying lucide icon directly.
 */
export const PersistentHostIcon: LucideIcon = Laptop;

/**
 * Icon for a host based on its type. Persistent hosts get PersistentHostIcon;
 * ephemeral hosts (E2B sandboxes, etc.) get Container.
 */
export function getHostIcon(host: Host | undefined | null): LucideIcon {
  return host?.type === "ephemeral" ? Container : PersistentHostIcon;
}
