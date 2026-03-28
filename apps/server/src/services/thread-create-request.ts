import type { ThreadTurnInitiator } from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";

export interface ThreadCreateServiceRequest
  extends Omit<CreateThreadRequest, "input" | "model"> {
  input?: CreateThreadRequest["input"];
  model?: CreateThreadRequest["model"];
  spawnInitiator?: ThreadTurnInitiator;
}
