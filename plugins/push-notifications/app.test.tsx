// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

const app = await loadPluginApp(() => import("./app.js"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("device notification settings", () => {
  it("requests permission only on a click and uses the server test route", async () => {
    const requestPermission = vi.fn(async () => "granted");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    vi.stubGlobal("isSecureContext", true);
    const view = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        settings: { webEnabled: true },
        rpc: { "notifications.test": () => ({ ok: true }) },
      },
    );
    expect(requestPermission).not.toHaveBeenCalled();
    fireEvent.click(
      await view.findByRole("button", { name: "Allow notifications" }),
    );
    fireEvent.click(
      await view.findByRole("button", { name: "Send test notification" }),
    );
    await waitFor(() =>
      expect(view.inspection.rpcCalls).toEqual([
        { method: "notifications.test", input: { channel: "web" } },
      ]),
    );
  });

  it("explains denied permission without prompting repeatedly", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    vi.stubGlobal("isSecureContext", true);
    const view = renderSlot(
      app.settingsSections[0]!,
      {},
      { settings: { webEnabled: true } },
    );
    expect(await view.findByText(/Notifications are blocked/)).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
