// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  cloudAuthSettingsQueryKey,
  sandboxEnvVarsQueryKey,
} from "./query-keys";
import {
  useCloudAuthSettings,
  useSandboxEnvVars,
} from "./system-queries";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cloud auth system queries", () => {
  it("keeps sandbox env var queries distinct from cloud auth queries", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/system/cloud-auth",
        handler: async () =>
          jsonResponse({
            connections: [],
          }),
      },
      {
        pathname: "/api/v1/system/sandbox-env-vars",
        handler: async () =>
          jsonResponse({
            envVars: [
              {
                createdAt: 1,
                name: "OPENAI_API_KEY",
                updatedAt: 2,
              },
            ],
          }),
      },
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const cloudAuth = renderHook(() => useCloudAuthSettings(true), { wrapper });
    const sandboxEnv = renderHook(() => useSandboxEnvVars(true), { wrapper });

    await waitFor(() => {
      expect(cloudAuth.result.current.data).toEqual({ connections: [] });
      expect(sandboxEnv.result.current.data?.envVars).toEqual([
        {
          createdAt: 1,
          name: "OPENAI_API_KEY",
          updatedAt: 2,
        },
      ]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(cloudAuthSettingsQueryKey())).toEqual({
      connections: [],
    });
    expect(queryClient.getQueryData(sandboxEnvVarsQueryKey())).toEqual({
      envVars: [
        {
          createdAt: 1,
          name: "OPENAI_API_KEY",
          updatedAt: 2,
        },
      ],
    });
  });
});
