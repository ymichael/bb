import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import {
  environmentDiffFilesQueryKey,
  environmentDiffPatchQueryKey,
  environmentWorkStatusQueryKey,
  systemExecutionOptionsQueryKey,
} from "./queries/query-keys";
import { removeEnvironmentScopedQueries } from "./cache-owners/environment-cache-effects";

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
    hostId: null,
    providerId: "codex",
  });
}

const EMPTY_EXECUTION_OPTIONS = {
  providers: [],
  models: [],
  selectedOnlyModels: [],
  modelLoadError: null,
};

describe("environment cache effects", () => {
  it("removes env-scoped execution options caches on cleanup", () => {
    const queryClient = createCacheEffectQueryClient();
    const removedExecutionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-removed",
    });
    const retainedExecutionOptionsKey = scopedSystemExecutionOptionsKey({
      environmentId: "env-retained",
    });
    const removedWorkStatusKey = environmentWorkStatusQueryKey(
      "env-removed",
      "main",
    );
    queryClient.setQueryData(
      removedExecutionOptionsKey,
      EMPTY_EXECUTION_OPTIONS,
    );
    queryClient.setQueryData(
      retainedExecutionOptionsKey,
      EMPTY_EXECUTION_OPTIONS,
    );
    queryClient.setQueryData(removedWorkStatusKey, {});

    removeEnvironmentScopedQueries({
      environmentId: "env-removed",
      queryClient,
    });

    expect(
      queryClient.getQueryData(removedExecutionOptionsKey),
    ).toBeUndefined();
    expect(queryClient.getQueryData(removedWorkStatusKey)).toBeUndefined();
    expect(queryClient.getQueryData(retainedExecutionOptionsKey)).toEqual(
      EMPTY_EXECUTION_OPTIONS,
    );
  });

  it("removes both the diff TOC and the observer-less patch cache for the torn-down environment", () => {
    const queryClient = createCacheEffectQueryClient();
    const removedDiffFilesKey = environmentDiffFilesQueryKey(
      "env-removed",
      "all",
      "main",
    );
    const removedDiffPatchKey = environmentDiffPatchQueryKey(
      "env-removed",
      "all",
      "main",
      "file.ts",
    );
    const retainedDiffFilesKey = environmentDiffFilesQueryKey(
      "env-retained",
      "all",
      "main",
    );
    const retainedDiffPatchKey = environmentDiffPatchQueryKey(
      "env-retained",
      "all",
      "main",
      "file.ts",
    );
    queryClient.setQueryData(removedDiffFilesKey, {
      outcome: "available",
      files: [],
      shortstat: "1 file changed",
      mergeBaseRef: "base-ref",
    });
    queryClient.setQueryData(removedDiffPatchKey, {
      path: "file.ts",
      patch: "diff --git a/file.ts b/file.ts\n",
      truncated: false,
    });
    queryClient.setQueryData(retainedDiffFilesKey, {
      outcome: "available",
      files: [],
      shortstat: "1 file changed",
      mergeBaseRef: "base-ref",
    });
    queryClient.setQueryData(retainedDiffPatchKey, {
      path: "file.ts",
      patch: "diff --git a/file.ts b/file.ts\n",
      truncated: false,
    });

    removeEnvironmentScopedQueries({
      environmentId: "env-removed",
      queryClient,
    });

    expect(queryClient.getQueryData(removedDiffFilesKey)).toBeUndefined();
    expect(queryClient.getQueryData(removedDiffPatchKey)).toBeUndefined();
    expect(queryClient.getQueryData(retainedDiffFilesKey)).toBeDefined();
    expect(queryClient.getQueryData(retainedDiffPatchKey)).toBeDefined();
  });
});
