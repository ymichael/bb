// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost as host } from "@bb/test-helpers/domain-fixtures";
import type { InstalledPlugin } from "@bb/server-contract";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BbHttpError, sdk } from "@/lib/sdk";
import { hostsQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AddMachineDialog } from "./AddMachineDialog";
import { makeInstalledPlugin } from "@/test/fixtures/plugins";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...original,
    sdk: {
      hosts: {
        createJoinCode: vi.fn(),
        list: vi.fn(),
      },
      plugins: { callRpc: vi.fn(), list: vi.fn() },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const existingHost = host({ id: "host_primary", name: "MacBook Pro" });

function connectPlugin(
  overrides: Pick<InstalledPlugin, "enabled" | "status">,
): InstalledPlugin {
  return makeInstalledPlugin({
    id: "connect",
    source: "builtin:connect",
    rootDir: "/plugins/connect",
    provenance: "builtin",
    publisherLabel: "BB Official",
    sourceDisplay: "builtin · connect",
    name: "Remote access",
    hasSettings: true,
    ...overrides,
  });
}

function notRunningRpcError(status: string): BbHttpError {
  const message = `plugin "connect" is not running (status: ${status})`;
  return new BbHttpError({
    body: { ok: false, error: message },
    code: null,
    message,
    status: 503,
  });
}
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: writeTextMock },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddMachineDialog", () => {
  it("mints a join code, shows the pairing command, and detects the new machine connecting", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockResolvedValue({
      code: "mc_test456",
      expiresAt: Date.now() + 10 * 60 * 1000,
      serverUrl: "https://example.getbb.app",
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://direct.example.test:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const command = await screen.findByText(/--join-code jc_test123/);
    expect(sdk.plugins.callRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "connect",
        method: "createMachineCode",
        input: null,
      }),
    );
    expect(command.textContent).toContain("--host-id host_new");
    expect(command.textContent).toContain(
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 https://example.getbb.app/install.sh",
    );
    expect(command.textContent).toContain("--server https://example.getbb.app");
    expect(command.textContent).toContain("--machine-code mc_test456");
    expect(command.textContent).not.toContain(window.location.origin);
    expect(command.closest("[data-add-machine-command]")).not.toBeNull();
    expect(
      screen.getByText(
        /It installs bb and keeps the machine connected to this server/u,
      ),
    ).toBeDefined();
    expect(screen.getByText(/Code expires in \d+:\d{2}/)).toBeDefined();
    const waiting = screen.getByText("Waiting for the machine to connect…");
    expect(waiting).toBeDefined();
    expect(waiting.parentElement?.className).not.toContain("border-border");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(command.textContent);
      expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(1);
    });

    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        host({ id: "host_new", name: "Mac Studio" }),
      ]);
    });

    expect(await screen.findByText("Mac Studio connected")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Set up a project on it →" }),
    ).toBeDefined();
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("falls back to direct pairing when connect is unpaired and ignores known hosts", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      new BbHttpError({
        body: {
          ok: false,
          error: { code: "handler_error", message: "not_paired" },
        },
        code: "handler_error",
        message: "not_paired",
        status: 500,
      }),
    );
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      existingHost,
      host({ id: "host_offline", name: "dev-vm", status: "disconnected" }),
    ]);

    const { queryClient, wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://direct.example.test:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const command = await screen.findByText(/--join-code jc_test123/);
    expect(command.textContent).toContain(
      "curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 http://direct.example.test:38886/install.sh",
    );
    expect(command.textContent).toContain(
      "--server http://direct.example.test:38886",
    );
    expect(command.textContent).not.toContain("--machine-code");

    await waitFor(() => {
      expect(queryClient.getQueryData<Host[]>(hostsQueryKey())).toHaveLength(2);
    });

    act(() => {
      queryClient.setQueryData<Host[]>(hostsQueryKey(), [
        existingHost,
        host({ id: "host_offline", name: "dev-vm" }),
      ]);
    });

    expect(
      await screen.findByText("Waiting for the machine to connect…"),
    ).toBeDefined();
    expect(screen.queryByText("dev-vm connected")).toBeNull();
  });

  it("explains that a loopback server is unreachable when connect is unpaired", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      new BbHttpError({
        body: {
          ok: false,
          error: { code: "handler_error", message: "not_paired" },
        },
        code: "handler_error",
        message: "not_paired",
        status: 500,
      }),
    );
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://127.0.0.1:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "Another machine cannot use this address.",
    );
    expect(notice.textContent).toContain("http://127.0.0.1:38886");
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
    const link = screen.getByRole("link", { name: "Set up remote access" });
    expect(link.getAttribute("href")).toBe("/settings/plugins/connect");
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
  });

  it("offers a retry when connect is temporarily unavailable on a loopback server", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      notRunningRpcError("degraded"),
    );
    vi.mocked(sdk.plugins.list).mockResolvedValue({
      plugins: [connectPlugin({ enabled: true, status: "degraded" })],
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://0.0.0.0:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    expect(
      await screen.findByText("Remote access isn't ready yet."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("links to the Connect plugin when it is disabled on a loopback server", async () => {
    vi.mocked(sdk.hosts.createJoinCode).mockResolvedValue({
      joinCode: "jc_test123",
      hostId: "host_new",
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    vi.mocked(sdk.plugins.callRpc).mockRejectedValue(
      notRunningRpcError("disabled"),
    );
    vi.mocked(sdk.plugins.list).mockResolvedValue({
      plugins: [connectPlugin({ enabled: false, status: "disabled" })],
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([existingHost]);

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <AddMachineDialog
          open
          onOpenChange={vi.fn()}
          serverUrl="http://127.0.0.1:38886"
        />
      </MemoryRouter>,
      { wrapper },
    );

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("The Connect plugin is disabled");
    const link = screen.getByRole("link", {
      name: "Enable the Connect plugin",
    });
    expect(link.getAttribute("href")).toBe(
      "/settings/plugins/connect?view=installed",
    );
    expect(screen.queryByText("Remote access isn't ready yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.queryByText("Waiting for the machine to connect…"),
    ).toBeNull();
    expect(screen.queryByText(/--join-code jc_test123/)).toBeNull();
  });
});
