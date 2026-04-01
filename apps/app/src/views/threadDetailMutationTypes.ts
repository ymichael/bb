import type { EnvironmentActionResponse } from "@bb/server-contract";
import type {
  RequestEnvironmentActionMutationRequest,
  SendThreadMessageMutationRequest,
} from "@/hooks/mutations/mutation-request-types";

export interface RequestEnvironmentActionMutationLike {
  isPending: boolean;
  mutateAsync: (request: RequestEnvironmentActionMutationRequest) => Promise<EnvironmentActionResponse>;
}

export type SendMessageMutationRequest = SendThreadMessageMutationRequest;

export interface SendMessageMutationLike {
  isPending: boolean;
  mutateAsync: (request: SendMessageMutationRequest) => Promise<void>;
}
