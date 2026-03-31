import type {
  EnvironmentActionRequest,
  SendMessageRequest,
} from "@bb/server-contract";

export type RequestEnvironmentActionMutationRequest = { id: string } & EnvironmentActionRequest;

export interface RequestEnvironmentActionMutationLike {
  isPending: boolean;
  mutateAsync: (request: RequestEnvironmentActionMutationRequest) => Promise<unknown>;
}

export interface SendMessageMutationRequest extends SendMessageRequest {
  id: string;
}

export interface SendMessageMutationLike {
  isPending: boolean;
  mutateAsync: (request: SendMessageMutationRequest) => Promise<unknown>;
}
