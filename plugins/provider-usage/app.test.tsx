// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function threadOnMachine(
  hostId: string,
  hostName: string,
): PluginSidebarThread {
  return {
    id: "thread-active",
    projectId: "project-one",
    title: "Active thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: { id: hostId, name: hostName },
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
  };
}

describe("provider usage footer disclosure", () => {
  it("aggregates every machine and keeps machine and provider selection local to the card", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              machines: [
                {
                  id: "host-m4",
                  displayName: "M4",
                  status: "connected",
                  error: null,
                  providers: [
                    {
                      id: "claude-code",
                      displayName: "Claude Code",
                      logoUrl:
                        "/api/v1/system/providers/claude-code/logo?h=claude",
                      iconGlyph: null,
                      iconTint: { light: "#D97757", dark: "#E38A6E" },
                      signInHint: "Sign in to Claude Code.",
                      expiredHint: "Sign in to Claude Code again.",
                      usage: {
                        status: "ok",
                        accountEmail: "claude@example.com",
                        planLabel: "Max",
                        windows: [
                          {
                            label: "Five-hour limit",
                            usedPercent: 82,
                            resetsAt: "2026-09-02T18:42:00.000Z",
                            cost: null,
                          },
                        ],
                      },
                    },
                    {
                      id: "codex",
                      displayName: "Codex",
                      logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
                      iconGlyph: null,
                      iconTint: null,
                      signInHint: "Sign in to Codex.",
                      expiredHint: "Sign in to Codex again.",
                      usage: {
                        status: "ok",
                        accountEmail: "codex@example.com",
                        planLabel: "Plus",
                        windows: [
                          {
                            label: "Weekly limit",
                            usedPercent: 37,
                            resetsAt: null,
                            cost: null,
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  id: "host-m5",
                  displayName: "M5",
                  status: "connected",
                  error: null,
                  providers: [
                    {
                      id: "codex",
                      displayName: "Codex",
                      logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
                      iconGlyph: null,
                      iconTint: null,
                      signInHint: "Sign in to Codex.",
                      expiredHint: "Sign in to Codex again.",
                      usage: {
                        status: "ok",
                        accountEmail: "codex@example.com",
                        planLabel: "Plus",
                        windows: [
                          {
                            label: "Weekly limit",
                            usedPercent: 97,
                            resetsAt: null,
                            cost: null,
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  id: "host-intel",
                  displayName: "Intel",
                  status: "disconnected",
                  error: null,
                  providers: [],
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = await loadPluginApp(() => import("./app"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "provider-usage",
    });
    const item = app.experimentalSidebarFooterItems[0];
    expect(item).toMatchObject({
      kind: "disclosure",
      id: "usage",
      label: "Provider usage",
      icon: "ChartColumn",
    });
    if (item?.kind !== "disclosure") throw new Error("missing disclosure");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/plugins/provider-usage/rpc/getUsage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            force: false,
            machineIds: null,
            maxAgeMs: 30 * 60_000,
          }),
        }),
      ),
    );
    const dismiss = vi.fn();
    const slot = renderSlot(
      item,
      { dismiss },
      {
        context: { threadId: "thread-active" },
        sidebarThreads: {
          threads: [threadOnMachine("host-m5", "M5")],
        },
      },
    );
    const machinePicker = slot.getByRole("button", {
      name: "Usage machine: M5",
    });
    expect(slot.getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(slot.getByText("codex@example.com")).toBeTruthy();
    expect(slot.getByText("97% used")).toBeTruthy();

    fireEvent.pointerDown(machinePicker, { button: 0 });
    fireEvent.click(slot.getByRole("menuitemradio", { name: "M4" }));
    const claudeTab = slot.getByRole("tab", { name: "Claude Code" });
    const codexTab = slot.getByRole("tab", { name: "Codex" });
    expect(
      slot
        .getByRole("button", { name: "Usage machine: M4" })
        .closest('[data-provider-usage-header=""]'),
    ).toBe(claudeTab.closest('[data-provider-usage-header=""]'));
    expect(
      claudeTab.querySelector("[data-provider-logo*='claude-code']"),
    ).not.toBeNull();
    expect(
      codexTab.querySelector("[data-provider-logo*='/codex/']"),
    ).not.toBeNull();
    expect(slot.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(slot.getByText("claude@example.com")).toBeTruthy();
    expect(slot.getByText("82% used")).toBeTruthy();

    fireEvent.click(codexTab);
    expect(slot.getByRole("heading", { name: "Codex" })).toBeTruthy();
    expect(slot.getByText("codex@example.com")).toBeTruthy();
    expect(slot.getByText("37% used")).toBeTruthy();
    fireEvent.keyDown(codexTab, { key: "ArrowLeft" });
    expect(claudeTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Usage machine: M4" }),
      { button: 0 },
    );
    fireEvent.click(slot.getByRole("menuitemradio", { name: "Intel" }));
    expect(
      slot.getByText(
        "Intel is offline. Usage will refresh when it reconnects.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Collapse provider usage" }),
    );
    expect(dismiss).toHaveBeenCalledOnce();
    const reloadButton = slot.getByRole("button", {
      name: "Reload provider usage",
    }) as HTMLButtonElement;
    await waitFor(() => expect(reloadButton.disabled).toBe(false));
    const callsBeforeManualRefresh = fetchMock.mock.calls.length;
    fireEvent.click(reloadButton);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeManualRefresh + 1),
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: true,
          machineIds: ["host-intel"],
          maxAgeMs: 0,
        }),
      }),
    );

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    window.dispatchEvent(new Event("blur"));
    now.mockReturnValue(5 * 60_000 + 1_001);
    const callsBeforeFocus = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeFocus + 1),
    );
    expect(fetchMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          force: false,
          machineIds: null,
          maxAgeMs: 5 * 60_000,
        }),
      }),
    );

    await mounted.lifecycle.dispose();
  });
});
