import type {
  CloudAuthResolvedCredential,
} from "@bb/agent-provider-auth";
import type {
  CloudAuthAttemptResponse,
  CloudAuthConnectResponse,
  CloudAuthConnection,
  CloudAuthProviderId,
} from "@bb/server-contract";

export interface GetCloudAuthAttemptArgs {
  attemptId: string;
}

export interface StartCloudAuthConnectionArgs {
  providerId: CloudAuthProviderId;
}

export interface DisconnectCloudAuthProviderArgs {
  providerId: CloudAuthProviderId;
}

export interface GetCloudAuthCredentialArgs {
  providerId: CloudAuthProviderId;
}

export interface CloudAuthService {
  disconnectProvider(args: DisconnectCloudAuthProviderArgs): Promise<boolean>;
  dispose(): Promise<void>;
  getAttempt(args: GetCloudAuthAttemptArgs): CloudAuthAttemptResponse | null;
  getValidCredential(
    args: GetCloudAuthCredentialArgs,
  ): Promise<CloudAuthResolvedCredential | null>;
  listConnections(): Promise<CloudAuthConnection[]>;
  startConnection(
    args: StartCloudAuthConnectionArgs,
  ): Promise<CloudAuthConnectResponse>;
}
