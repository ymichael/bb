// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  EMPTY_PLUGIN_UPDATE_STATE,
  type PluginListItem,
  type PluginUpdateState,
} from "@/hooks/queries/plugin-settings-queries";
import {
  getNotifications,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { UpdatePluginDialog } from "./UpdatePluginDialog";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(updateState: Partial<PluginUpdateState>): PluginListItem {
  return makePluginListItem({
    id: "linear",
    source: "npm:@example/linear@^1.6.0",
    rootDir: "/plugins/linear",
    version: "1.6.2",
    name: "Linear",
    provenance: "catalog",
    catalogEntryId: "linear",
    publisherLabel: "BB Community",
    sourceDisplay: "npm · @bb-plugins/linear · tracks compatible",
    updateState: { ...EMPTY_PLUGIN_UPDATE_STATE, ...updateState },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  resetNotificationStore();
  vi.unstubAllGlobals();
});

describe("UpdatePluginDialog", () => {
  it("always shows the rollback promise for a compatible update and keeps details collapsed", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({ availableVersion: "1.7.0" })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByText("Update Linear to 1.7.0?")).toBeTruthy();
    expect(screen.getByTestId("rollback-note").textContent).toContain(
      "if 1.7.0 fails to start, bb restores 1.6.2",
    );
    expect(
      screen
        .getByRole("button", { name: /details — source/i })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("renders the incompatible variant pre-expanded with Update disabled", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({
          blockedVersion: "1.9.0",
          blockedReasons: ["needs bb >= 0.15 — you have 0.14.1"],
        })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    expect(
      screen.getByText("1.9.0 isn’t compatible with this bb"),
    ).toBeTruthy();
    expect(screen.getByText("needs bb >= 0.15 — you have 0.14.1")).toBeTruthy();
    expect(
      screen.getByText(
        "Keep using 1.6.2 and check again when a compatible plugin version is available.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/once this bb meets/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Update" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("opens persisted failure details and retries an available update", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        applied: true,
        from: { version: "1.6.2", display: "1.6.2" },
        to: { version: "1.8.0", display: "1.8.0" },
        outcome: "updated",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChange = vi.fn();
    const { wrapper } = createQueryClientTestHarness();
    const failedAt = new Date(2026, 6, 22).getTime();
    render(
      <UpdatePluginDialog
        plugin={plugin({
          availableVersion: "1.8.0",
          lastFailure: {
            version: "1.7.0",
            at: failedAt,
            detail: "factory threw during activation",
          },
        })}
        open
        onOpenChange={onOpenChange}
      />,
      { wrapper },
    );

    expect(screen.getByRole("heading", { name: "Update failed" })).toBeTruthy();
    expect(screen.getByText("Failed on Jul 22, 2026.")).toBeTruthy();
    expect(
      screen.getByText(
        "bb couldn’t activate 1.7.0. It restored 1.6.2 and its data.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("factory threw during activation")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry update to 1.8.0" }),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps a persisted failure actionable without offering an unavailable retry", () => {
    vi.stubGlobal("fetch", vi.fn());
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({
          lastFailure: {
            version: "1.7.0",
            at: null,
            detail: "factory threw during activation",
          },
        })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByText(/Try again when a compatible update/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry update/ })).toBeNull();
  });

  it("renders a rolled-back outcome pointing at the canonical failure state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          applied: false,
          from: { version: "1.6.2", display: "1.6.2" },
          to: { version: "1.7.0", display: "1.7.0" },
          outcome: "rolled-back",
          detail: "factory threw during activation",
        }),
      ),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({ availableVersion: "1.7.0" })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByText("Update failed")).toBeTruthy();
    expect(screen.getByText("factory threw during activation")).toBeTruthy();
    expect(
      screen.getByText(
        "The plugin is marked “Update failed” in the installed list until an update succeeds.",
      ),
    ).toBeTruthy();
  });

  it("records one alert when an update request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "plugin source is unavailable" }, 502),
      ),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({ availableVersion: "1.7.0" })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await vi.waitFor(() => {
      expect(getNotifications()).toHaveLength(1);
    });
    const notification = getNotifications()[0];
    expect(notification?.title).toBe("Plugin update failed");

    render(<MemoryRouter>{notification?.description}</MemoryRouter>);
    expect(
      screen.getByRole("link", { name: "Linear" }).getAttribute("href"),
    ).toBe("/settings/plugins/linear?view=installed");
    expect(
      screen.getByRole("link", { name: "Linear" }).parentElement?.textContent,
    ).toBe("Linear — plugin source is unavailable");
  });

  it("treats a malformed 2xx update response as an error, never success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: "ok" })),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <UpdatePluginDialog
        plugin={plugin({ availableVersion: "1.7.0" })}
        open
        onOpenChange={() => {}}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await vi.waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Update" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(screen.getByText("Update Linear to 1.7.0?")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Update failed" })).toBeNull();
  });
});
