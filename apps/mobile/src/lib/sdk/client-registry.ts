import type { QueryClient } from "@tanstack/react-query";
import type { ServerProfile } from "../profiles/profile";
import { createProfileQueryClient } from "../query/query-client";
import {
  installRealtimeInvalidation,
  type RealtimeInvalidationHandle,
} from "../query/realtime-invalidation";
import {
  createMobileSdk,
  type CreateMobileSdkOptions,
  type MobileSdk,
} from "./create-mobile-sdk";

export type ProfileAuthFailure =
  | { source: "fetch"; status: number }
  | { source: "realtime"; message: string | null };

export interface ProfileClient extends MobileSdk {
  profileId: string;
  serverUrl: string;
  queryClient: QueryClient;
  onAuthFailure(listener: (failure: ProfileAuthFailure) => void): () => void;
  dispose(): void;
}

export interface CreateProfileClientRegistryOptions {
  sdk?: Omit<CreateMobileSdkOptions, "onAuthFailure">;
  createQueryClient?: () => QueryClient;
}

export interface ProfileClientRegistry {
  getClientForProfile(
    profile: Pick<ServerProfile, "id" | "serverUrl">,
  ): ProfileClient;
  peekClient(profileId: string): ProfileClient | null;
  disposeClient(profileId: string): void;
  disposeAll(): void;
}

export function createProfileClientRegistry(
  options: CreateProfileClientRegistryOptions = {},
): ProfileClientRegistry {
  const clients = new Map<string, ProfileClient>();
  const createQueryClient =
    options.createQueryClient ?? (() => createProfileQueryClient());

  function build(
    profile: Pick<ServerProfile, "id" | "serverUrl">,
  ): ProfileClient {
    const authFailureListeners = new Set<
      (failure: ProfileAuthFailure) => void
    >();
    const emitAuthFailure = (failure: ProfileAuthFailure): void => {
      for (const listener of authFailureListeners) listener(failure);
    };
    const { sdk, realtime, fetch } = createMobileSdk(profile, {
      ...options.sdk,
      onAuthFailure: (status) => {
        emitAuthFailure({ source: "fetch", status });
      },
    });
    const unsubscribeConnectFailed = realtime.onConnectFailed((event) => {
      if (event.authRejected) {
        emitAuthFailure({ source: "realtime", message: event.message });
      }
    });
    const queryClient = createQueryClient();
    const invalidation: RealtimeInvalidationHandle =
      installRealtimeInvalidation(queryClient, realtime);
    return {
      profileId: profile.id,
      serverUrl: profile.serverUrl,
      sdk,
      realtime,
      fetch,
      queryClient,
      onAuthFailure(listener) {
        authFailureListeners.add(listener);
        return () => {
          authFailureListeners.delete(listener);
        };
      },
      dispose() {
        unsubscribeConnectFailed();
        authFailureListeners.clear();
        invalidation.dispose();
        realtime.dispose();
        queryClient.clear();
      },
    };
  }

  function disposeClient(profileId: string): void {
    const existing = clients.get(profileId);
    if (!existing) return;
    clients.delete(profileId);
    existing.dispose();
  }

  return {
    getClientForProfile(profile) {
      const existing = clients.get(profile.id);
      if (existing && existing.serverUrl === profile.serverUrl) return existing;
      if (existing) disposeClient(profile.id);
      const client = build(profile);
      clients.set(profile.id, client);
      return client;
    },
    peekClient: (profileId) => clients.get(profileId) ?? null,
    disposeClient,
    disposeAll() {
      for (const id of Array.from(clients.keys())) disposeClient(id);
    },
  };
}
