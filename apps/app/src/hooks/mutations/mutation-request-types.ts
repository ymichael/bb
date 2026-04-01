import type {
  EnvironmentActionRequest,
  SendMessageRequest,
} from "@bb/server-contract";

export type RequestEnvironmentActionMutationRequest = { id: string } & EnvironmentActionRequest;

export interface SendThreadMessageMutationRequest extends SendMessageRequest {
  id: string;
}
