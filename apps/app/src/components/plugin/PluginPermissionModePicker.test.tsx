// @vitest-environment jsdom

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PermissionMode, ProviderInfo } from "@bb/domain";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import type { SystemExecutionOptionsResponse } from "@bb/server-contract";
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
import { PluginPermissionModePicker } from "./PluginPermissionModePicker";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      hosts: { list: vi.fn().mockResolvedValue([]) },
      system: {
        ...actual.sdk.system,
        config: vi.fn().mockResolvedValue({ primaryHostId: null }),
        executionOptions: vi.fn(),
      },
    },
  };
});

function provider(
  id: string,
  permissionModes: ProviderInfo["capabilities"]["permissionModes"],
): ProviderInfo {
  return makeProviderInfo({
    id,
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
    strings: {
      signInHint: "Sign in",
      expiredHint: "Sign in again",
      installUrl: "https://example.com/install",
    },
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: false,
      supportsNativeUserQuestion: true,
      supportsFork: true,
      supportsSessionRewind: true,
      permissionModes,
      modelCatalogScope: "host",
    },
  });
}

const providers = [
  provider("codex", ["accept-edits", "auto", "full"]),
  provider("claude", ["auto", "full"]),
  provider("fixed", ["full"]),
];

function executionOptions(
  permissionCeiling: SystemExecutionOptionsResponse["permissionCeiling"],
): SystemExecutionOptionsResponse {
  return {
    providers,
    models: [],
    selectedOnlyModels: [],
    permissionCeiling,
    modelLoadError: null,
  };
}

function cacheOptions(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  providerId: string,
  permissionCeiling: SystemExecutionOptionsResponse["permissionCeiling"],
  environmentId: string | null = null,
) {
  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({
      environmentId,
      hostId: null,
      providerId,
    }),
    executionOptions(permissionCeiling),
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("PluginPermissionModePicker", () => {
  it("normalizes against provider capabilities and the routed machine ceiling", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheOptions(queryClient, "codex", "auto");
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<"accept-edits" | "auto" | "full">(
        "full",
      );
      return (
        <PluginPermissionModePicker
          providerId="codex"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("auto"));

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Permission mode" }),
      { button: 0 },
    );
    const full = screen.getByRole("menuitem", { name: /Full Access/ });
    expect(full.getAttribute("data-disabled")).not.toBeNull();
    expect(full.textContent).toContain("selected machine's permission limit");
  });

  it("reacts to provider and environment capability changes without plugin logic", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheOptions(queryClient, "codex", "full", "env-wide");
    cacheOptions(queryClient, "codex", "accept-edits", "env-capped");
    cacheOptions(queryClient, "claude", "full", "env-wide");
    const onChange = vi.fn();

    function RehydratingPicker() {
      const [state, setState] = useState<{
        providerId: string;
        value: PermissionMode;
        environmentId: string;
      }>({
        providerId: "codex",
        value: "full",
        environmentId: "env-wide",
      });
      return (
        <>
          <PluginPermissionModePicker
            providerId={state.providerId}
            value={state.value}
            routing={{
              kind: "environment",
              environmentId: state.environmentId,
            }}
            onChange={(value) => {
              onChange(value);
              setState((current) => ({ ...current, value }));
            }}
          />
          <button
            type="button"
            onClick={() =>
              setState({
                providerId: "claude",
                value: "accept-edits",
                environmentId: "env-wide",
              })
            }
          >
            Change provider
          </button>
          <button
            type="button"
            onClick={() =>
              setState({
                providerId: "codex",
                value: "full",
                environmentId: "env-capped",
              })
            }
          >
            Change environment
          </button>
        </>
      );
    }

    render(<RehydratingPicker />, { wrapper });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Change provider" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("auto"));

    fireEvent.click(screen.getByRole("button", { name: "Change environment" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith("accept-edits"),
    );
  });

  it("shows a locked single supported mode", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheOptions(queryClient, "fixed", "full");

    render(
      <PluginPermissionModePicker
        providerId="fixed"
        value="full"
        onChange={vi.fn()}
      />,
      { wrapper },
    );

    const trigger = screen.getByRole("button", { name: "Permission mode" });
    expect(trigger.textContent).toContain("Full Access");
    expect(trigger.hasAttribute("disabled")).toBe(true);
  });

  it("does not normalize from provisional or failed routing data", async () => {
    const { wrapper } = createQueryClientTestHarness();
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      providers,
    );
    writeCachedModelCatalog(
      modelCatalogCacheKey({
        environmentId: null,
        hostId: null,
        providerId: "claude",
      }),
      { models: [], selectedOnlyModels: [] },
    );
    vi.mocked(sdk.system.executionOptions).mockRejectedValue(
      new Error("offline"),
    );
    const onChange = vi.fn();

    render(
      <PluginPermissionModePicker
        providerId="claude"
        value="accept-edits"
        onChange={onChange}
      />,
      { wrapper },
    );

    const trigger = await screen.findByRole("button", {
      name: "Permission mode",
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    await waitFor(() =>
      expect(sdk.system.executionOptions).toHaveBeenCalledTimes(2),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
