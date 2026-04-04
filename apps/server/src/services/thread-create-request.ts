import type { ThreadTurnInitiator } from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";

export interface BaseThreadCreateServiceRequest extends CreateThreadRequest {
  automationId: string | null;
  spawnInitiator?: ThreadTurnInitiator;
}

export interface PublicThreadCreateServiceRequest
  extends BaseThreadCreateServiceRequest {
  type: "standard";
}

export interface ManagerThreadCreateServiceRequest
  extends BaseThreadCreateServiceRequest {
  type: "manager";
}

export type ThreadCreateServiceRequest =
  | PublicThreadCreateServiceRequest
  | ManagerThreadCreateServiceRequest;
