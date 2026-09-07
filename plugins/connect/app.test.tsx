// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { CONNECT_REALTIME_CHANNEL, type ConnectStatus } from "@/src/types";

const app = await loadPluginApp(() => import("./app"));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

function status(overrides: Partial<ConnectStatus> = {}): ConnectStatus {
  return {
    state: "disconnected",
    paired: false,
    handle: null,
    url: null,
    dashboardUrl: "https://getbb.app/dashboard",
    lastError: null,
    nextRetryAt: null,
    since: 1_700_000_000_000,
    remoteClients: 0,
    lastRemoteActivityAt: null,
    shares: [],
    ...overrides,
  };
}

const connected = (overrides: Partial<ConnectStatus> = {}) =>
  status({
    state: "connected",
    paired: true,
    handle: "workstation",
    url: "https://workstation.getbb.app",
    since: 1_700_000_060_000,
    ...overrides,
  });

describe("connect settings section", () => {
  it("uses the plugin page header instead of declaring a second title", () => {
    expect(app.settingsSections[0]?.title).toBeUndefined();
  });

  it("uses the local Cloud dashboard supplied by the server as a native new-tab link", async () => {
    const dashboardUrl = "http://bb.localhost:42745/dashboard";
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        openUrl: () => true,
        rpc: { status: () => status({ dashboardUrl }) },
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Get a connect code",
    })) as HTMLAnchorElement;
    expect(link.href).toBe(dashboardUrl);
    expect(link.target).toBe("_blank");
    fireEvent.click(link);
    expect(slot.navigateCalls).toEqual([]);
    slot.getByText("you.bb.localhost:42745");
    slot.getByText(/your bb\.localhost:42745 dashboard/);
  });

  it("auto-submits a normalized 4-4 code and applies live paired status", async () => {
    let currentStatus = status();
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => currentStatus,
          pair: () => null,
        },
      },
    );

    await slot.findByText("Get a connect code");
    fireEvent.change(slot.getByLabelText("Connect code"), {
      target: { value: "  k7qp-2m4x  " },
    });

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "pair",
        input: { code: "K7QP-2M4X" },
      }),
    );
    expect(slot.queryByText("https://workstation.getbb.app")).toBeNull();

    currentStatus = connected();
    await slot.emitRealtime(CONNECT_REALTIME_CHANNEL, currentStatus);

    await slot.findByText("Connected");
    slot.getByText("https://workstation.getbb.app");
    slot.getByRole("button", { name: "Copy URL" });
  });

  it("does not auto-submit an incomplete code", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      { rpc: { status: () => status(), pair: () => null } },
    );
    await slot.findByText("Get a connect code");
    fireEvent.change(slot.getByLabelText("Connect code"), {
      target: { value: "K7QP-2M4" },
    });
    expect(
      (slot.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(slot.rpcCalls.some((call) => call.method === "pair")).toBe(false);
  });

  it("maps a typed pair error code to human copy, never wire text", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => status(),
          pair: () => {
            throw new Error("expired_code");
          },
        },
      },
    );

    await slot.findByText("Get a connect code");
    fireEvent.change(slot.getByLabelText("Connect code"), {
      target: { value: "K7QP-2M4X" },
    });

    await slot.findByText(/That code has expired\./);
    slot.getByRole("link", { name: "Get a new code" });
    expect(slot.queryByText(/expired_code/)).toBeNull();
  });

  it("shows a remote-viewer count on the connected status line", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      { rpc: { status: () => connected({ remoteClients: 2 }) } },
    );
    await slot.findByText("Connected");
    await slot.findByText(/2 viewing remotely/);
  });

  it("reconnecting shows the amber state with the human transport error", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              state: "reconnecting",
              lastError: "can't reach getbb.app — connection refused",
              nextRetryAt: null,
            }),
        },
      },
    );
    await slot.findByText("Reconnecting…");
    await slot.findByText(/can't reach getbb.app — connection refused/);
    await slot.findByText(/Local access is unaffected/);
    expect(slot.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("revokes a shared port", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 3000,
                  createdAt: 1,
                  url: "https://workstation--3000.getbb.app",
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 3000 }),
        },
      },
    );

    await slot.findByText(":3000");
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-server", port: 3000 },
      }),
    );
  });

  it("renders an unavailable share reason and keeps it revocable", async () => {
    const reason = "This host is not connected right now.";
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-air",
                  hostName: "Sawyer Air",
                  port: 3000,
                  createdAt: 1,
                  url: "",
                  unavailableReason: reason,
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 3000 }),
        },
      },
    );

    await slot.findByText(`Unavailable — ${reason}`);
    expect(
      slot.queryByRole("button", { name: "Copy share URL for port 3000" }),
    ).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-air", port: 3000 },
      }),
    );
  });

  it("groups shares by host and degrades an unreachable host's group", async () => {
    const reason = "sawyer-air is not connected right now.";
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () =>
            connected({
              shares: [
                {
                  hostId: "host-air",
                  hostName: "Sawyer Air",
                  port: 5173,
                  createdAt: 1,
                  url: "",
                  unavailableReason: reason,
                },
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 3000,
                  createdAt: 2,
                  url: "https://workstation--3000.getbb.app",
                },
                {
                  hostId: "host-server",
                  hostName: "Workstation",
                  port: 8080,
                  createdAt: 3,
                  url: "https://workstation--8080.getbb.app",
                },
              ],
            }),
          unexpose: () => ({ removed: true, port: 5173 }),
        },
      },
    );

    await slot.findByText("Sawyer Air");
    expect(slot.getAllByText("Workstation")).toHaveLength(1);

    expect(
      slot
        .getByText("workstation--3000.getbb.app")
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("https://workstation--3000.getbb.app");
    slot.getByText(`Unavailable — ${reason}`);
    expect(
      slot.queryByRole("button", { name: "Copy share URL for port 5173" }),
    ).toBeNull();

    const revokeButtons = slot.getAllByRole("button", { name: "Revoke" });
    expect(revokeButtons).toHaveLength(3);
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "unexpose",
        input: { hostId: "host-air", port: 5173 },
      }),
    );
  });

  it("exposes a port through the disclosure form and surfaces errors", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected({ shares: [] }),
          expose: () => {
            throw new Error("this bb is not connected to getbb.app");
          },
        },
      },
    );

    await slot.findByText("Shared ports");
    expect(slot.queryByLabelText("Port to share")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expose a port" }));

    fireEvent.change(slot.getByLabelText("Port to share"), {
      target: { value: "8080" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Expose" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "expose",
        input: { port: 8080 },
      }),
    );
    await slot.findByText(/this bb is not connected to getbb.app/);
  });

  it("hides mobile pairing unless the mobileApp experiment is on", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected(),
          mobilePairing: () => ({ enabled: false }),
        },
      },
    );

    await slot.findByText("Connected");
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "mobilePairing",
        input: null,
      }),
    );
    expect(slot.queryByText("Mobile app")).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Add mobile device" }),
    ).toBeNull();
    slot.getByRole("button", { name: "Re-pair" });
  });

  it("add mobile device mints a machine code and shows the QR payload, the code, and a countdown", async () => {
    const expiresAt = Date.now() + 600_000;
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected(),
          mobilePairing: () => ({ enabled: true }),
          createMachineCode: () => ({
            code: "K7QP-2M4X",
            expiresAt,
            serverUrl: "https://workstation.getbb.app",
          }),
        },
      },
    );

    await slot.findByText("Connected");
    expect(slot.queryByText("K7QP-2M4X")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Add mobile device" }),
    );

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "createMachineCode",
        input: null,
      }),
    );
    await slot.findByText("K7QP-2M4X");
    slot.getByRole("button", { name: "Copy pairing code" });
    slot.getByText(/Code expires in 9:5\d/);
    const qr = (await slot.findByRole("img", {
      name: "QR code to pair the bb mobile app",
    })) as HTMLImageElement;
    expect(qr.src.startsWith("data:image/png")).toBe(true);
    slot.getByText(/bb connect machine-code/);
  });

  it("an expired mobile pairing code offers a fresh one", async () => {
    let minted = 0;
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected(),
          mobilePairing: () => ({ enabled: true }),
          createMachineCode: () => {
            minted += 1;
            return {
              code: minted === 1 ? "AAAA-1111" : "BBBB-2222",
              expiresAt: Date.now() + (minted === 1 ? 1_200 : 600_000),
              serverUrl: "https://workstation.getbb.app",
            };
          },
        },
      },
    );

    await slot.findByText("Connected");
    fireEvent.click(
      await slot.findByRole("button", { name: "Add mobile device" }),
    );
    await slot.findByText("AAAA-1111");

    await slot.findByText("Code expired", undefined, { timeout: 4_000 });
    expect(
      slot.queryByRole("button", { name: "Copy pairing code" }),
    ).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Generate a new code" }));

    await slot.findByText("BBBB-2222");
    expect(slot.queryByText("AAAA-1111")).toBeNull();
    slot.getByText(/Code expires in/);
  });

  it("explains the account machine limit with a dashboard link", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => connected(),
          mobilePairing: () => ({ enabled: true }),
          createMachineCode: () => {
            throw new Error("machine_limit");
          },
        },
      },
    );

    await slot.findByText("Connected");
    fireEvent.click(
      await slot.findByRole("button", { name: "Add mobile device" }),
    );

    await slot.findByText(/reached its machine limit/);
    const link = slot.getByRole("link", {
      name: "Revoke a device you no longer use",
    }) as HTMLAnchorElement;
    expect(link.href).toBe("https://getbb.app/dashboard");
    expect(slot.queryByText("machine_limit")).toBeNull();
    slot.getByRole("button", { name: "Add mobile device" });
  });

  it("disconnect confirms, then lands on the unpaired card with a receipt", async () => {
    let currentStatus = connected();
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          status: () => currentStatus,
          disconnect: () => {
            currentStatus = status();
            return currentStatus;
          },
        },
      },
    );

    await slot.findByText("Connected");
    fireEvent.click(slot.getByRole("button", { name: "Disconnect" }));

    await slot.findByText("Disconnect remote access?");
    await slot.findByText(/will stop working on all devices/);
    fireEvent.click(slot.getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "disconnect")).toBe(
        true,
      ),
    );
    await slot.emitRealtime(CONNECT_REALTIME_CHANNEL, currentStatus);

    await slot.findByText("Get a connect code");
    await slot.findByText("Remote access disconnected");
  });
});
