import type { ThreadTurnInitiator } from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";

export interface PublicThreadCreateServiceRequest extends CreateThreadRequest {
  spawnInitiator?: ThreadTurnInitiator;
}

export interface ManagerThreadCreateServiceRequest
  extends Omit<CreateThreadRequest, "input"> {
  type: "manager";
  spawnInitiator?: ThreadTurnInitiator;
}

export type ThreadCreateServiceRequest =
  | PublicThreadCreateServiceRequest
  | ManagerThreadCreateServiceRequest;

export function hasThreadStartInput(
  request: ThreadCreateServiceRequest,
): request is PublicThreadCreateServiceRequest {
  return "input" in request;
}
