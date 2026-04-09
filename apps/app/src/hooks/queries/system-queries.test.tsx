// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  useCloudAuthAttempt,
  useCloudAuthSettings,
  useHost,
  useSandboxEnvVars,
} from "./system-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getCloudAuthAttempt: vi.fn(),
    getCloudAuthSettings: vi.fn(),
    getHost: vi.fn(),
    listSandboxEnvVars: vi.fn(),
  };
});

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
  vi.clearAllMocks();
});

describe("useHost", () => {
  it("fetches a single host by id", async () => {
    vi.mocked(api.getHost).mockResolvedValue(makeHost());

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useHost("host-1"), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.id).toBe("host-1");
    });

    expect(api.getHost).toHaveBeenCalledWith("host-1");
  });

  it("stays disabled without a host id", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useHost(undefined), { wrapper });

    expect(result.current.fetchStatus).toBe("idle");
    expect(api.getHost).not.toHaveBeenCalled();
  });
});

describe("cloud auth system queries", () => {
  it("fetches cloud auth settings when enabled", async () => {
    vi.mocked(api.getCloudAuthSettings).mockResolvedValue({
      connections: [],
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCloudAuthSettings(true), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual({ connections: [] });
    });

    expect(api.getCloudAuthSettings).toHaveBeenCalledTimes(1);
  });

  it("fetches cloud auth attempt status only when an attempt id is present", async () => {
    vi.mocked(api.getCloudAuthAttempt).mockResolvedValue({
      attemptId: "attempt-1",
      errorMessage: null,
      providerId: "codex",
      status: "completed",
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useCloudAuthAttempt("attempt-1", true),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data?.status).toBe("completed");
    });

    expect(api.getCloudAuthAttempt).toHaveBeenCalledWith("attempt-1");
  });

  it("stays disabled for cloud auth attempt queries without an attempt id", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useCloudAuthAttempt(null, true),
      { wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(api.getCloudAuthAttempt).not.toHaveBeenCalled();
  });

  it("fetches sandbox env vars when enabled", async () => {
    vi.mocked(api.listSandboxEnvVars).mockResolvedValue({
      envVars: [
        {
          createdAt: 1,
          name: "OPENAI_API_KEY",
          updatedAt: 2,
        },
      ],
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSandboxEnvVars(true), { wrapper });

    await waitFor(() => {
      expect(result.current.data?.envVars).toHaveLength(1);
    });

    expect(api.listSandboxEnvVars).toHaveBeenCalledTimes(1);
  });
});
