import type { HostType } from "@bb/domain";
import { ApiError } from "../../errors.js";

export interface ExistingHostTypeInfo {
  id: string;
  type: HostType;
}

export interface AssertMatchingExistingHostTypeArgs {
  existingHost: ExistingHostTypeInfo | null;
  requestedHostType: HostType;
}

export function assertMatchingExistingHostType(
  args: AssertMatchingExistingHostTypeArgs,
): void {
  if (!args.existingHost || args.existingHost.type === args.requestedHostType) {
    return;
  }

  throw new ApiError(
    409,
    "invalid_request",
    `Host ${args.existingHost.id} is already registered as ${args.existingHost.type} and cannot be reenrolled as ${args.requestedHostType}`,
  );
}
