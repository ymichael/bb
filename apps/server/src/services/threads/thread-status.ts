import type { ThreadStatus } from "@bb/domain";

export type PreStartThreadStatus = Extract<
  ThreadStatus,
  "created" | "provisioning"
>;

export function isPreStartThreadStatus(
  status: ThreadStatus,
): status is PreStartThreadStatus {
  return status === "created" || status === "provisioning";
}
