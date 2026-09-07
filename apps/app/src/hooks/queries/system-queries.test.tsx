// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AvailableModel } from "@bb/domain";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderStatesResponse,
} from "@bb/server-contract";
import type { ProviderInfo } from "@bb/domain";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import type {
  ProviderCliStatusResponse,
  ProviderUsageResponse,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  hostProviderCliStatusQueryKey,
  systemExecutionOptionsQueryKey,
  systemProviderStatesQueryKey,
  systemProvidersQueryKey,
} from "./query-keys";
import {
  useHostProviderCliStatus,
  useSystemExecutionOptions,
  useSystemProviderInfo,
  useSystemProviderUsageLimits,
  useSystemProviders,
  useSystemProviderStates,
} from "./system-queries";

vi.mock("@/lib/sdk", () => ({
  BbHttpError: class BbHttpError extends Error {},
  sdk: {
    hosts: { providerCliStatus: vi.fn() },
    providers: { list: vi.fn() },
    system: {
      executionOptions: vi.fn(),
      providerStates: vi.fn(),
      usageLimits: vi.fn(),
    },
  },
}));

const EXECUTION_OPTIONS_RESPONSE: SystemExecutionOptionsResponse = {
  providers: [],
  models: [],
  selectedOnlyModels: [],
  permissionCeiling: "full",
  modelLoadError: null,
};

const PROVIDER_CLI_STATUS_RESPONSE = {} as ProviderCliStatusResponse;
const PROVIDERS: ProviderInfo[] = [];

function providerStates(providerId: string): SystemProviderStatesResponse {
  return {
    providers: [
      {
        providerId,
        displayName: providerId,
        status: "ready",
        statusMessage: null,
        planLabel: null,
        accountEmail: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("useSystemProviderInfo", () => {
  it("uses capabilities already loaded by the composer while the provider roster loads", async () => {
    const provider = makeProviderInfo({
      id: "codex",
      displayName: "Codex",
      logoUrl: null,
      capabilities: {
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: true,
        supportsNativeUserQuestion: false,
        supportsFork: true,
        supportsSessionRewind: true,
        modelCatalogScope: "workspace",
        permissionModes: ["accept-edits", "auto", "full"],
      },
    });
    vi.mocked(sdk.providers.list).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      systemExecutionOptionsQueryKey({
        environmentId: "env-remote",
        hostId: null,
        providerId: "codex",
      }),
      { ...EXECUTION_OPTIONS_RESPONSE, providers: [provider] },
    );

    const { result } = renderHook(
      () =>
        useSystemProviderInfo({
          environmentId: "env-remote",
          providerId: "codex",
        }),
      { wrapper },
    );

    expect(result.current).toBe(provider);
    await waitFor(() => {
      expect(sdk.providers.list).toHaveBeenCalledOnce();
    });
  });

  it("loads routed provider capabilities without waiting for model discovery", async () => {
    const providers: ProviderInfo[] = [
      makeProviderInfo({
        id: "codex",
        displayName: "Codex",
        logoUrl: null,
        capabilities: {
          supportsServiceTier: true,
          supportsSessionRewind: true,
        },
      }),
    ];
    vi.mocked(sdk.providers.list).mockResolvedValue(providers);
    vi.mocked(sdk.system.executionOptions).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useSystemProviderInfo({
          environmentId: "env-remote",
          providerId: "codex",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current?.capabilities.supportsSessionRewind).toBe(true);
    });
    expect(sdk.providers.list).toHaveBeenCalledWith({
      environmentId: "env-remote",
      signal: expect.any(AbortSignal),
    });
    expect(sdk.system.executionOptions).not.toHaveBeenCalled();
  });
});

describe("useSystemProviders", () => {
  it("routes provider metadata through the selected host", async () => {
    vi.mocked(sdk.providers.list).mockResolvedValue(PROVIDERS);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useSystemProviders({ hostId: "host-a" }), { wrapper });

    await waitFor(() => {
      expect(sdk.providers.list).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-a" }),
      );
    });
  });

  it("requests a usage-only provider roster", async () => {
    vi.mocked(sdk.providers.list).mockResolvedValue(PROVIDERS);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(
      () => useSystemProviders({ capability: "usage", hostId: "host-a" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.providers.list).toHaveBeenCalledWith({
        capability: "usage",
        hostId: "host-a",
        signal: expect.any(AbortSignal),
      });
    });
  });

  it("replays only usage-capable providers for a usage query", async () => {
    const provider = (id: string, usage: boolean): ProviderInfo =>
      makeProviderInfo({
        id,
        displayName: id,
        logoUrl: null,
        maintenance: { health: true, usage, installation: false },
        capabilities: { permissionModes: ["full"] },
      });
    const usageProvider = provider("usage-provider", true);
    const unsupportedProvider = provider("unsupported-provider", false);
    vi.mocked(sdk.providers.list).mockResolvedValueOnce([
      usageProvider,
      unsupportedProvider,
    ]);
    const warm = createQueryClientTestHarness();
    const initial = renderHook(() => useSystemProviders({ hostId: "host-a" }), {
      wrapper: warm.wrapper,
    });
    await waitFor(() => {
      expect(initial.result.current.data).toEqual([
        usageProvider,
        unsupportedProvider,
      ]);
    });
    initial.unmount();

    vi.mocked(sdk.providers.list).mockImplementation(
      () => new Promise(() => undefined),
    );
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useSystemProviders({ capability: "usage", hostId: "host-a" }),
      { wrapper: reload.wrapper },
    );

    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data).toEqual([usageProvider]);
  });
});

describe("useSystemExecutionOptions", () => {
  it("waits for the first probe on a cold cache instead of replaying a vendored roster", () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(
      () => new Promise(() => undefined),
    );
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useSystemExecutionOptions({ providerId: "codex" }),
      { wrapper },
    );

    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("keeps dynamic providers visible while another provider's models load", async () => {
    const providers: ProviderInfo[] = [
      makeProviderInfo({
        id: "codex",
        displayName: "Codex",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        capabilities: {
          supportsServiceTier: true,
          supportsSessionRewind: true,
        },
      }),
      makeProviderInfo({
        id: "acp-opencode",
        displayName: "OpenCode",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        capabilities: {
          supportsThreadArchive: false,
          supportsThreadRename: false,
          supportsFork: false,
          permissionModes: ["full"],
        },
      }),
    ];
    let resolveDynamicModels: (
      response: SystemExecutionOptionsResponse,
    ) => void = () => {};
    const dynamicModels = new Promise<SystemExecutionOptionsResponse>(
      (resolve) => {
        resolveDynamicModels = resolve;
      },
    );
    vi.mocked(sdk.system.executionOptions).mockImplementation((args) =>
      args?.providerId === "acp-opencode"
        ? dynamicModels
        : Promise.resolve({ ...EXECUTION_OPTIONS_RESPONSE, providers }),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ providerId }) => useSystemExecutionOptions({ providerId }),
      { initialProps: { providerId: "codex" }, wrapper },
    );

    await waitFor(() => {
      expect(result.current.data?.providers).toEqual(providers);
      expect(result.current.isPlaceholderData).toBe(false);
    });

    rerender({ providerId: "acp-opencode" });

    await waitFor(() => {
      expect(result.current.isPlaceholderData).toBe(true);
      expect(result.current.data?.providers).toEqual(providers);
      expect(result.current.data?.models).toEqual([]);
    });

    resolveDynamicModels({ ...EXECUTION_OPTIONS_RESPONSE, providers });
    await waitFor(() => {
      expect(result.current.isPlaceholderData).toBe(false);
    });
  });

  it("separates requests and cache entries for different hosts", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      args?.hostId === "host-a"
        ? { ...EXECUTION_OPTIONS_RESPONSE, models: [] }
        : { ...EXECUTION_OPTIONS_RESPONSE, selectedOnlyModels: [] },
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(
      () => [
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
        useSystemExecutionOptions({ hostId: "host-b", providerId: "codex" }),
      ],
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-a", providerId: "codex" }),
      );
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-b", providerId: "codex" }),
      );
    });

    const hostAKey = systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId: "host-a",
      providerId: "codex",
    });
    const hostBKey = systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId: "host-b",
      providerId: "codex",
    });
    expect(hostAKey).not.toEqual(hostBKey);
    expect(queryClient.getQueryState(hostAKey)).toBeDefined();
    expect(queryClient.getQueryState(hostBKey)).toBeDefined();
    expect(systemProvidersQueryKey({ hostId: "host-a" })).not.toEqual(
      systemProvidersQueryKey({ hostId: "host-b" }),
    );
  });

  const BUILT_IN_PROVIDERS: ProviderInfo[] = ["codex", "pi"].map((id) =>
    makeProviderInfo({
      id,
      logoUrl: null,
      maintenance: { health: true, usage: true, installation: false },
      capabilities: {
        supportsThreadArchive: false,
        supportsThreadRename: false,
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        supportsFork: true,
        supportsSessionRewind: true,
        modelCatalogScope: "workspace",
        permissionModes: ["accept-edits", "auto", "full"],
      },
    }),
  );
  const CODEX_MODEL: AvailableModel = {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    isDefault: true,
  };
  const CODEX_CATALOG: SystemExecutionOptionsResponse = {
    ...EXECUTION_OPTIONS_RESPONSE,
    providers: BUILT_IN_PROVIDERS,
    models: [CODEX_MODEL],
  };
  const pendingForever = () => new Promise<never>(() => {});

  it("preloads a provider's last verified catalog until the probe lands", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(CODEX_CATALOG);
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
      { wrapper: first.wrapper },
    );
    await waitFor(() =>
      expect(warm.result.current.data).toEqual(CODEX_CATALOG),
    );
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
      { wrapper: reload.wrapper },
    );
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.models).toEqual([CODEX_MODEL]);
    expect(result.current.data?.modelLoadError).toBeNull();
    expect(result.current.data?.permissionCeiling).toBe("accept-edits");
    await waitFor(() =>
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "host-a", providerId: "codex" }),
      ),
    );
  });

  it("replays the host's provider list so a custom provider paints as itself", async () => {
    const customProvider = makeProviderInfo({
      id: "acp:my-agent",
      displayName: "My agent",
      logoUrl: null,
      maintenance: { health: true, usage: true, installation: false },
      capabilities: CODEX_CATALOG.providers[0]!.capabilities,
    });
    const customCatalog: SystemExecutionOptionsResponse = {
      ...CODEX_CATALOG,
      providers: [...CODEX_CATALOG.providers, customProvider],
    };
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(customCatalog);
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({
          hostId: "host-a",
          providerId: customProvider.id,
        }),
      { wrapper: first.wrapper },
    );
    await waitFor(() =>
      expect(warm.result.current.data).toEqual(customCatalog),
    );
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useSystemExecutionOptions({
          hostId: "host-a",
          providerId: customProvider.id,
        }),
      { wrapper: reload.wrapper },
    );
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.providers).toEqual(customCatalog.providers);
    expect(result.current.data?.models).toEqual([CODEX_MODEL]);
  });

  it("withholds the placeholder when the remembered provider is not in any list it can replay", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...CODEX_CATALOG,
      providers: [],
    });
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({
          hostId: "host-a",
          providerId: "acp:my-agent",
        }),
      { wrapper: first.wrapper },
    );
    await waitFor(() => expect(warm.result.current.data).toBeDefined());
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useSystemExecutionOptions({
          hostId: "host-a",
          providerId: "acp:my-agent",
        }),
      { wrapper: reload.wrapper },
    );
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("does not preload a catalog that came from a failed probe", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...CODEX_CATALOG,
      modelLoadError: { providerId: "codex", code: "failed" },
    });
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
      { wrapper: first.wrapper },
    );
    await waitFor(() =>
      expect(warm.result.current.data?.modelLoadError).not.toBeNull(),
    );
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
      { wrapper: reload.wrapper },
    );
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.models).toEqual([]);
  });

  it("does not replay a catalog across environments", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(CODEX_CATALOG);
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({
          environmentId: "env-1",
          providerId: "codex",
        }),
      { wrapper: first.wrapper },
    );
    await waitFor(() =>
      expect(warm.result.current.data).toEqual(CODEX_CATALOG),
    );
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => [
        useSystemExecutionOptions({ providerId: "codex" }),
        useSystemExecutionOptions({
          environmentId: "env-2",
          providerId: "codex",
        }),
        useSystemExecutionOptions({
          environmentId: "env-1",
          providerId: "codex",
        }),
      ],
      { wrapper: reload.wrapper },
    );
    expect(result.current[0]!.isPlaceholderData).toBe(false);
    expect(result.current[0]!.data).toBeUndefined();
    expect(result.current[1]!.isPlaceholderData).toBe(false);
    expect(result.current[1]!.data).toBeUndefined();
    expect(result.current[2]!.isPlaceholderData).toBe(true);
    expect(result.current[2]!.data?.models).toEqual([CODEX_MODEL]);
  });

  it("never preloads a catalog for another provider or another host", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(CODEX_CATALOG);
    const first = createQueryClientTestHarness();
    const warm = renderHook(
      () =>
        useSystemExecutionOptions({ hostId: "host-a", providerId: "codex" }),
      { wrapper: first.wrapper },
    );
    await waitFor(() =>
      expect(warm.result.current.data).toEqual(CODEX_CATALOG),
    );
    warm.unmount();

    vi.mocked(sdk.system.executionOptions).mockImplementation(pendingForever);
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => [
        useSystemExecutionOptions({ hostId: "host-a", providerId: "pi" }),
        useSystemExecutionOptions({ hostId: "host-b", providerId: "codex" }),
      ],
      { wrapper: reload.wrapper },
    );
    expect(result.current[0]!.isPlaceholderData).toBe(true);
    expect(result.current[0]!.data?.models).toEqual([]);
    expect(result.current[1]!.isPlaceholderData).toBe(false);
    expect(result.current[1]!.data).toBeUndefined();
  });

  it("retries one transient failure before surfacing model selector errors", async () => {
    vi.mocked(sdk.system.executionOptions)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(EXECUTION_OPTIONS_RESPONSE);

    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useSystemExecutionOptions({ providerId: "codex" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toBe(EXECUTION_OPTIONS_RESPONSE);
      expect(sdk.system.executionOptions).toHaveBeenCalledTimes(2);
    });
  });

  it("does not retry intentionally aborted model selector requests", async () => {
    vi.mocked(sdk.system.executionOptions).mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useSystemExecutionOptions({ providerId: "codex" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
      expect(sdk.system.executionOptions).toHaveBeenCalledTimes(1);
    });
  });
});

describe("useHostProviderCliStatus", () => {
  it("keeps host CLI status session-static", async () => {
    vi.mocked(sdk.hosts.providerCliStatus).mockResolvedValue(
      PROVIDER_CLI_STATUS_RESPONSE,
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(
      () => useHostProviderCliStatus({ hostId: "host-1", enabled: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.hosts.providerCliStatus).toHaveBeenCalledTimes(1);
    });

    const query = queryClient.getQueryCache().find({
      queryKey: hostProviderCliStatusQueryKey("host-1"),
    });

    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
      }),
    );
  });
});

describe("useSystemProviderStates", () => {
  it("separates provider-state results for different target machines", async () => {
    vi.mocked(sdk.system.providerStates).mockImplementation(async (args) =>
      providerStates(args?.hostId === "host-a" ? "codex" : "claude-code"),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => [
        useSystemProviderStates({ hostId: "host-a", poll: false }),
        useSystemProviderStates({ hostId: "host-b", poll: false }),
      ],
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current[0]?.data?.providers[0]?.providerId).toBe("codex");
      expect(result.current[1]?.data?.providers[0]?.providerId).toBe(
        "claude-code",
      );
    });

    const hostAKey = systemProviderStatesQueryKey({
      environmentId: null,
      hostId: "host-a",
    });
    const hostBKey = systemProviderStatesQueryKey({
      environmentId: null,
      hostId: "host-b",
    });
    expect(hostAKey).not.toEqual(hostBKey);
    expect(queryClient.getQueryState(hostAKey)).toBeDefined();
    expect(queryClient.getQueryState(hostBKey)).toBeDefined();
  });

  it("routes reusable worktrees through their environment", async () => {
    vi.mocked(sdk.system.providerStates).mockResolvedValue(
      providerStates("claude-code"),
    );
    const { wrapper } = createQueryClientTestHarness();

    renderHook(
      () =>
        useSystemProviderStates({ environmentId: "env-remote", poll: false }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.providerStates).toHaveBeenCalledWith({
        environmentId: "env-remote",
        hostId: undefined,
        signal: expect.any(AbortSignal),
      });
    });
  });
});

describe("useSystemProviderUsageLimits", () => {
  it("publishes each provider as soon as its request settles", async () => {
    let resolveCodex: (value: ProviderUsageResponse) => void = () => {};
    let resolveClaude: (value: ProviderUsageResponse) => void = () => {};
    vi.mocked(sdk.system.usageLimits).mockImplementation((args) => {
      if (args?.providerId === "codex") {
        return new Promise((resolve) => {
          resolveCodex = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveClaude = resolve;
      });
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useSystemProviderUsageLimits({
          hostId: "host-1",
          providerIds: ["codex", "claude-code"],
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.usageLimits).toHaveBeenCalledTimes(2);
    });
    expect(result.current.providerStates).toEqual({
      codex: { isError: false, isLoading: true },
      "claude-code": { isError: false, isLoading: true },
    });

    await act(async () => {
      resolveCodex({ codex: { status: "unauthenticated" } });
    });
    await waitFor(() => {
      expect(result.current.usage.codex).toEqual({
        status: "unauthenticated",
      });
    });
    expect(result.current.usage["claude-code"]).toBeUndefined();
    expect(result.current.providerStates).toEqual({
      codex: { isError: false, isLoading: false },
      "claude-code": { isError: false, isLoading: true },
    });

    await act(async () => {
      resolveClaude({ "claude-code": { status: "unauthenticated" } });
    });
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });
});
