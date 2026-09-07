// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { RETRY_ACTION_ICON } from "@bb/domain/update-state";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import type { SystemConfigResponse } from "@bb/server-contract";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { MachinesSettingsSection } from "./MachinesSettingsSection";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: vi.fn(),
      list: vi.fn(),
      retryUpdate: vi.fn(),
      update: vi.fn(),
    },
    system: { config: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const hostDaemon = vi.hoisted(() => ({
  localDaemonHostId: "host_primary" as string | null,
  platform: "darwin" as "darwin" | "linux" | "wsl" | "unknown" | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: hostDaemon.localDaemonHostId,
    platform: hostDaemon.platform,
  }),
}));

const NOW = Date.now();

function host(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHost({
    lastSeenAt: NOW,
    ...overrides,
  });
}

const primaryHost = host({ id: "host_primary", name: "MacBook Pro" });
const offlineHost = host({
  id: "host_remote",
  name: "dev-vm",
  status: "disconnected",
  lastSeenAt: NOW - 2 * 60 * 60 * 1000,
});

function systemConfig(): SystemConfigResponse {
  return makeSystemConfig({
    primaryHostId: "host_primary",
    primaryHostPlatform: "darwin",
  });
}

function stubSidebarBootstrapFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projects: [
            {
              id: "proj_1",
              sources: [
                { id: "src_1", hostId: "host_primary" },
                { id: "src_2", hostId: "host_remote" },
              ],
              threads: [],
            },
            {
              id: "proj_2",
              sources: [{ id: "src_3", hostId: "host_primary" }],
              threads: [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
}

function renderSection() {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <MachinesSettingsSection />
    </MemoryRouter>,
    { wrapper },
  );
}

async function openHostMenu(hostName: string): Promise<void> {
  fireEvent.pointerDown(
    await screen.findByRole("button", { name: `${hostName} actions` }),
    { button: 0 },
  );
}

beforeEach(() => {
  hostDaemon.localDaemonHostId = "host_primary";
  hostDaemon.platform = "darwin";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MachinesSettingsSection", () => {
  it("renders machine status, project, and permission metadata as visible text", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    expect(await screen.findByText("MacBook Pro")).toBeDefined();
    expect(screen.getByText("dev-vm")).toBeDefined();
    expect(screen.getByText("this machine")).toBeDefined();
    expect(screen.getByText("primary")).toBeDefined();
    expect(screen.getByText("Online")).toBeDefined();
    expect(screen.getByText(/^Offline · last seen/u)).toBeDefined();
    expect(await screen.findByText("2 projects")).toBeDefined();
    expect(screen.getByText("1 project")).toBeDefined();
    expect(screen.getAllByText("Full Access")).toHaveLength(2);
    expect(screen.getByText("macOS")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Open MacBook Pro" })
        .querySelector("[data-icon]"),
    ).toBeNull();
  });

  it("distinguishes the client-local daemon from the primary machine", async () => {
    hostDaemon.localDaemonHostId = "host_remote";
    hostDaemon.platform = "linux";
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const primaryName = await screen.findByText("MacBook Pro");
    const localName = screen.getByText("dev-vm");
    expect(primaryName.parentElement?.textContent).toContain("primary");
    expect(primaryName.parentElement?.textContent).not.toContain(
      "this machine",
    );
    expect(localName.parentElement?.textContent).toContain("this machine");
    expect(localName.parentElement?.textContent).not.toContain("primary");
    expect(screen.getByText("Linux")).toBeDefined();
  });

  it("does not infer client-local identity when no daemon is reachable", async () => {
    hostDaemon.localDaemonHostId = null;
    hostDaemon.platform = null;
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    expect(screen.queryByText("this machine")).toBeNull();
    expect(screen.getByText("primary")).toBeDefined();
  });

  it("does not promote a fallback host to primary policy", async () => {
    hostDaemon.localDaemonHostId = null;
    vi.mocked(sdk.system.config).mockResolvedValue({
      ...systemConfig(),
      primaryHostId: null,
      primaryHostPlatform: null,
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    expect(screen.queryByText("primary")).toBeNull();
    await openHostMenu("MacBook Pro");
    expect(
      screen
        .getByRole("menuitem", { name: "Remove machine" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("shows protocol versions when a machine needs an update", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      {
        ...offlineHost,
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      },
    ]);
    stubSidebarBootstrapFetch();

    renderSection();

    const updateStatus = await screen.findByText(
      `Needs update · daemon protocol ${HOST_DAEMON_PROTOCOL_VERSION - 1} · server protocol ${HOST_DAEMON_PROTOCOL_VERSION}`,
    );
    expect(updateStatus.className).toContain("min-w-0");
    expect(updateStatus.className).not.toContain("shrink-0");
    await openHostMenu("dev-vm");
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    const retryItem = await screen.findByRole("menuitem", {
      name: "Retry update",
    });
    const removeItem = await screen.findByRole("menuitem", {
      name: "Remove machine",
    });
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("w-max");
    expect(menu.className).toContain("min-w-0");
    for (const item of [renameItem, retryItem, removeItem]) {
      expect(item.className).toContain("min-h-9");
      expect(item.className).toContain("px-2.5");
      expect(item.className).toContain("py-2");
    }
    expect(renameItem.querySelector('[data-icon="Edit"]')).not.toBeNull();
    expect(
      retryItem.querySelector(`[data-icon="${RETRY_ACTION_ICON}"]`),
    ).not.toBeNull();
    expect(removeItem.querySelector('[data-icon="Trash2"]')).not.toBeNull();
  });

  it("opens the row menu from the keyboard and focuses its first action", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const trigger = await screen.findByRole("button", {
      name: "dev-vm actions",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    await waitFor(() => {
      expect(document.activeElement).toBe(renameItem);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(renameItem, { key: "Escape" });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("uses a labeled Add a machine action", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    const addMachine = await screen.findByRole("button", {
      name: "Add a machine",
    });
    expect(addMachine.textContent).toBe("Add a machine");
    expect(addMachine.querySelector('[data-icon="Plus"]')).not.toBeNull();
    const action = addMachine.parentElement;
    expect(action?.className).toContain("self-start");
    expect(action?.parentElement?.className).toContain("flex-col");
    expect(action?.parentElement?.className).toContain("sm:flex-row");
    fireEvent.click(addMachine);
    expect(
      await screen.findByRole("heading", { name: "Add a machine" }),
    ).toBeDefined();
  });

  it("requests an immediate daemon update retry", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      {
        ...offlineHost,
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      },
    ]);
    vi.mocked(sdk.hosts.retryUpdate).mockResolvedValue({ ok: true });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Retry update" }),
    );

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.retryUpdate)).toHaveBeenCalledWith({
        hostId: "host_remote",
      });
    });
  });

  it("shows permission metadata as text and reserves a hover caret", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      primaryHost,
      { ...offlineHost, maxPermissionMode: "accept-edits" },
    ]);
    stubSidebarBootstrapFetch();

    renderSection();

    expect(await screen.findByText("Accept Edits")).toBeDefined();
    expect(screen.getByText("Full Access")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Permission limit for/ }),
    ).toBeNull();
    const machineLink = screen.getByRole("link", { name: "Open dev-vm" });
    expect(machineLink.getAttribute("href")).toBe(
      "/settings/machines/host_remote",
    );
    const row = machineLink.closest("[data-machine-row]");
    expect(row?.className).toContain("hover:bg-state-hover");
    expect(row?.className).toContain("focus-within:bg-state-hover");
    expect(row?.className).toContain("px-2");
    expect(row?.className).toContain("py-2");
    const caret = row?.querySelector('[data-icon="ChevronRight"]');
    expect(caret?.classList.contains("opacity-0")).toBe(true);
    expect(caret?.classList.contains("size-3.5")).toBe(true);
    expect(caret?.classList.contains("text-subtle-foreground")).toBe(true);
    expect(caret?.classList.contains("group-hover:opacity-100")).toBe(true);
    expect(caret?.classList.contains("group-focus-within:opacity-100")).toBe(
      true,
    );
    const overflow = row?.querySelector('[data-icon="MoreHorizontal"]');
    expect(overflow).not.toBeNull();
    expect(caret).not.toBeNull();
    expect(
      overflow && caret
        ? Boolean(
            overflow.compareDocumentPosition(caret) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : false,
    ).toBe(true);
  });

  it("renames a machine through the row menu", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    vi.mocked(sdk.hosts.update).mockResolvedValue({
      ...offlineHost,
      name: "build box",
    });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = await screen.findByLabelText("Machine name");
    fireEvent.change(input, { target: { value: "build box" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename machine" }));

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.update)).toHaveBeenCalledWith({
        hostId: "host_remote",
        name: "build box",
      });
    });
  });

  it("removes a machine after confirmation", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("dev-vm");
    await openHostMenu("dev-vm");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove machine/ }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove machine" }),
    );

    await waitFor(() => {
      expect(vi.mocked(sdk.hosts.delete)).toHaveBeenCalledWith({
        hostId: "host_remote",
      });
    });
  });

  it("disables removal of the primary machine", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([primaryHost, offlineHost]);
    stubSidebarBootstrapFetch();

    renderSection();

    await screen.findByText("MacBook Pro");
    await openHostMenu("MacBook Pro");

    const removeItem = await screen.findByRole("menuitem", {
      name: "Remove machine",
    });
    expect(removeItem.getAttribute("aria-disabled")).toBe("true");
    expect(removeItem.textContent).toBe("Remove machine");
    fireEvent.focus(removeItem);
    expect(
      await screen.findByRole("tooltip", {
        name: "bb's primary machine can't be removed.",
      }),
    ).toBeDefined();
    fireEvent.click(removeItem);
    expect(
      screen.queryByRole("heading", { name: "Remove MacBook Pro?" }),
    ).toBeNull();
    expect(vi.mocked(sdk.hosts.delete)).not.toHaveBeenCalled();
  });
});
