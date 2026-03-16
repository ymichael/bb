import type { ThreadStatus } from "@bb/core";

// Single source of truth for persisted thread lifecycle transitions.
const VALID_TRANSITIONS: ReadonlyMap<ThreadStatus, ReadonlySet<ThreadStatus>> = new Map<
  ThreadStatus,
  ReadonlySet<ThreadStatus>
>([
  ["created", new Set(["provisioning", "provisioning_failed", "idle"])],
  ["provisioning", new Set(["provisioned", "active", "idle", "provisioning_failed"])],
  ["provisioned", new Set(["active", "idle", "provisioning_failed"])],
  ["provisioning_failed", new Set(["provisioning", "provisioned", "idle"])],
  ["error", new Set(["active", "provisioning", "provisioned", "idle"])],
  ["idle", new Set(["active", "error", "provisioning", "provisioned"])],
  ["active", new Set(["error", "idle"])],
]);

export function canTransitionThreadStatus(
  currentStatus: ThreadStatus,
  nextStatus: ThreadStatus,
): boolean {
  if (currentStatus === nextStatus) return true;
  return VALID_TRANSITIONS.get(currentStatus)?.has(nextStatus) ?? false;
}
