// @vitest-environment jsdom

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AvailableModel, ProviderInfo, ReasoningLevel } from "@bb/domain";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import type { SystemExecutionOptionsResponse } from "@bb/server-contract";
import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import {
  providerListCacheKey,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { PluginProviderModelPicker } from "./PluginProviderModelPicker";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: { list: vi.fn().mockResolvedValue([]) },
    system: {
      config: vi.fn().mockResolvedValue({ primaryHostId: null }),
      executionOptions: vi.fn(),
    },
  },
}));

const providers: ProviderInfo[] = [
  provider("codex", "Codex", "OpenAI", true),
  provider("cursor", "Cursor", "Cursor", true),
  provider("claude-code", "Claude Code", "Claude", false),
];

function provider(
  id: string,
  displayName: string,
  brandPrefix: string,
  supportsServiceTier: boolean,
): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
    strings: {
      signInHint: "Sign in",
      expiredHint: "Sign in again",
      installUrl: "https://example.com/install",
      brandPrefix,
    },
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier,
      supportsNativeUserQuestion: true,
      supportsFork: true,
      supportsSessionRewind: true,
      permissionModes: ["auto"],
      modelCatalogScope: "host",
    },
  });
}

function model(
  id: string,
  displayName: string,
  reasoning: readonly ReasoningLevel[],
  isDefault = false,
): AvailableModel {
  return {
    id,
    model: id,
    displayName,
    description: "",
    supportedReasoningEfforts: reasoning.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: reasoning[0] ?? "medium",
    isDefault,
  };
}

function executionOptions(
  models: AvailableModel[],
  options?: {
    selectedOnlyModels?: AvailableModel[];
    modelLoadError?: SystemExecutionOptionsResponse["modelLoadError"];
  },
): SystemExecutionOptionsResponse {
  return {
    providers,
    models,
    selectedOnlyModels: options?.selectedOnlyModels ?? [],
    permissionCeiling: "full",
    modelLoadError: options?.modelLoadError ?? null,
  };
}

function cacheCatalog(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  providerId: string,
  response: SystemExecutionOptionsResponse,
  hostId: string | null = null,
) {
  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId,
      providerId,
    }),
    response,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("PluginProviderModelPicker", () => {
  it("resolves provider, default model, reasoning, and service tier atomically", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const hostId = "host-remote";
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium", "high"], true),
      ]),
      hostId,
    );
    cacheCatalog(
      queryClient,
      "cursor",
      executionOptions([
        model("cursor-agent", "Cursor Agent", ["medium", "high"], true),
      ]),
      hostId,
    );
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
      return (
        <PluginProviderModelPicker
          value={value}
          routing={{ kind: "host", hostId }}
          className="plugin-picker"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(trigger.classList.contains("plugin-picker")).toBe(true);
    expect(trigger.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTitle("Cursor"));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "cursor",
        model: "cursor-agent",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Agent" })).toBeDefined();
  });

  it("reconciles model capabilities and drops unsupported service tiers", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium", "high"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );
    cacheCatalog(
      queryClient,
      "claude-code",
      executionOptions([model("claude-opus", "Claude Opus", ["xhigh"], true)]),
    );
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "fast",
      });
      return (
        <PluginProviderModelPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });
    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "GPT Light" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
        serviceTier: "fast",
      }),
    );

    const fastMode = screen.getByRole("switch", { name: "Fast mode" });
    expect(fastMode.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(fastMode);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
        serviceTier: "default",
      }),
    );

    fireEvent.click(screen.getByTitle("Claude Code"));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "claude-code",
        model: "claude-opus",
        reasoningLevel: "xhigh",
      }),
    );
  });

  it("normalizes a stale controlled selection after the catalog is verified", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-current", "OpenAI GPT Current", ["medium", "high"], true),
      ]),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-removed",
          reasoningLevel: "ultra",
          serviceTier: "fast",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        providerId: "codex",
        model: "gpt-current",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("preserves a controlled retired model from the selected-only catalog", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions(
        [model("gpt-current", "OpenAI GPT Current", ["medium"], true)],
        {
          selectedOnlyModels: [
            model("gpt-retired", "OpenAI GPT Retired", ["high", "xhigh"]),
          ],
        },
      ),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-retired",
          reasoningLevel: "xhigh",
          serviceTier: "default",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(trigger.textContent).toContain("GPT Retired");
    expect(trigger.querySelector("[title]")?.getAttribute("title")).toContain(
      "Extra High reasoning",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit loading, placeholder, or failed provider catalogs", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true)]),
    );
    writeCachedModelCatalog(
      modelCatalogCacheKey({
        environmentId: null,
        hostId: null,
        providerId: "claude-code",
      }),
      {
        models: [model("claude-stale", "Claude Stale", ["high"], true)],
        selectedOnlyModels: [],
      },
    );
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      providers,
    );
    let resolveCatalog: (
      value: SystemExecutionOptionsResponse,
    ) => void = () => {};
    vi.mocked(sdk.system.executionOptions).mockImplementation(
      () =>
        new Promise<SystemExecutionOptionsResponse>((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "fast",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    fireEvent.click(screen.getByTitle("Claude Code"));
    await waitFor(() =>
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "claude-code" }),
      ),
    );
    const staleModel = screen.getByRole("button", { name: "Stale" });
    expect(staleModel.hasAttribute("disabled")).toBe(true);
    fireEvent.click(staleModel);
    expect(onChange).not.toHaveBeenCalled();

    resolveCatalog(
      executionOptions([], {
        modelLoadError: {
          providerId: "claude-code",
          code: "failed",
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/could not load models for claude code/i),
      ).toBeTruthy(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rehydrates every controlled field without emitting a change", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true)]),
    );
    cacheCatalog(
      queryClient,
      "cursor",
      executionOptions([model("cursor-agent", "Cursor Agent", ["high"], true)]),
    );
    const onChange = vi.fn();

    function RehydratingPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "medium",
        serviceTier: "default",
      });
      return (
        <>
          <PluginProviderModelPicker
            value={value}
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
          />
          <button
            type="button"
            onClick={() =>
              setValue({
                providerId: "codex",
                model: "gpt-5.5",
                reasoningLevel: "medium",
                serviceTier: "default",
              })
            }
          >
            Rehydrate
          </button>
        </>
      );
    }

    render(<RehydratingPicker />, { wrapper });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    const rehydrate = screen.getByRole("button", { name: "Rehydrate" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTitle("Cursor"));
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "cursor",
        model: "cursor-agent",
        reasoningLevel: "high",
        serviceTier: "default",
      });
      expect(trigger.textContent).toContain("Agent");
      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
        "Cursor: Agent · High reasoning",
      );
    });
    onChange.mockClear();

    fireEvent.click(rehydrate);
    await waitFor(() => {
      expect(trigger.textContent).toContain("GPT-5.5");
      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
        "Codex: GPT-5.5 · Medium reasoning",
      );
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "GPT-5.5" })).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps model controls editable while provider changes are locked", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
        }}
        onChange={onChange}
        allowProviderChange={false}
      />,
      { wrapper },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    expect(screen.queryByTitle("Cursor")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "GPT Light" }));

    expect(onChange).toHaveBeenCalledWith({
      providerId: "codex",
      model: "gpt-light",
      reasoningLevel: "low",
    });
  });
});
