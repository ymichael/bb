import type { CreateHostJoinRequest } from "./api-types.js";

export interface CreatePersistentHostJoinRequestArgs {
  hostId: string | null;
}

export function createPersistentHostJoinRequest(
  args: CreatePersistentHostJoinRequestArgs,
): CreateHostJoinRequest {
  if (args.hostId) {
    return {
      hostId: args.hostId,
      hostType: "persistent",
    };
  }

  return {
    hostType: "persistent",
  };
}

export function createLocalPersistentHostJoinRequest(
  args: CreatePersistentHostJoinRequestArgs,
): CreateHostJoinRequest {
  if (args.hostId) {
    return {
      hostId: args.hostId,
      hostType: "persistent",
      joinMode: "local",
    };
  }

  return {
    hostType: "persistent",
    joinMode: "local",
  };
}
