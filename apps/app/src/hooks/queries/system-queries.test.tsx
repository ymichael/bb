// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  cloudAuthSettingsQueryKey,
  sandboxEnvVarsQueryKey,
  systemProvidersQueryKey,
} from "./query-keys";
import {
  useCloudAuthSettings,
  useSandboxEnvVars,
  useSystemExecutionOptions,
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

describe("system execution options query", () => {
  it("does not mirror execution-options responses into the providers cache", async () => {
    installFetchRoutes([
      {
        pathname: "/api/v1/system/execution-options",
        handler: async () =>
          jsonResponse({
            providers: [
              {
                id: "codex",
                displayName: "Codex",
                available: true,
                capabilities: {
                  supportsArchive: true,
                  supportsRename: true,
                  supportsServiceTier: true,
                  supportedPermissionModes: [
                    "full",
                    "workspace-write",
                    "readonly",
                  ],
                },
              },
            ],
            models: [
              {
                id: "gpt-5.5",
                model: "gpt-5.5",
                displayName: "GPT-5.5",
                description: "Frontier model",
                supportedReasoningEfforts: [
                  {
                    reasoningEffort: "medium",
                    description: "Balanced",
                  },
                ],
                defaultReasoningEffort: "medium",
                isDefault: true,
              },
            ],
          }),
      },
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const executionOptions = renderHook(
      () => useSystemExecutionOptions({ providerId: "codex" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(executionOptions.result.current.data?.providers[0]?.id).toBe(
        "codex",
      );
    });

    expect(queryClient.getQueryData(systemProvidersQueryKey())).toBeUndefined();
  });
});
