// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderStatesResponse,
} from "@bb/server-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import type { ProviderModelCatalogScope } from "@bb/domain";
import type { QueryClient } from "@tanstack/react-query";
import { hostsQueryKey, systemProvidersQueryKey } from "./queries/query-keys";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { useThreadCreationOptions } from "./useThreadCreationOptions";
import {
  providerListCacheKey,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";

const PROJECT_ID = "proj_prompt_defaults";
const GLOBAL_PROVIDER_ID = "global-provider";
const PROJECT_PROVIDER_ID = "project-provider";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      executionOptions: vi.fn(),
      providerStates: vi.fn(),
    },
  },
}));

function readyProviderStates(providerId: string): SystemProviderStatesResponse {
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

function seedDeclaredCatalogScope(
  queryClient: QueryClient,
  providerId: string,
  modelCatalogScope: ProviderModelCatalogScope,
): void {
  const template = executionOptionsResponse().providers[0];
  if (template === undefined) {
    throw new Error("fixture has no provider to clone");
  }
  queryClient.setQueryData(
    systemProvidersQueryKey({
      capability: null,
      environmentId: null,
      hostId: null,
    }),
    [
      {
        ...template,
        id: providerId,
        capabilities: { ...template.capabilities, modelCatalogScope },
      },
    ],
  );
}

function rememberedProviders() {
  const base = executionOptionsResponse().providers;
  const template = base[0];
  if (template === undefined) {
    throw new Error("execution-options fixture has no provider");
  }
  return [
    {
      ...template,
      id: "codex",
      displayName: "Codex",
      logoUrl: "/api/v1/system/providers/codex/logo",
    },
    ...base,
  ];
}

function executionOptionsResponse(): SystemExecutionOptionsResponse {
  return {
    providers: [
      makeProviderInfo({
        id: GLOBAL_PROVIDER_ID,
        displayName: "Global Provider",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [
          { kind: "skills", trigger: "/" },
          {
            kind: "plan",
            command: { trigger: "/", name: "plan", trailingText: " " },
          },
        ],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
      makeProviderInfo({
        id: PROJECT_PROVIDER_ID,
        displayName: "Project Provider",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [{ kind: "skills", trigger: "/" }],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
    ],
    models: [
      {
        id: "global-model",
        model: "global-model",
        displayName: "Global Model",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
      {
        id: "project-model",
        model: "project-model",
        displayName: "Project Model",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  };
}

function providerExecutionOptionsResponse(
  providerId: string | undefined,
): SystemExecutionOptionsResponse {
  const base = executionOptionsResponse();
  const isProjectProvider = providerId === PROJECT_PROVIDER_ID;
  const modelPrefix = isProjectProvider ? "project" : "global";
  return {
    ...base,
    models: [
      {
        id: `${modelPrefix}-default`,
        model: `${modelPrefix}-default`,
        displayName: `${modelPrefix} default`,
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: isProjectProvider ? "high" : "low",
        isDefault: true,
      },
      {
        id: `${modelPrefix}-remembered`,
        model: `${modelPrefix}-remembered`,
        displayName: `${modelPrefix} remembered`,
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
  };
}

function claudeExecutionOptionsResponse(): SystemExecutionOptionsResponse {
  return {
    providers: [
      makeProviderInfo({
        id: "claude-code",
        displayName: "Claude Code",
        logoUrl: null,
        maintenance: { health: true, usage: true, installation: false },
        composerActions: [],
        capabilities: {
          supportsThreadArchive: true,
          supportsThreadRename: true,
          supportsServiceTier: true,
          supportsNativeUserQuestion: true,
          supportsFork: true,
          supportsSessionRewind: true,
          modelCatalogScope: "workspace",
          permissionModes: ["accept-edits", "auto", "full"],
        },
      }),
    ],
    models: [
      {
        id: "claude-opus-4-8[1m]",
        model: "claude-opus-4-8[1m]",
        displayName: "Opus 4.8 (1M)",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
      {
        id: "claude-sonnet-5",
        model: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "" },
          { reasoningEffort: "high", description: "" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
    ],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
  };
}

function claudeThreadCreationArgs(resetKey: string, initialModel: string) {
  return {
    scope: "component-local" as const,
    resetKey,
    initialProviderId: "claude-code",
    initialModel,
    initialReasoningLevel: "high" as const,
    initialPermissionMode: "full" as const,
  };
}

function setProjectScopedValue(baseKey: string, value: string): void {
  window.localStorage.setItem(
    getProjectScopedStorageKey(baseKey, PROJECT_ID),
    value,
  );
}

beforeEach(() => {
  vi.mocked(sdk.system.executionOptions).mockResolvedValue(
    executionOptionsResponse(),
  );
  vi.mocked(sdk.system.providerStates).mockResolvedValue({ providers: [] });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("useThreadCreationOptions", () => {
  it("keeps the selected remembered provider branded while models load", () => {
    window.localStorage.setItem("bb.promptbox.provider", "codex");
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      rememberedProviders(),
    );
    vi.mocked(sdk.system.executionOptions).mockImplementation(
      () => new Promise(() => undefined),
    );

    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    expect(result.current.isLoadingModels).toBe(true);
    expect(result.current.selectedProviderId).toBe("codex");
    expect(
      result.current.providerOptions.find((option) => option.value === "codex")
        ?.icon,
    ).toBeDefined();
  });

  it("does not switch away from a provider when its failed plugin response arrives", async () => {
    window.localStorage.setItem("bb.promptbox.provider", "codex");
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      rememberedProviders(),
    );
    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    const optionsPromise = new Promise<SystemExecutionOptionsResponse>(
      (resolve) => {
        resolveOptions = resolve;
      },
    );
    vi.mocked(sdk.system.executionOptions).mockReturnValue(optionsPromise);
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    act(() => {
      result.current.setSelectedProviderId("codex");
    });
    expect(result.current.selectedProviderId).toBe("codex");

    const base = executionOptionsResponse();
    const templateProvider = base.providers[0];
    if (templateProvider === undefined) {
      throw new Error("execution-options fixture has no provider");
    }
    act(() => {
      resolveOptions({
        ...base,
        providers: [
          {
            ...templateProvider,
            id: "codex",
            pluginId: "provider-codex",
            displayName: "Codex",
            available: false,
          },
          ...base.providers,
        ],
        models: [],
        modelLoadError: {
          providerId: "codex",
          code: "provider_unavailable",
        },
      });
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("codex");
      expect(result.current.modelLoadError).toEqual({
        providerId: "codex",
        code: "provider_unavailable",
      });
      expect(
        result.current.providerOptions.map((option) => option.value),
      ).toContain("codex");
    });
  });

  it("uses the medium product default for providers without reasoning history", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
  });

  it("persists the reconciled reasoning level when switching to a shorter model ladder", async () => {
    const response = executionOptionsResponse();
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...response,
      models: [
        {
          id: "wide-model",
          model: "wide-model",
          displayName: "Wide Model",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
            { reasoningEffort: "xhigh", description: "" },
            { reasoningEffort: "max", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
        {
          id: "short-model",
          model: "short-model",
          displayName: "Short Model",
          description: "",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "" },
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: false,
        },
      ],
    });
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "wide-model",
          initialReasoningLevel: "max",
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("wide-model");
      expect(result.current.reasoningLevel).toBe("max");
    });

    act(() => {
      result.current.setSelectedModel("short-model");
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("short-model");
      expect(result.current.reasoningLevel).toBe("high");
      expect(result.current.executionInputSources.reasoningLevel).toBe(
        "client-preference",
      );
    });

    act(() => {
      result.current.setSelectedModel("wide-model");
    });

    await waitFor(() => {
      expect(result.current.reasoningLevel).toBe("high");
    });
  });

  it("applies a fork provider, model, and reasoning seed atomically", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
    });
    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setProviderModelReasoning({
        providerId: PROJECT_PROVIDER_ID,
        model: "project-remembered",
        reasoningLevel: "high",
      });
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("high");
    });

    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("high");
    });
  });

  it("migrates legacy model preferences without leaking them to another provider", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    window.localStorage.setItem("bb.promptbox.model", "global-remembered");
    window.localStorage.setItem("bb.promptbox.reasoning", "medium");
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { result } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    expect(window.localStorage.getItem("bb.promptbox.model")).toBeNull();

    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });
  });

  it("restores each provider's model and reasoning selection", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result, unmount } = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedModel("project-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });

    unmount();
    const reloaded = renderHook(
      () => useThreadCreationOptions({ scope: "new-thread" }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    await waitFor(() => {
      expect(reloaded.result.current.selectedProviderId).toBe(
        PROJECT_PROVIDER_ID,
      );
      expect(reloaded.result.current.selectedModel).toBe("project-remembered");
      expect(reloaded.result.current.reasoningLevel).toBe("medium");
    });
    act(() => {
      reloaded.result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });
    await waitFor(() => {
      expect(reloaded.result.current.selectedModel).toBe("global-remembered");
      expect(reloaded.result.current.reasoningLevel).toBe("medium");
    });
  });

  it("keeps provider selections local in component-local composers", async () => {
    vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
      providerExecutionOptionsResponse(args?.providerId),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          initialProviderId: GLOBAL_PROVIDER_ID,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-default");
    });
    act(() => {
      result.current.setSelectedModel("global-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(PROJECT_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("project-default");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    act(() => {
      result.current.setSelectedModel("project-remembered");
      result.current.setReasoningLevel("medium");
    });
    act(() => {
      result.current.setSelectedProviderId(GLOBAL_PROVIDER_ID);
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-remembered");
      expect(result.current.reasoningLevel).toBe("medium");
    });
    expect(window.localStorage.getItem("bb.promptbox.model")).toBeNull();
  });

  it("preserves a model's nested provider route for the picker", async () => {
    const response = executionOptionsResponse();
    const firstModel = response.models[0];
    if (!firstModel) throw new Error("Expected a model fixture");
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...response,
      models: [
        { ...firstModel, routeProviderId: "openai-codex" },
        ...response.models.slice(1),
      ],
    });
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.modelOptions[0]).toEqual({
        value: "global-model",
        label: "Global Model",
        routeProviderId: "openai-codex",
      });
    });
  });

  it("routes root-composer provider discovery through the selected project host", async () => {
    window.localStorage.setItem("bb.promptbox.provider", GLOBAL_PROVIDER_ID);
    window.localStorage.setItem("bb.promptbox.model", "global-model");
    window.localStorage.setItem("bb.promptbox.service-tier", "default");
    window.localStorage.setItem("bb.promptbox.reasoning", "high");
    window.localStorage.setItem(
      "bb.promptbox.permission-mode",
      "workspace-write",
    );
    window.localStorage.setItem(
      "bb.promptbox.environment",
      "host:global-host:worktree",
    );

    setProjectScopedValue("bb.promptbox.provider", PROJECT_PROVIDER_ID);
    setProjectScopedValue("bb.promptbox.model", "project-model");
    setProjectScopedValue("bb.promptbox.service-tier", "fast");
    setProjectScopedValue("bb.promptbox.reasoning", "low");
    setProjectScopedValue("bb.promptbox.permission-mode", "readonly");
    setProjectScopedValue(
      "bb.promptbox.environment",
      "host:project-host:local",
    );

    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: "initial-provider",
          initialModel: "initial-model",
          initialServiceTier: "fast",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "host:initial-host:local",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "project-host",
          providerId: GLOBAL_PROVIDER_ID,
        }),
      );
      expect(sdk.system.executionOptions).not.toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "project-host",
          providerId: PROJECT_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(GLOBAL_PROVIDER_ID);
      expect(result.current.selectedProviderComposerActions).toEqual([
        { kind: "skills", trigger: "/" },
        {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        },
      ]);
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.serviceTier).toBe("default");
      expect(result.current.reasoningLevel).toBe("high");
      expect(result.current.permissionMode).toBe("accept-edits");
      expect(result.current.environmentSelectionValue).toBe(
        "host:project-host:local",
      );
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "project-host",
      });
    });
  });

  it("disables permission modes above the machine's permission limit", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue({
      ...executionOptionsResponse(),
      permissionCeiling: "auto",
    });
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "host:capped-host:local",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(
        result.current.permissionModeOptions.map((option) => [
          option.value,
          option.disabled ?? false,
        ]),
      ).toEqual([
        ["accept-edits", false],
        ["auto", false],
        ["full", true],
      ]);
      expect(result.current.permissionMode).toBe("auto");
    });
    expect(
      result.current.permissionModeOptions.find(
        (option) => option.value === "full",
      )?.disabledReason,
    ).toContain("permission limit");
  });

  it("uses the cached machine limit before the routed answer lands", async () => {
    let resolveExecutionOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void;
    vi.mocked(sdk.system.executionOptions).mockReturnValue(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveExecutionOptions = resolve;
      }),
    );
    const { wrapper, queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(hostsQueryKey(), [
      {
        id: "capped-host",
        name: "capped",
        type: "persistent",
        status: "connected",
        maxPermissionMode: "accept-edits",
        lastSeenAt: null,
        lastRejectedProtocolVersion: null,
        createdAt: 0,
        updatedAt: 0,
      },
    ]);

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialPermissionMode: "full",
          initialEnvironmentSelectionValue: "host:capped-host:local",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(
        result.current.permissionModeOptions.find(
          (option) => option.value === "full",
        )?.disabled,
      ).toBe(true);
    });
    resolveExecutionOptions!(executionOptionsResponse());
  });

  it("persists new-thread environment selection under the project key", () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
        }),
      { wrapper },
    );

    act(() => {
      result.current.setEnvironmentSelectionValue("host:project-host:worktree");
    });

    expect(window.localStorage.getItem("bb.promptbox.environment")).toBeNull();
    expect(
      window.localStorage.getItem(
        getProjectScopedStorageKey("bb.promptbox.environment", PROJECT_ID),
      ),
    ).toBe("host:project-host:worktree");
  });

  it("routes a host-scoped component-local catalog by the environment's host", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    seedDeclaredCatalogScope(queryClient, "claude-code", "host");

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_host_scoped",
          initialProviderId: "claude-code",
          initialModel: "claude-opus-5",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: "host_follow_up",
          providerId: "claude-code",
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "host_follow_up",
      });
    });
  });

  it("re-routes to the host once the first probe's own roster declares host scope", async () => {
    const hostScoped = executionOptionsResponse();
    const [provider] = hostScoped.providers;
    if (provider === undefined) throw new Error("fixture has no provider");
    provider.capabilities = {
      ...provider.capabilities,
      modelCatalogScope: "host",
    };
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(hostScoped);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_cold_cache",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "model-a",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: "env_follow_up" }),
      );
    });
    await waitFor(() => {
      expect(result.current.executionOptionsRouting).toEqual({
        hostId: "host_follow_up",
      });
    });
  });

  it("keeps a workspace-scoped component-local catalog routed by environment", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    seedDeclaredCatalogScope(queryClient, "pi", "workspace");

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: "env_follow_up",
          environmentHostId: "host_follow_up",
          resetKey: "thr_workspace_scoped",
          initialProviderId: "pi",
          initialModel: "anthropic/opus",
          initialReasoningLevel: "medium",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "env_follow_up",
          hostId: undefined,
          providerId: "pi",
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        environmentId: "env_follow_up",
      });
    });
  });

  it("loads provider composer actions for environmentless component-local threads", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          environmentId: undefined,
          resetKey: "thr_environmentless",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "global-model",
          initialServiceTier: "default",
          initialReasoningLevel: "medium",
          initialPermissionMode: "accept-edits",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          providerId: GLOBAL_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(GLOBAL_PROVIDER_ID);
      expect(result.current.selectedProviderComposerActions).toEqual([
        { kind: "skills", trigger: "/" },
        {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        },
      ]);
    });
  });

  it("marks a definitive missing component-local model fallback as explicit", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_stale_model",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "claude-mythos-5",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("overrides a stale project model default when creating a new thread", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferenceProjectId: PROJECT_ID,
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "removed-project-default",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("global-model");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("keeps an existing model when provider discovery fails temporarily", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValueOnce({
      ...executionOptionsResponse(),
      modelLoadError: { providerId: GLOBAL_PROVIDER_ID, code: "failed" },
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_model_discovery_failure",
          initialProviderId: GLOBAL_PROVIDER_ID,
          initialModel: "still-valid-model",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.modelLoadFailed).toBe(true);
      expect(result.current.selectedModel).toBe("still-valid-model");
      expect(result.current.executionInputSources.model).toBeUndefined();
    });
  });

  it("keeps a stored model through a cold-cache probe and recovers only once it lands", async () => {
    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    vi.mocked(sdk.system.executionOptions).mockReturnValueOnce(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "component-local",
          resetKey: "thr_claude_preload",
          initialProviderId: "claude-code",
          initialModel: "claude-mythos-5",
          initialReasoningLevel: "high",
          initialPermissionMode: "full",
        }),
      { wrapper },
    );

    expect(result.current.modelOptions).toEqual([]);
    expect(result.current.selectedModel).toBe("claude-mythos-5");
    expect(result.current.executionInputSources.model).toBeUndefined();

    act(() => {
      resolveOptions(claudeExecutionOptionsResponse());
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("claude-opus-4-8[1m]");
      expect(result.current.executionInputSources.model).toBe("explicit");
    });
  });

  it("preloads the account's real model ids so a preload-window pick survives", async () => {
    vi.mocked(sdk.system.executionOptions).mockResolvedValue(
      claudeExecutionOptionsResponse(),
    );

    const first = renderHook(
      () =>
        useThreadCreationOptions(
          claudeThreadCreationArgs("thr_cached_first", "claude-opus-4-8[1m]"),
        ),
      { wrapper: createQueryClientTestHarness().wrapper },
    );
    await waitFor(() => {
      expect(
        first.result.current.modelOptions.map((option) => option.value),
      ).toEqual(["claude-opus-4-8[1m]", "claude-sonnet-5"]);
    });
    first.unmount();

    let resolveOptions: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    vi.mocked(sdk.system.executionOptions).mockReturnValueOnce(
      new Promise<SystemExecutionOptionsResponse>((resolve) => {
        resolveOptions = resolve;
      }),
    );
    const second = renderHook(
      () =>
        useThreadCreationOptions(
          claudeThreadCreationArgs("thr_cached_second", "claude-sonnet-5"),
        ),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(
        second.result.current.modelOptions.map((option) => option.value),
      ).toEqual(["claude-opus-4-8[1m]", "claude-sonnet-5"]);
    });
    expect(second.result.current.selectedModel).toBe("claude-sonnet-5");

    act(() => {
      resolveOptions(claudeExecutionOptionsResponse());
    });

    await waitFor(() => {
      expect(second.result.current.selectedModel).toBe("claude-sonnet-5");
      expect(second.result.current.executionInputSources.model).toBeUndefined();
    });
  });

  it("lets the server resolve the catalog default when no selection exists", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useThreadCreationOptions(), { wrapper });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: undefined,
          hostId: undefined,
          providerId: undefined,
        }),
      );
    });
  });

  it("latches the initial ready provider instead of resolving it again after a machine switch", async () => {
    window.localStorage.setItem(
      "bb.promptbox.environment",
      "host:remote-host:local",
    );
    vi.mocked(sdk.system.providerStates).mockImplementation(async (args) =>
      args?.hostId === "remote-host"
        ? readyProviderStates(PROJECT_PROVIDER_ID)
        : readyProviderStates(GLOBAL_PROVIDER_ID),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
          preferReadyProviderWhenUnset: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.system.providerStates).toHaveBeenCalledWith({
        environmentId: undefined,
        hostId: "remote-host",
        signal: expect.any(AbortSignal),
      });
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
      expect(result.current.executionInputSources).toMatchObject({
        providerId: "client-preference",
      });
      expect(result.current.executionInputSources.model).toBeUndefined();
    });
    const initialDiscoveryCallCount = vi.mocked(sdk.system.providerStates).mock
      .calls.length;

    act(() => {
      result.current.setEnvironmentSelectionValue("host:second-host:local");
    });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "second-host",
          providerId: PROJECT_PROVIDER_ID,
        }),
      );
      expect(result.current.selectedProviderId).toBe(PROJECT_PROVIDER_ID);
    });
    expect(sdk.system.providerStates).toHaveBeenCalledTimes(
      initialDiscoveryCallCount,
    );
    expect(sdk.system.providerStates).not.toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "second-host" }),
    );
  });

  it("routes reusable root-composer worktrees through their environment", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          scope: "new-thread",
        }),
      { wrapper },
    );

    act(() => {
      result.current.setEnvironmentSelectionValue("reuse:env-remote");
    });

    await waitFor(() => {
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: "env-remote",
          hostId: undefined,
          providerId: undefined,
        }),
      );
      expect(result.current.executionOptionsRouting).toEqual({
        environmentId: "env-remote",
      });
    });
  });
});
