// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AvailableModel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  formatModelLabel,
  useThreadCreationOptions,
} from "./useThreadCreationOptions";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getAvailableModels: vi.fn(),
    listSystemProviders: vi.fn(),
  };
});

interface ProviderOverrides extends Partial<SystemProviderInfo> {}

interface ModelOverrides extends Partial<AvailableModel> {}

const PERMISSION_MODE_OPTIONS = [
  {
    value: "full",
    label: "Full Access",
    tone: "warning",
  },
  {
    value: "workspace-write",
    label: "Workspace Write",
  },
  {
    value: "readonly",
    label: "Readonly",
  },
] as const;

function makeProvider(overrides: ProviderOverrides = {}): SystemProviderInfo {
  return {
    available: true,
    capabilities: {
      supportsRename: true,
      supportsServiceTier: false,
      supportedPermissionModes: ["full", "workspace-write", "readonly"],
    },
    displayName: "Codex",
    id: "codex",
    ...overrides,
  };
}

function makeModel(overrides: ModelOverrides = {}): AvailableModel {
  return {
    defaultReasoningEffort: "medium",
    description: "Model description",
    displayName: "gpt-5.4",
    id: "model-id",
    isDefault: true,
    model: "gpt-5.4",
    supportedReasoningEfforts: [
      {
        description: "Low effort",
        reasoningEffort: "low",
      },
      {
        description: "Medium effort",
        reasoningEffort: "medium",
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("formatModelLabel", () => {
  it("strips the Claude prefix for the claude-code provider", () => {
    expect(formatModelLabel("Claude Sonnet 4.6", "claude-code")).toBe("Sonnet 4.6");
  });

  it("preserves GPT capitalization", () => {
    expect(formatModelLabel("gpt-5.4")).toBe("GPT-5.4");
  });
});

describe("useThreadCreationOptions", () => {
  it("falls back to valid provider and model values from query data", async () => {
    const projectId = "project-1";
    localStorage.setItem(getProjectScopedStorageKey("bb.promptbox.provider", projectId), "missing");
    localStorage.setItem(getProjectScopedStorageKey("bb.promptbox.model", projectId), "missing-model");
    localStorage.setItem(getProjectScopedStorageKey("bb.promptbox.reasoning", projectId), "xhigh");
    localStorage.setItem(getProjectScopedStorageKey("bb.promptbox.service-tier", projectId), "fast");

    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        capabilities: {
          supportsRename: true,
          supportsServiceTier: false,
          supportedPermissionModes: ["full", "workspace-write", "readonly"],
        },
        displayName: "Codex",
        id: "codex",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockResolvedValue([
      makeModel({
        defaultReasoningEffort: "low",
        displayName: "gpt-5.4",
        id: "gpt-5.4",
        model: "gpt-5.4",
        supportedReasoningEfforts: [
          {
            description: "Low effort",
            reasoningEffort: "low",
          },
          {
            description: "Medium effort",
            reasoningEffort: "medium",
          },
        ],
      }),
    ]);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          projectId,
          scope: "new-thread",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("codex");
    });

    expect(result.current.selectedModel).toBe("gpt-5.4");
    expect(result.current.reasoningLevel).toBe("low");
    expect(result.current.permissionMode).toBe("full");
    expect(result.current.permissionModeOptions).toEqual(PERMISSION_MODE_OPTIONS);
    expect(result.current.serviceTier).toBeUndefined();
    expect(result.current.supportsServiceTier).toBe(false);
  });

  it("filters permission modes by provider capabilities and falls back to full", async () => {
    const projectId = "project-pi";
    localStorage.setItem(getProjectScopedStorageKey("bb.promptbox.permission-mode", projectId), "readonly");

    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        capabilities: {
          supportsRename: false,
          supportsServiceTier: false,
          supportedPermissionModes: ["full"],
        },
        displayName: "Pi",
        id: "pi",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockResolvedValue([
      makeModel({
        displayName: "pi",
        id: "pi",
        model: "pi",
      }),
    ]);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          projectId,
          scope: "new-thread",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("pi");
    });

    expect(result.current.permissionMode).toBe("full");
    expect(result.current.supportsPermissionModeSelection).toBe(false);
    expect(result.current.permissionModeOptions).toEqual([PERMISSION_MODE_OPTIONS[0]]);
  });

  it("persists new-thread selections to project-scoped local storage", async () => {
    const projectId = "project-storage";

    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        capabilities: {
          supportsRename: true,
          supportsServiceTier: true,
          supportedPermissionModes: ["full", "workspace-write", "readonly"],
        },
        id: "codex",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockResolvedValue([
      makeModel({
        id: "gpt-5.4",
        model: "gpt-5.4",
      }),
      makeModel({
        defaultReasoningEffort: "high",
        displayName: "gpt-5.4-mini",
        id: "gpt-5.4-mini",
        isDefault: false,
        model: "gpt-5.4-mini",
        supportedReasoningEfforts: [
          {
            description: "Medium effort",
            reasoningEffort: "medium",
          },
          {
            description: "High effort",
            reasoningEffort: "high",
          },
        ],
      }),
    ]);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          projectId,
          scope: "new-thread",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("gpt-5.4");
    });

    act(() => {
      result.current.setSelectedModel("gpt-5.4-mini");
      result.current.setReasoningLevel("high");
      result.current.setPermissionMode("workspace-write");
      result.current.setServiceTier("fast");
      result.current.setEnvironmentSelectionValue("worktree");
    });

    await waitFor(() => {
      expect(localStorage.getItem(getProjectScopedStorageKey("bb.promptbox.model", projectId)))
        .toBe("gpt-5.4-mini");
    });

    expect(localStorage.getItem(getProjectScopedStorageKey("bb.promptbox.reasoning", projectId)))
      .toBe("high");
    expect(localStorage.getItem(getProjectScopedStorageKey("bb.promptbox.permission-mode", projectId)))
      .toBe("workspace-write");
    expect(localStorage.getItem(getProjectScopedStorageKey("bb.promptbox.service-tier", projectId)))
      .toBe("fast");
    expect(localStorage.getItem(getProjectScopedStorageKey("bb.promptbox.environment", projectId)))
      .toBe("worktree");
  });

  it("preserves touched thread selections until the reset key changes", async () => {
    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        id: "codex",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockResolvedValue([
      makeModel({
        id: "gpt-5.4",
        isDefault: true,
        model: "gpt-5.4",
      }),
      makeModel({
        defaultReasoningEffort: "high",
        displayName: "gpt-5.4-mini",
        id: "gpt-5.4-mini",
        isDefault: false,
        model: "gpt-5.4-mini",
        supportedReasoningEfforts: [
          {
            description: "Medium effort",
            reasoningEffort: "medium",
          },
          {
            description: "High effort",
            reasoningEffort: "high",
          },
        ],
      }),
    ]);

    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ initialModel, resetKey }: { initialModel: string; resetKey: string }) =>
        useThreadCreationOptions({
          initialModel,
          initialProviderId: "codex",
          projectId: "project-thread",
          resetKey,
          scope: "thread",
        }),
      {
        initialProps: {
          initialModel: "gpt-5.4",
          resetKey: "thread-1",
        },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("gpt-5.4");
    });

    act(() => {
      result.current.setSelectedModel("gpt-5.4-mini");
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("gpt-5.4-mini");
    });

    rerender({
      initialModel: "gpt-5.4",
      resetKey: "thread-1",
    });

    expect(result.current.selectedModel).toBe("gpt-5.4-mini");

    rerender({
      initialModel: "gpt-5.4",
      resetKey: "thread-2",
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("gpt-5.4");
    });
  });

  it("switches to the new provider default model when the provider changes", async () => {
    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        displayName: "Codex",
        id: "codex",
      }),
      makeProvider({
        displayName: "Claude Code",
        id: "claude-code",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockImplementation(async (providerId) => {
      if (providerId === "claude-code") {
        return [
          makeModel({
            defaultReasoningEffort: "high",
            displayName: "Claude Sonnet 4.6",
            id: "claude-sonnet-4-6",
            model: "claude-sonnet-4-6",
          }),
        ];
      }

      return [
        makeModel({
          displayName: "gpt-5.4",
          id: "gpt-5.4",
          model: "gpt-5.4",
        }),
      ];
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          projectId: "project-switch",
          scope: "new-thread",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("codex");
    });

    act(() => {
      result.current.setSelectedProviderId("claude-code");
    });

    await waitFor(() => {
      expect(result.current.selectedProviderId).toBe("claude-code");
    });

    await waitFor(() => {
      expect(result.current.selectedModel).toBe("claude-sonnet-4-6");
    });

    expect(result.current.modelOptions).toEqual([
      {
        label: "Sonnet 4.6",
        value: "claude-sonnet-4-6",
      },
    ]);
  });

  it("passes the current model to provider lookup for selected-only runtime models", async () => {
    vi.mocked(api.listSystemProviders).mockResolvedValue([
      makeProvider({
        displayName: "Codex",
        id: "codex",
      }),
      makeProvider({
        displayName: "Claude Code",
        id: "claude-code",
      }),
    ]);
    vi.mocked(api.getAvailableModels).mockImplementation(async (providerId, selectedModel) => {
      if (providerId === "claude-code" && selectedModel === "opus[1m]") {
        return [
          makeModel({
            displayName: "Opus Alias (1M, Legacy)",
            id: "opus[1m]",
            isDefault: false,
            model: "opus[1m]",
          }),
          makeModel({
            defaultReasoningEffort: "xhigh",
            displayName: "Claude Opus 4.7 (1M)",
            id: "claude-opus-4-7[1m]",
            isDefault: true,
            model: "claude-opus-4-7[1m]",
          }),
        ];
      }
      return [
        makeModel({
          displayName: "gpt-5.4",
          id: "gpt-5.4",
          model: "gpt-5.4",
        }),
      ];
    });

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () =>
        useThreadCreationOptions({
          initialModel: "opus[1m]",
          initialProviderId: "claude-code",
          projectId: "project-selected-only",
          scope: "thread",
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(api.getAvailableModels).toHaveBeenCalledWith(
        "claude-code",
        "opus[1m]",
      );
    });
    await waitFor(() => {
      expect(result.current.modelOptions[0]).toEqual({
        label: "Opus Alias (1M, Legacy)",
        value: "opus[1m]",
      });
    });
    expect(result.current.selectedModel).toBe("opus[1m]");
  });
});
