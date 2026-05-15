import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  environmentWorkStatusQueryKey,
  systemExecutionOptionsQueryKey,
  threadComposerBootstrapQueryKey,
} from "./queries/query-keys";
import { removeEnvironmentScopedQueries } from "./environment-cache-effects";

interface ScopedSystemExecutionOptionsKeyArgs {
  environmentId: string;
}

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

function scopedSystemExecutionOptionsKey({
  environmentId,
}: ScopedSystemExecutionOptionsKeyArgs) {
  return systemExecutionOptionsQueryKey({
    environmentId,
    providerId: "codex",
  });
}

describe("environment cache effects", () => {
  it("removes env-scoped execution options and composer bootstrap caches on cleanup", () => {
    const queryClient = createCacheEffectQueryClient();
    const removedExecutionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-removed",
    });
    const retainedExecutionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-retained",
    });
    const removedComposerBootstrapKey = threadComposerBootstrapQueryKey(
      "thread-removed",
      "env-removed",
    );
    const retainedComposerBootstrapKey = threadComposerBootstrapQueryKey(
      "thread-retained",
      "env-retained",
    );
    const removedWorkStatusKey = environmentWorkStatusQueryKey(
      "env-removed",
      "main",
    );
    queryClient.setQueryData(removedExecutionOptionsKey, {
      providers: [],
      models: [],
    });
    queryClient.setQueryData(retainedExecutionOptionsKey, {
      providers: [],
      models: [],
    });
    queryClient.setQueryData(removedComposerBootstrapKey, {
      defaultExecutionOptions: null,
      queuedMessages: [],
      executionOptions: { providers: [], models: [] },
      pendingInteractions: [],
      promptHistory: [],
    });
    queryClient.setQueryData(retainedComposerBootstrapKey, {
      defaultExecutionOptions: null,
      queuedMessages: [],
      executionOptions: { providers: [], models: [] },
      pendingInteractions: [],
      promptHistory: [],
    });
    queryClient.setQueryData(removedWorkStatusKey, {});

    removeEnvironmentScopedQueries({
      environmentId: "env-removed",
      queryClient,
    });

    expect(
      queryClient.getQueryData(removedExecutionOptionsKey),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(removedComposerBootstrapKey),
    ).toBeUndefined();
    expect(queryClient.getQueryData(removedWorkStatusKey)).toBeUndefined();
    expect(queryClient.getQueryData(retainedExecutionOptionsKey)).toEqual({
      providers: [],
      models: [],
    });
    expect(queryClient.getQueryData(retainedComposerBootstrapKey)).toEqual({
      defaultExecutionOptions: null,
      queuedMessages: [],
      executionOptions: { providers: [], models: [] },
      pendingInteractions: [],
      promptHistory: [],
    });
  });
});
