// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  EMPTY_PLUGIN_UPDATE_STATE,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import {
  PluginDetailReleaseControl,
  PluginDetailReleaseStatus,
  pluginHasUpdateSurfaces,
} from "./PluginUpdatesCard";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return makePluginListItem({
    id: "linear",
    source: "npm:@example/linear@^1.6.0",
    rootDir: "/plugins/linear",
    version: "1.6.2",
    name: "Linear",
    sourceDisplay: "npm · @bb-plugins/linear · pinned",
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pluginHasUpdateSurfaces", () => {
  it("hides update surfaces for bundled plugins regardless of provenance", () => {
    expect(
      pluginHasUpdateSurfaces(
        plugin({ provenance: "catalog", source: "builtin:github" }),
      ),
    ).toBe(false);
    expect(
      pluginHasUpdateSurfaces(
        plugin({ provenance: "builtin", source: "builtin:secrets" }),
      ),
    ).toBe(false);
    expect(pluginHasUpdateSurfaces(plugin({ provenance: "direct" }))).toBe(
      true,
    );
    expect(pluginHasUpdateSurfaces(plugin({ provenance: "catalog" }))).toBe(
      true,
    );
  });
});

describe("PluginDetailReleaseControl", () => {
  it("offers a compatible update as a compact release action", () => {
    const { wrapper } = createQueryClientTestHarness();
    render(
      <PluginDetailReleaseControl
        plugin={plugin({
          updateState: {
            ...EMPTY_PLUGIN_UPDATE_STATE,
            availableVersion: "1.9.0",
          },
        })}
      />,
      { wrapper },
    );

    const update = screen.getByRole("button", {
      name: "Update Linear to 1.9.0",
    });
    expect(update).toBeTruthy();
    expect(update.querySelector('[data-icon="Download"]')).not.toBeNull();
    expect(screen.queryByText("Compatible with your bb.")).toBeNull();
  });

  it("shows a blocked update inline without a modal or disabled action", () => {
    const { wrapper } = createQueryClientTestHarness();
    render(
      <PluginDetailReleaseStatus
        plugin={plugin({
          updateState: {
            ...EMPTY_PLUGIN_UPDATE_STATE,
            blockedVersion: "1.9.0",
            blockedReasons: ["requires bb >= 0.15"],
          },
        })}
      />,
      { wrapper },
    );

    const blockedStatus = screen.getByRole("status", {
      name: "Update blocked",
    });
    expect(screen.queryByText("Update blocked")).toBeNull();
    expect(blockedStatus.textContent).toContain("Requires bb >= 0.15.");
    expect(blockedStatus.textContent).toContain("1.6.2 remains installed");
    expect(blockedStatus.textContent).toContain(
      "check again when a compatible plugin version is available",
    );
    expect(blockedStatus.textContent).not.toContain("Update bb");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not prescribe a bb upgrade for a candidate requiring an older bb", () => {
    const { wrapper } = createQueryClientTestHarness();
    render(
      <PluginDetailReleaseStatus
        plugin={plugin({
          updateState: {
            ...EMPTY_PLUGIN_UPDATE_STATE,
            blockedVersion: "1.9.0",
            blockedReasons: ["requires bb < 0.20, running bb is 0.21.0"],
          },
        })}
      />,
      { wrapper },
    );

    const blockedStatus = screen.getByRole("status", {
      name: "Update blocked",
    });
    expect(blockedStatus.textContent).toContain("Requires bb < 0.20");
    expect(blockedStatus.textContent).not.toContain("Update bb");
  });

  it("retries a failed update from the release action without opening a modal", async () => {
    let completeUpdate: (() => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          completeUpdate = () =>
            resolve(
              new Response(
                JSON.stringify({
                  applied: true,
                  from: { version: "1.6.2", display: "1.6.2" },
                  to: { version: "1.9.0", display: "1.9.0" },
                  outcome: "updated",
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryClientTestHarness();
    render(
      <>
        <PluginDetailReleaseControl
          plugin={plugin({
            updateState: {
              ...EMPTY_PLUGIN_UPDATE_STATE,
              availableVersion: "1.9.0",
              lastFailure: {
                version: "1.9.0",
                at: null,
                detail: "The plugin failed to load.",
              },
            },
          })}
        />
        <PluginDetailReleaseStatus
          plugin={plugin({
            updateState: {
              ...EMPTY_PLUGIN_UPDATE_STATE,
              availableVersion: "1.9.0",
              lastFailure: {
                version: "1.9.0",
                at: null,
                detail: "The plugin failed to load.",
              },
            },
          })}
        />
      </>,
      { wrapper },
    );

    const failedStatus = screen.getByRole("status", { name: "Update failed" });
    expect(screen.queryByText("Update failed")).toBeNull();
    expect(failedStatus.textContent).toContain(
      "bb couldn’t activate 1.9.0. It restored 1.6.2 and its data.",
    );
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText("The plugin failed to load.")).toBeNull();
    expect(failedStatus.querySelector("button")).toBeNull();
    const retry = screen.getByRole("button", {
      name: "Retry update to 1.9.0",
    });
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(retry).toHaveProperty("disabled", true);
    completeUpdate?.();
    await waitFor(() => expect(retry.getAttribute("aria-busy")).toBe("false"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing for builtins (their update channel is the bb release)", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { container } = render(
      <PluginDetailReleaseControl
        plugin={{
          ...plugin({ provenance: "builtin" }),
          source: "builtin:linear",
        }}
      />,
      { wrapper },
    );
    expect(container.textContent).toBe("");
  });
});
