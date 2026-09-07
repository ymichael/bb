// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost as makeHostFixture } from "@bb/test-helpers/domain-fixtures";
import type { SystemConfigResponse } from "@bb/server-contract";
import type {
  ProviderCliKey,
  ProviderCliStatus,
  ProviderCliStatusResponse,
} from "@bb/host-daemon-contract";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { MachineSettingsView } from "./MachineSettingsView";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: vi.fn(),
      list: vi.fn(),
      providerCliStatus: vi.fn(),
      retryUpdate: vi.fn(),
      update: vi.fn(),
    },
    providers: { list: vi.fn() },
    system: { config: vi.fn(), version: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

const hostDaemon = vi.hoisted(() => ({
  localDaemonHostId: null as string | null,
  platform: null as "darwin" | "linux" | "wsl" | "unknown" | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: hostDaemon.localDaemonHostId,
    platform: hostDaemon.platform,
  }),
}));

const HOST_ID = "host_remote";

function host(overrides: Partial<Host> = {}): Host {
  return makeHostFixture({
    id: HOST_ID,
    name: "dev-vm",
    lastSeenAt: Date.now(),
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now(),
    ...overrides,
  });
}

function systemConfig(): SystemConfigResponse {
  return makeSystemConfig({
    primaryHostId: "host_primary",
    primaryHostPlatform: "darwin",
  });
}

function providerCliStatus(
  provider: ProviderCliKey,
  currentVersion: string,
): ProviderCliStatus {
  const identity =
    provider === "codex"
      ? { displayName: "Codex", executableName: "codex" }
      : provider === "claude-code"
        ? { displayName: "Claude Code", executableName: "claude" }
        : { displayName: "Cursor", executableName: "agent" };
  return {
    ...identity,
    executablePath: `/usr/local/bin/${identity.executableName}`,
    installed: true,
    installSource: "npmGlobal",
    currentVersion,
    latestVersion: currentVersion,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

function providerCliStatusResponse(): ProviderCliStatusResponse {
  return {
    codex: providerCliStatus("codex", "0.148.0"),
    "claude-code": providerCliStatus("claude-code", "2.1.235"),
    "acp-cursor": providerCliStatus("acp-cursor", "1.4.6"),
  };
}

function renderView() {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter initialEntries={[`/settings/machines/${HOST_ID}`]}>
      <Routes>
        <Route
          path="/settings/machines/:hostId"
          element={<MachineSettingsView />}
        />
      </Routes>
    </MemoryRouter>,
    { wrapper },
  );
}

function stubSupportingFetches(): void {
  vi.mocked(sdk.hosts.providerCliStatus).mockResolvedValue(
    providerCliStatusResponse(),
  );
  vi.mocked(sdk.providers.list).mockResolvedValue([
    makeProviderInfo({ id: "codex", displayName: "Codex" }),
    makeProviderInfo({ id: "claude-code", displayName: "Claude Code" }),
    makeProviderInfo({ id: "acp-cursor", displayName: "Cursor" }),
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  hostDaemon.localDaemonHostId = null;
  hostDaemon.platform = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("MachineSettingsView", () => {
  it("renders the machine's permission limit as a checked radio with descriptions", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      host({ maxPermissionMode: "auto" }),
    ]);
    stubSupportingFetches();

    renderView();

    const machineHeading = await screen.findByRole("heading", {
      name: /dev-vm/u,
    });
    expect(machineHeading.tagName).toBe("H1");
    const checkedByMode = Object.fromEntries(
      (await screen.findAllByRole("radio")).map((option) => [
        option.textContent?.startsWith("Accept Edits")
          ? "accept-edits"
          : option.textContent?.startsWith("Approve for me")
            ? "auto"
            : "full",
        option.getAttribute("aria-checked"),
      ]),
    );
    expect(checkedByMode).toEqual({
      "accept-edits": "false",
      auto: "true",
      full: "false",
    });
    expect(
      screen
        .getAllByRole("radio")
        .every((option) => option.querySelector("[data-icon]") === null),
    ).toBe(true);
    const machineSubtitle = screen.getByText(/^Online ·/u);
    expect(machineSubtitle.closest("section")).toBeNull();
    expect(screen.queryByRole("img", { name: "Online" })).toBeNull();
    expect(
      screen
        .getByRole("heading", { name: /dev-vm/u })
        .querySelector("[data-icon]"),
    ).toBeNull();
    expect(
      screen
        .getByRole("heading", { name: "Machine information" })
        .closest("section")
        ?.querySelector("[data-icon]"),
    ).toBeNull();
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-provider-icon="codex"] [data-provider-logo]',
        ),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-provider-icon="claude-code"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-provider-icon="acp-cursor"]'),
    ).not.toBeNull();
    expect(
      [...document.querySelectorAll("[data-provider-icon]")].every(
        (node) =>
          node.classList.contains("flex") &&
          node.classList.contains("size-3.5"),
      ),
    ).toBe(true);
    expect(
      screen
        .getByRole("heading", { name: "Provider CLIs" })
        .querySelector("[data-icon]"),
    ).toBeNull();
    const installedLabel = screen.getByText("Installed");
    expect(installedLabel.parentElement?.className).toContain("flex-col");
    expect(installedLabel.parentElement?.className).toContain("sm:flex-row");
    expect(installedLabel.nextElementSibling?.className).toContain(
      "justify-start",
    );
    expect(installedLabel.nextElementSibling?.className).toContain(
      "sm:justify-end",
    );
    expect(screen.getByText(/No sandbox and no approvals/u)).toBeDefined();
  });

  it("keeps Rename in the machine title menu", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([host()]);
    stubSupportingFetches();

    renderView();

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "dev-vm actions" }),
      { button: 0 },
    );
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("shows an offline machine's status as text", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      host({ status: "disconnected", lastSeenAt: Date.now() - 60_000 }),
    ]);
    stubSupportingFetches();

    renderView();

    expect(await screen.findByText(/^Offline · last seen/u)).toBeDefined();
    expect(screen.queryByRole("img", { name: "Offline" })).toBeNull();
  });

  it("links update issues to Updates in a warning pill", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([host()]);
    stubSupportingFetches();
    const statuses = providerCliStatusResponse();
    vi.mocked(sdk.hosts.providerCliStatus).mockResolvedValue({
      ...statuses,
      codex: {
        ...statuses.codex,
        latestVersion: "0.149.0",
        needsUpdate: true,
        installAction: {
          kind: "update",
          label: "Update",
          command: "codex update",
        },
      },
    });

    renderView();

    const issueLink = await screen.findByRole("link", { name: "1 to fix" });
    expect(issueLink.getAttribute("href")).toBe("/settings/updates");
    const pill = issueLink.firstElementChild;
    expect(pill?.className).toContain("bg-surface-attention");
    expect(pill?.className).toContain("text-warning-text");
  });

  it("writes the selected limit to the owner-only route", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([host()]);
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/permission-ceiling")) {
          requests.push({ url, body: String(init?.body ?? "") });
          return new Response(
            JSON.stringify(host({ maxPermissionMode: "accept-edits" })),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    renderView();

    fireEvent.click(
      await screen.findByRole("radio", { name: /Accept Edits/u }),
    );

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.url).toContain(
      `/api/v1/hosts/${HOST_ID}/permission-ceiling`,
    );
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      maxPermissionMode: "accept-edits",
    });
  });

  it("refuses to remove the primary machine", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue({
      ...systemConfig(),
      primaryHostId: HOST_ID,
    });
    vi.mocked(sdk.hosts.list).mockResolvedValue([host()]);
    stubSupportingFetches();

    renderView();

    const remove = await screen.findByRole("button", {
      name: "Remove machine",
    });
    expect(remove.hasAttribute("disabled")).toBe(true);
    expect(remove.className).toContain("bg-destructive");
    expect(remove.parentElement?.className).not.toContain("justify-end");
    expect(screen.queryByText("This machine")).toBeNull();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(
      screen.getByText("bb's primary machine can't be removed."),
    ).toBeDefined();
  });

  it("shows client-local identity only when several machines need disambiguation", async () => {
    hostDaemon.localDaemonHostId = HOST_ID;
    hostDaemon.platform = "linux";
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      host(),
      host({ id: "host_primary", name: "workstation" }),
    ]);
    stubSupportingFetches();

    renderView();

    expect(await screen.findByText("This machine")).toBeDefined();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByText(/Linux/u)).toBeDefined();
  });

  it("suppresses the client-local badge when there is only one machine", async () => {
    hostDaemon.localDaemonHostId = HOST_ID;
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([host()]);
    stubSupportingFetches();

    renderView();

    await screen.findByRole("heading", { name: /dev-vm/u });
    expect(screen.queryByText("This machine")).toBeNull();
  });

  it("explains a machine that is no longer paired", async () => {
    vi.mocked(sdk.system.config).mockResolvedValue(systemConfig());
    vi.mocked(sdk.hosts.list).mockResolvedValue([]);
    stubSupportingFetches();

    renderView();

    expect(
      await screen.findByText("Machine is no longer paired."),
    ).toBeDefined();
  });
});
