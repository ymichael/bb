// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import {
  cloudAuthAttemptQueryKey,
  cloudAuthSettingsQueryKey,
  hostQueryKey,
  sandboxEnvVarsQueryKey,
} from "./query-keys";
import {
  useCloudAuthAttempt,
  useCloudAuthSettings,
  useHost,
  useSandboxEnvVars,
} from "./system-queries";

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    createdAt: 1,
    id: "host-1",
    lastSeenAt: 1,
    name: "Sandbox Host",
    status: "connected",
    type: "ephemeral",
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useHost", () => {
  it("fetches a single host by id and caches it under the host query key", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/hosts/host-1",
        handler: async () => jsonResponse(makeHost()),
      },
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useHost("host-1"), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.id).toBe("host-1");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(hostQueryKey("host-1"))).toEqual(
      makeHost(),
    );
  });

  it("stays disabled without a host id", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useHost(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("cloud auth system queries", () => {
  it("fetches cloud auth settings from the real API path and reuses the cache", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/system/cloud-auth",
        handler: async () => jsonResponse({
          connections: [],
        }),
      },
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const first = renderHook(() => useCloudAuthSettings(true), { wrapper });

    await waitFor(() => {
      expect(first.result.current.data).toEqual({ connections: [] });
    });

    const second = renderHook(() => useCloudAuthSettings(true), { wrapper });

    await waitFor(() => {
      expect(second.result.current.data).toEqual({ connections: [] });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(cloudAuthSettingsQueryKey())).toEqual({
      connections: [],
    });
  });

  it("fetches cloud auth attempt status from the attempt endpoint and stores it under the attempt key", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/system/cloud-auth/attempts/attempt-1",
        handler: async () => jsonResponse({
          attemptId: "attempt-1",
          errorMessage: null,
          providerId: "codex",
          status: "completed",
        }),
      },
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useCloudAuthAttempt("attempt-1", true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data?.status).toBe("completed");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(cloudAuthAttemptQueryKey("attempt-1"))).toEqual({
      attemptId: "attempt-1",
      errorMessage: null,
      providerId: "codex",
      status: "completed",
    });
  });

  it("stays disabled for cloud auth attempt queries without an attempt id", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useCloudAuthAttempt(null, true),
      { wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
  });

  it("keeps sandbox env var queries distinct from cloud auth queries", async () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/system/cloud-auth",
        handler: async () => jsonResponse({
          connections: [],
        }),
      },
      {
        pathname: "/api/v1/system/sandbox-env-vars",
        handler: async () => jsonResponse({
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
