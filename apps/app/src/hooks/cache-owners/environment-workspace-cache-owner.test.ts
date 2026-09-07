import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { threadSearchQueryKey } from "../queries/query-keys";
import { applyEnvironmentUpdateResult } from "./environment-workspace-cache-owner";

describe("applyEnvironmentUpdateResult", () => {
  it("invalidates cached thread search rows that render environment metadata", () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          gcTime: Infinity,
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    const threadSearchKey = threadSearchQueryKey({
      limitPerGroup: 20,
      query: "renamed",
    });
    queryClient.setQueryData(threadSearchKey, {
      active: { results: [], total: 0 },
      archived: { results: [], total: 0 },
    });

    applyEnvironmentUpdateResult({
      environment: makeEnvironment({
        baseBranch: null,
        branchName: "main",
        createdAt: 1000,
        hostId: "host_1",
        id: "env_1",
        name: "Renamed environment",
        path: "/tmp/project",
        projectId: "proj_1",
        updatedAt: 2000,
      }),
      queryClient,
    });

    expect(queryClient.getQueryState(threadSearchKey)?.isInvalidated).toBe(
      true,
    );
  });
});
