import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  allSystemExecutionOptionsQueryKeyPrefix,
  allThreadComposerBootstrapQueryKeyPrefix,
  systemExecutionOptionsQueryKey,
  threadComposerBootstrapQueryKey,
} from "./queries/query-keys";
import {
  invalidateHostChangeDependentQueries,
  invalidateRealtimeQueriesAfterServerReconnect,
} from "./system-cache-effects";

function createCacheEffectQueryClient() {
  return createAppQueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
      },
    },
    showMutationErrorToasts: false,
  });
}

interface ScopedSystemExecutionOptionsKeyArgs {
  environmentId: string;
}

function scopedSystemExecutionOptionsKey({
  environmentId,
}: ScopedSystemExecutionOptionsKeyArgs) {
  return systemExecutionOptionsQueryKey({
    environmentId,
    providerId: "codex",
  });
}

describe("system cache effects", () => {
  it("invalidates env-scoped execution options and composer bootstrap caches after reconnect", () => {
    const queryClient = createCacheEffectQueryClient();
    const executionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-1",
    });
    const composerBootstrapKey = threadComposerBootstrapQueryKey(
      "thread-1",
      "env-1",
    );
    queryClient.setQueryData(executionOptionsKey, {
      providers: [],
      models: [],
    });
    queryClient.setQueryData(composerBootstrapKey, {
      defaultExecutionOptions: null,
      queuedMessages: [],
      executionOptions: { providers: [], models: [] },
      pendingInteractions: [],
      promptHistory: [],
    });

    invalidateRealtimeQueriesAfterServerReconnect({ queryClient });

    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(composerBootstrapKey)?.isInvalidated).toBe(
      true,
    );
  });

  it("invalidates all execution options and composer bootstrap caches after host changes", () => {
    const queryClient = createCacheEffectQueryClient();
    const executionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-1",
    });
    const composerBootstrapKey = threadComposerBootstrapQueryKey(
      "thread-1",
      "env-1",
    );
    queryClient.setQueryData(executionOptionsKey, {
      providers: [],
      models: [],
    });
    queryClient.setQueryData(composerBootstrapKey, {
      defaultExecutionOptions: null,
      queuedMessages: [],
      executionOptions: { providers: [], models: [] },
      pendingInteractions: [],
      promptHistory: [],
    });

    invalidateHostChangeDependentQueries({ queryClient });

    expect(
      queryClient.getQueryState(allSystemExecutionOptionsQueryKeyPrefix())
        ?.isInvalidated,
    ).toBeUndefined();
    expect(queryClient.getQueryState(executionOptionsKey)?.isInvalidated).toBe(
      true,
    );
    expect(
      queryClient.getQueryState(allThreadComposerBootstrapQueryKeyPrefix())
        ?.isInvalidated,
    ).toBeUndefined();
    expect(queryClient.getQueryState(composerBootstrapKey)?.isInvalidated).toBe(
      true,
    );
  });
});
