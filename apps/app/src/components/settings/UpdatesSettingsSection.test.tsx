// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@bb/domain";
import { makeHost as makeHostFixture } from "@bb/test-helpers/domain-fixtures";
import type { BbDesktopApi, BbDesktopInfo } from "@bb/desktop-contract";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type ProviderCliKey,
} from "@bb/host-daemon-contract";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import type {
  ProviderCliIssue,
  ProviderCliActionableIssue,
} from "@/components/provider-cli/provider-cli-install";
import { useProviderCliInstallRunner } from "@/components/provider-cli/provider-cli-install";
import { resetAppUpdateCheckStoreForTests } from "@/components/settings/app-update-check-store";
import {
  getProviderCliInstallSnapshot,
  resetProviderCliInstallStoreForTests,
} from "@/components/provider-cli/provider-cli-install-store";
import { sdk } from "@/lib/sdk";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import {
  useUpdateInventory,
  type UpdateInventory,
  type UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { UpdatesSettingsSection } from "./UpdatesSettingsSection";

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/sdk", async () => {
  const { makeProviderInfo } = await import("@bb/test-helpers/domain-fixtures");
  return {
    sdk: {
      system: { version: vi.fn() },
      providers: {
        list: vi.fn(async () => [
          makeProviderInfo({ id: "codex", displayName: "Codex" }),
          makeProviderInfo({ id: "claude-code", displayName: "Claude Code" }),
          makeProviderInfo({ id: "acp-cursor", displayName: "Cursor" }),
        ]),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("@/hooks/useUpdateInventory", () => ({
  useUpdateInventory: vi.fn(),
}));

vi.mock("@/hooks/useDesktopUpdateInfo", () => ({
  useDesktopUpdateInfo: vi.fn(),
}));

const hostDaemon = vi.hoisted(() => ({
  localDaemonHostId: null as string | null,
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: hostDaemon.localDaemonHostId,
  }),
}));

const openUrlInExternalBrowserMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/url-open-routing", () => ({
  openUrlInExternalBrowser: openUrlInExternalBrowserMock,
}));

const retryHostUpdateMutateMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/mutations/host-mutations", () => ({
  useRetryHostUpdate: () => ({
    isPending: false,
    mutate: retryHostUpdateMutateMock,
    variables: undefined,
  }),
}));

const startInstallMock = vi.fn();

vi.mock("@/components/provider-cli/provider-cli-install", async (original) => {
  const actual =
    await original<
      typeof import("@/components/provider-cli/provider-cli-install")
    >();
  return {
    ...actual,
    useProviderCliInstallRunner: vi.fn(() => ({
      failuresByJobKey: new Map(),
      queuedJobKeys: new Set<string>(),
      runningJobKey: null,
      startInstall: startInstallMock,
    })),
  };
});

function makeHost(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHostFixture({
    lastSeenAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });
}

function makeUpdateIssue(args: {
  provider: ProviderCliKey;
}): ProviderCliActionableIssue {
  const identity =
    args.provider === "codex"
      ? { displayName: "Codex", executableName: "codex" }
      : args.provider === "claude-code"
        ? { displayName: "Claude Code", executableName: "claude" }
        : { displayName: "Cursor", executableName: "agent" };
  const { displayName, executableName } = identity;
  const action = {
    kind: "update" as const,
    label: "Update" as const,
    command: `${executableName} update`,
  };
  return {
    provider: args.provider,
    status: {
      displayName,
      executableName,
      executablePath: `/usr/local/bin/${executableName}`,
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "1.0.0",
      latestVersion: "1.0.1",
      minimumSupportedVersion: null,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: action,
      needsUpdate: true,
      versionUnsupported: false,
    },
    action,
    title: `${displayName} update available`,
    description: "1.0.0 -> 1.0.1",
    fingerprint: `${args.provider}:outdated`,
  };
}

function makeManualUpdateIssue(args: {
  provider: "codex" | "claude-code";
}): ProviderCliIssue {
  const issue = makeUpdateIssue(args);
  return {
    ...issue,
    action: null,
    status: {
      ...issue.status,
      installSource: "external",
      installAction: null,
    },
  };
}

function makeMachine(args: {
  host: Host;
  issues?: ProviderCliIssue[];
  isPrimary?: boolean;
  statusPending?: boolean;
  statusError?: boolean;
  canRetryDaemonUpdate?: boolean;
}): UpdateInventoryMachine {
  const issues = args.issues ?? [];
  const upToDate = (provider: ProviderCliKey) => {
    const issue = issues.find((entry) => entry.provider === provider);
    if (issue !== undefined) {
      return issue.status;
    }
    const base = makeUpdateIssue({ provider }).status;
    return {
      ...base,
      latestVersion: base.currentVersion,
      needsUpdate: false,
    };
  };
  const cursorIssue = issues.find((entry) => entry.provider === "acp-cursor");
  const cursorStatus =
    cursorIssue?.status ??
    ({
      ...makeUpdateIssue({ provider: "acp-cursor" }).status,
      installed: false,
      currentVersion: null,
      latestVersion: null,
      needsUpdate: false,
      installAction: null,
    } as const);
  return {
    host: args.host,
    isPrimary: args.isPrimary ?? false,
    providerStatus:
      args.host.status === "connected"
        ? {
            codex: upToDate("codex"),
            "claude-code": upToDate("claude-code"),
            "acp-cursor": cursorStatus,
          }
        : null,
    statusPending: args.statusPending ?? false,
    statusFetching: args.statusPending ?? false,
    statusError: args.statusError ?? false,
    issues,
    canRetryDaemonUpdate: args.canRetryDaemonUpdate ?? false,
  };
}

function makeInventory(overrides: Partial<UpdateInventory>): UpdateInventory {
  return {
    isLoading: false,
    systemVersion: {
      currentVersion: "0.0.5",
      latestVersion: "0.0.5",
      source: "npm",
      updateAvailable: false,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    },
    desktopInfo: null,
    appUpdateAvailable: false,
    desktopUpdateReady: false,
    machines: [
      makeMachine({
        host: makeHost({ id: "host_primary", name: "workstation" }),
        isPrimary: true,
      }),
    ],
    pluginAttentionCount: 0,
    actionableCount: 0,
    hasAttention: false,
    lastCheckedAt: null,
    ...overrides,
  };
}

function renderSection({
  showChangelogPreview = false,
}: { showChangelogPreview?: boolean } = {}): void {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <UpdatesSettingsSection showChangelogPreview={showChangelogPreview} />
        </QueryClientProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const useUpdateInventoryMock = vi.mocked(useUpdateInventory);
const useDesktopUpdateInfoMock = vi.mocked(useDesktopUpdateInfo);
const useProviderCliInstallRunnerMock = vi.mocked(useProviderCliInstallRunner);

beforeEach(() => {
  hostDaemon.localDaemonHostId = null;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Changelog unavailable offline")),
  );
  useProviderCliInstallRunnerMock.mockReturnValue({
    failuresByJobKey: new Map(),
    queuedJobKeys: new Set<string>(),
    runningJobKey: null,
    startInstall: startInstallMock,
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.localStorage.clear();
  resetAppUpdateCheckStoreForTests();
  resetProviderCliInstallStoreForTests();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdatesSettingsSection", () => {
  it("checks for updates once when the view mounts", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({ machines: [makeMachine({ host })] }),
    );
    vi.mocked(sdk.system.version).mockResolvedValue(
      makeInventory({}).systemVersion!,
    );

    renderSection();

    expect(screen.queryByRole("button", { name: /check/i })).toBeNull();
    await waitFor(() => {
      expect(sdk.system.version).toHaveBeenCalledWith({ force: true });
    });
    expect(sdk.system.version).toHaveBeenCalledTimes(1);
  });

  it("places fleet-wide Update all above every machine section", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({ id: "host_1", name: "workstation" }),
            issues: [makeUpdateIssue({ provider: "codex" })],
          }),
          makeMachine({
            host: makeHost({ id: "host_2", name: "homelab" }),
            issues: [makeUpdateIssue({ provider: "claude-code" })],
          }),
        ],
      }),
    );

    renderSection();

    const bulkActions = screen.getByRole("toolbar", {
      name: "Bulk update actions",
    });
    const updateAll = bulkActions.querySelector(
      '[aria-label="Update all 2 CLI tools"]',
    );
    expect(updateAll).not.toBeNull();
    expect(updateAll?.className).toContain("bg-foreground");
    expect(updateAll?.className).toContain("text-background");
    expect(updateAll?.textContent).toBe("Update all");
    expect(updateAll?.firstElementChild?.getAttribute("data-icon")).toBe(
      "Download",
    );
    const workstationHeading = screen.getByRole("heading", {
      name: "workstation",
    });
    const homelabHeading = screen.getByRole("heading", { name: "homelab" });
    const workstationSection = workstationHeading.closest(
      "[data-updates-machine]",
    );
    const homelabSection = homelabHeading.closest("[data-updates-machine]");
    const fleetHeading = screen.getByRole("heading", {
      name: "Machine updates",
    });
    const fleetSection = fleetHeading.closest("section");
    const fleetHeader = fleetSection?.firstElementChild;
    const fleetBody = fleetSection?.children.item(1);
    expect(fleetHeader?.contains(bulkActions)).toBe(true);
    expect(fleetBody?.contains(workstationSection)).toBe(true);
    expect(fleetBody?.contains(homelabSection)).toBe(true);
    expect(workstationSection?.contains(bulkActions)).toBe(false);
    expect(homelabSection?.contains(bulkActions)).toBe(false);
    expect(bulkActions.querySelector('[data-icon="Download"]')).not.toBeNull();
    expect(
      screen.getByText(
        "Manage bb and provider CLI updates across all machines.",
      ),
    ).toBeDefined();
  });

  it("keeps the changelog preview behind its experiment", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(makeInventory({}));

    renderSection();

    expect(
      document.querySelector('[data-updates-domain="changelog"]'),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a recently checked healthy fleet quiet and accessible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(`# Changelog

## 9.9.9

The canonical release summary.

### New features

- One current feature.

### Fixes

- One current fix.
`),
        ),
      ),
    );
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        lastCheckedAt: Date.now() - 2 * 60 * 1000,
        machines: [
          makeMachine({
            host: makeHost({ id: "host_1", name: "workstation" }),
            isPrimary: true,
          }),
          makeMachine({
            host: makeHost({ id: "host_2", name: "studio-mac" }),
          }),
        ],
      }),
    );

    renderSection({ showChangelogPreview: true });

    await waitFor(() => {
      expect(
        screen
          .getAllByText("Up to date")
          .every((label) => label.className.includes("sr-only")),
      ).toBe(true);
    });
    expect(screen.queryByText("2 up to date")).toBeNull();
    expect(screen.getByRole("heading", { name: /workstation/ })).toBeDefined();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.queryByText("This machine")).toBeNull();
    expect(screen.getByRole("heading", { name: /studio-mac/ })).toBeDefined();
    expect(screen.getAllByText("Codex")).toHaveLength(2);
    expect(screen.getAllByText("Claude Code")).toHaveLength(2);
    expect(screen.queryByText(/Checked/)).toBeNull();
    expect(screen.queryByText(/ago$/)).toBeNull();
    expect(screen.queryByText(/^In sync$/)).toBeNull();
    expect(screen.queryByText("workstation, studio-mac")).toBeNull();
    expect(screen.queryByRole("button", { name: /check/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Updates" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Open the full bb .* changelog$/ }),
    ).toBeDefined();
    const changelog = document.querySelector(
      '[data-updates-domain="changelog"]',
    );
    await waitFor(() => {
      expect(changelog?.textContent).toContain("9.9.9");
    });
    expect(
      within(changelog as HTMLElement).getByRole("heading", {
        level: 2,
        name: "What's new",
      }),
    ).toBeDefined();
    expect(
      within(changelog as HTMLElement).getByRole("heading", {
        level: 3,
        name: "9.9.9",
      }),
    ).toBeDefined();
    expect(changelog?.textContent).toContain("The canonical release summary.");
    expect(
      changelog?.querySelector('[data-changelog-version="9.9.9"]'),
    ).toBeNull();
    const changelogLabel = changelog?.querySelector("[data-changelog-label]");
    expect(changelogLabel?.className).toContain("rounded-sm");
    expect(changelogLabel?.className).not.toContain("rounded-full");
    expect(changelogLabel?.className).toContain("bg-muted/40");
    const changelogPreview = changelog?.querySelector(
      "[data-changelog-preview]",
    );
    expect(changelogPreview?.className).toContain("p-4");
    expect(changelogPreview?.className).not.toContain("grid");
    expect(
      changelog?.querySelector("[data-changelog-release-scroll]")?.className,
    ).toContain("max-h-56");
    expect(
      changelog?.querySelector("[data-changelog-footer]")?.className,
    ).toContain("border-t");
    expect(
      changelog?.querySelector("[data-changelog-footer]")?.className,
    ).toContain("bg-foreground");
    expect(
      changelog?.querySelector("[data-changelog-footer]")?.className,
    ).toContain("text-background");
    expect(changelog?.textContent).toContain("Full changelog");
    expect(
      screen.getByRole("button", {
        name: "Open the full bb 9.9.9 changelog",
      }).className,
    ).toContain("font-semibold");
    for (const highlight of ["New features", "Fixes"]) {
      expect(
        within(changelog as HTMLElement).getByRole("heading", {
          level: 4,
          name: highlight,
        }),
      ).toBeDefined();
    }
    expect(changelog?.textContent).toContain("One current feature.");
    expect(changelog?.textContent).toContain("One current fix.");
    const dismissChangelog = screen.getByRole("button", {
      name: "Dismiss bb 9.9.9 changelog preview",
    });
    const changelogHeader = changelog?.querySelector("[data-changelog-header]");
    const changelogCard = changelogHeader?.closest("section");
    expect(changelogPreview?.firstElementChild).toBe(changelogHeader);
    expect(changelogHeader?.className).not.toContain("border-b");
    expect(changelogHeader?.contains(dismissChangelog)).toBe(true);
    expect(changelogCard?.contains(changelogPreview ?? null)).toBe(true);
    expect(dismissChangelog.querySelector('[data-icon="X"]')).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open the full bb 9.9.9 changelog",
      }),
    );
    expect(openUrlInExternalBrowserMock).toHaveBeenCalledWith(
      "https://getbb.app/changelog#9-9-9",
    );
    vi.useFakeTimers();
    fireEvent.click(dismissChangelog);
    expect(screen.getByRole("status").textContent).toContain(
      "You're all caught up",
    );
    expect(
      screen.queryByRole("button", {
        name: "Open the full bb 9.9.9 changelog",
      }),
    ).toBeNull();
    expect(changelog?.getAttribute("data-changelog-dismiss-phase")).toBe(
      "confirming",
    );
    expect(
      changelog?.querySelector("[data-changelog-release-panel]")?.className,
    ).toContain("grid-rows-[0fr]");
    const confirmation = changelog?.querySelector(
      "[data-changelog-dismiss-confirmation]",
    );
    expect(confirmation?.className).toContain("grid-rows-[1fr]");
    expect(confirmation?.className).not.toContain("absolute");
    expect(changelog?.className).toContain("motion-reduce:transition-none");
    expect(
      window.localStorage.getItem(
        "bb.settings.updates.dismissed-changelog-version",
      ),
    ).toBe("9.9.9");

    act(() => vi.advanceTimersByTime(1_999));
    expect(changelog?.getAttribute("data-changelog-dismiss-phase")).toBe(
      "confirming",
    );
    act(() => vi.advanceTimersByTime(1));
    expect(changelog?.getAttribute("data-changelog-dismiss-phase")).toBe(
      "exiting",
    );
    expect(changelog?.className).toContain("grid-rows-[0fr]");
    act(() => vi.advanceTimersByTime(180));
    expect(
      document.querySelector('[data-updates-domain="changelog"]'),
    ).toBeNull();
    vi.useRealTimers();

    cleanup();
    renderSection({ showChangelogPreview: true });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(
      document.querySelector('[data-updates-domain="changelog"]'),
    ).toBeNull();

    cleanup();
    window.localStorage.setItem(
      "bb.settings.updates.dismissed-changelog-version",
      "9.9.8",
    );
    renderSection({ showChangelogPreview: true });
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Dismiss bb 9.9.9 changelog preview",
        }),
      ).toBeDefined();
    });

    const settledRows = screen.getAllByText(/^Up to date/);
    expect(
      settledRows.every(
        (settled) =>
          settled.parentElement?.querySelector(".bg-success") === null,
      ),
    ).toBe(true);
    expect(document.querySelector(".bg-success")).toBeNull();
    expect(
      document
        .querySelector(
          '[data-update-state="up-to-date"] [data-icon="CircleCheck"]',
        )
        ?.getAttribute("class"),
    ).toContain("text-input");
    expect(
      document
        .querySelector(
          '[data-update-state="up-to-date"] [data-icon="CircleCheck"]',
        )
        ?.getAttribute("class"),
    ).not.toContain("opacity-");
  });

  it("does not call an offline fleet all in sync", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({
              id: "host_1",
              name: "homelab",
              status: "disconnected",
            }),
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("homelab")).toBeDefined();
    expect(screen.queryByText("1 offline")).toBeNull();
    expect(screen.getByText("Offline")).toBeDefined();
    const offlineIcon = document.querySelector(
      '[data-update-state="offline"] [data-icon="CircleX"]',
    );
    expect(offlineIcon?.getAttribute("class")).toContain(
      "text-subtle-foreground",
    );
    expect(offlineIcon?.getAttribute("class")).not.toContain("text-input");
    const daemonRow = screen
      .getByText("bb daemon")
      .closest("[data-resource-row]");
    expect(daemonRow).not.toBeNull();
    expect(screen.getByText("bb app")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open homelab settings" }),
    ).toBeDefined();
    expect(
      daemonRow?.querySelector('[data-bb-update-role="daemon"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-bb-update-role="app"]'),
    ).not.toBeNull();
    expect(daemonRow?.querySelector('[data-icon="Laptop"]')).toBeNull();
    await waitFor(() => {
      expect(screen.getByText(/^Up to date/)).toBeDefined();
    });
    expect(screen.queryByText(/all in sync/)).toBeNull();
  });

  it("shows only machines with relevant health status in a mixed fleet", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const stalledHost = makeHost({
      id: "host_3",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: Date.now() - 3 * 60 * 1000,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({ id: "host_1", name: "workstation" }),
          }),
          makeMachine({
            host: makeHost({
              id: "host_2",
              name: "studio-mac",
              status: "disconnected",
            }),
          }),
          makeMachine({
            host: stalledHost,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    expect(document.querySelectorAll("[data-updates-machine]")).toHaveLength(3);
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.getByText("workstation")).toBeDefined();
    expect(screen.getByText("studio-mac")).toBeDefined();
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.getByText("homelab")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /^Failed · Retry on/ }),
    ).toBeDefined();
  });

  it("treats a recent daemon protocol mismatch as an automatic update", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({
      id: "host_1",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("homelab")).toBeDefined();
    expect(screen.queryByText("1 updating")).toBeNull();
    expect(screen.getByText("bb daemon")).toBeDefined();
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
    expect(
      document.querySelector('[data-updates-machine="host_1"]'),
    ).not.toBeNull();
    expect(screen.queryByText("1 machine is updating bb")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry update" })).toBeNull();
    expect(screen.queryByText(/can't connect/i)).toBeNull();
  });

  it("explains and retries a daemon update that has stalled", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({
      id: "host_1",
      name: "homelab",
      status: "disconnected",
      lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      updatedAt: Date.now() - 3 * 60 * 1000,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            canRetryDaemonUpdate: true,
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("homelab")).toBeDefined();
    expect(screen.queryByText("1 needs attention")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Failed · Retry on homelab now" }),
    ).toBeDefined();
    expect(screen.queryByText("1 machine needs attention")).toBeNull();
    expect(screen.queryByText(/daemon protocol/)).toBeNull();
    expect(
      screen.getByText("bb daemon").closest("[data-resource-row]")?.className,
    ).not.toContain("bg-surface-destructive");
    expect(screen.queryByText(/^Up to date/)).toBeNull();
    const stalledMessage = screen.getByText("Update didn't finish");
    expect(stalledMessage.tagName).toBe("SPAN");
    expect(stalledMessage.className).toContain("font-semibold");
    expect(stalledMessage.className).toContain("text-destructive");
    expect(stalledMessage.className).not.toContain("rounded");
    expect(stalledMessage.className).not.toContain("font-mono");
    expect(
      screen.getAllByRole("button", { name: /^Failed · Retry on/ }),
    ).toHaveLength(1);

    expect(
      screen.queryByRole("button", { name: /Update all .* machines now/ }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Failed · Retry on homelab now",
      }),
    );
    expect(retryHostUpdateMutateMock).toHaveBeenCalledWith(
      host.id,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("names a machine running a newer bb than the server", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: makeHost({
              id: "host_1",
              name: "homelab",
              status: "disconnected",
              lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
            }),
            canRetryDaemonUpdate: false,
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("Update this app to reconnect")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Update homelab now/ }),
    ).toBeNull();
  });

  it("sweeps every machine stalled on the same bb update", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const stalled = ["workstation", "studio-mac", "homelab"].map(
      (name, index) =>
        makeHost({
          id: `host_${index}`,
          name,
          status: "disconnected",
          lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
          updatedAt: Date.now() - 3 * 60 * 1000,
        }),
    );
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: stalled.map((host) =>
          makeMachine({ host, canRetryDaemonUpdate: true }),
        ),
      }),
    );

    renderSection();

    expect(screen.queryByText(/^Up to date/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Update all 3 machines now",
      }),
    );
    expect(retryHostUpdateMutateMock).toHaveBeenCalledTimes(3);
    for (const host of stalled) {
      expect(retryHostUpdateMutateMock).toHaveBeenCalledWith(host.id);
    }
    expect(
      screen.getByRole("button", {
        name: "Failed · Retry on studio-mac now",
      }),
    ).toBeDefined();
  });

  it("shows installed provider CLIs including up-to-date rows", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const codexIssue = makeUpdateIssue({ provider: "codex" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({ host, issues: [codexIssue], isPrimary: true }),
        ],
      }),
    );

    renderSection();

    const machineHeading = screen.getByRole("heading", {
      name: /workstation/,
    });
    const machineSection = machineHeading.closest("section");
    expect(machineSection).not.toBeNull();
    expect(machineHeading.className).toContain("font-semibold");
    expect(machineHeading.className).toContain("text-foreground");
    const machineName = screen.getByText("workstation");
    expect(machineHeading.querySelector('[data-icon="Laptop"]')).not.toBeNull();
    expect(machineName.nextElementSibling).toBeNull();
    expect(screen.getByText("bb app")).toBeDefined();
    expect(screen.queryByLabelText(/available update/)).toBeNull();
    expect(screen.getAllByText("workstation")).toHaveLength(1);
    expect(screen.getByText("Codex")).toBeDefined();
    const claudeRow = screen
      .getByText("Claude Code")
      .closest("[data-resource-row]");
    expect(claudeRow).not.toBeNull();
    expect(
      claudeRow?.querySelector('[data-update-state="up-to-date"]'),
    ).not.toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
    expect(screen.queryByText(/^Update available/)).toBeNull();
    expect(screen.queryByText("Choose an update below.")).toBeNull();
    const providerIcon = await waitFor(() => {
      const node = document.querySelector('[data-provider-icon="codex"]');
      expect(node).not.toBeNull();
      expect(node?.querySelector("[data-provider-logo]")).not.toBeNull();
      return node;
    });
    expect(
      providerIcon
        ?.querySelector("[data-provider-logo]")
        ?.getAttribute("class"),
    ).toContain("text-muted-foreground");
    expect(providerIcon?.classList.contains("flex")).toBe(true);
    expect(providerIcon?.classList.contains("size-3.5")).toBe(true);
    const updateButton = screen.getAllByRole("button", {
      name: "Update available · Update Codex on workstation",
    })[0];
    expect(updateButton.textContent).toBe("");
    expect(updateButton.className).toContain("text-muted-foreground");
    expect(updateButton.className).not.toContain("bg-secondary");
    expect(updateButton.className).not.toContain("bg-foreground");
    const versionMetadata = machineSection
      ?.querySelector('[data-provider-icon="codex"]')
      ?.closest("[data-resource-row]")
      ?.querySelector("[data-version-metadata]");
    expect(versionMetadata?.className).toContain("text-2xs");
    expect(versionMetadata?.className).not.toContain("text-right");
    expect(versionMetadata?.className).not.toContain("ml-auto");
    expect(versionMetadata?.className).not.toContain("font-mono");
    const upgrade = versionMetadata?.querySelector(".text-version-upgrade");
    expect(upgrade?.textContent).toBe("1.0.1");
    expect(upgrade?.className).toContain("font-semibold");
    expect(screen.queryByText("1 up to date")).toBeNull();
  });

  it("badges the client-local daemon independently from the primary update owner", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const primary = makeHost({ id: "host_primary", name: "workstation" });
    const local = makeHost({ id: "host_local", name: "studio-mac" });
    hostDaemon.localDaemonHostId = local.id;
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host: primary,
            issues: [makeUpdateIssue({ provider: "codex" })],
            isPrimary: true,
          }),
          makeMachine({
            host: local,
            issues: [makeUpdateIssue({ provider: "claudeCode" })],
          }),
        ],
      }),
    );

    renderSection();

    const primaryHeading = screen.getByRole("heading", {
      name: /workstation/u,
    });
    const localHeading = screen.getByRole("heading", { name: /studio-mac/u });
    expect(primaryHeading.textContent).not.toContain("Primary");
    expect(primaryHeading.textContent).not.toContain("This machine");
    expect(localHeading.textContent).toContain("This machine");
    expect(localHeading.textContent).not.toContain("Primary");
  });

  it("lists Cursor updates with the other provider CLIs", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const cursorIssue = makeUpdateIssue({ provider: "acp-cursor" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, issues: [cursorIssue] })],
      }),
    );

    renderSection();

    expect(
      screen.getByRole("button", { name: "Open Cursor settings" }),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        document.querySelector('[data-provider-icon="acp-cursor"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Update available · Update Cursor on workstation",
      }),
    );
    expect(startInstallMock).toHaveBeenCalledWith({
      hostId: "host_1",
      issue: cursorIssue,
    });
  });

  it("names a machine once above all of its CLI updates", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            issues: [
              makeUpdateIssue({ provider: "codex" }),
              makeUpdateIssue({ provider: "claude-code" }),
            ],
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getAllByText("workstation")).toHaveLength(1);
    expect(screen.getByText("Codex")).toBeDefined();
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(
      document
        .querySelector('[data-updates-machine="host_1"]')
        ?.querySelectorAll("[data-resource-row] [data-version-metadata]")
        .length,
    ).toBe(2);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: /^Update available · Update/,
      })[0],
    );
    expect(startInstallMock).toHaveBeenCalledTimes(1);
    expect(startInstallMock.mock.calls[0]?.[0]).toMatchObject({
      hostId: "host_1",
    });
  });

  it("keeps background provider checks out of the compact view", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, statusPending: true })],
      }),
    );

    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/^Up to date/)).toBeDefined();
    });
    expect(screen.queryByText("1 up to date")).toBeNull();
    expect(screen.getByRole("heading", { name: "workstation" })).toBeDefined();
    expect(screen.queryByText("Checking provider CLIs…")).toBeNull();
  });

  it("offers a way out of a failed CLI check", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, statusError: true })],
      }),
    );

    renderSection();

    await waitFor(() => {
      expect(screen.getByText("Couldn't check for updates")).toBeDefined();
    });
    const retry = screen.getByRole("button", {
      name: /Check workstation's CLIs again/,
    });
    expect(retry.hasAttribute("disabled")).toBe(false);
  });

  it("keeps error red on the reason and off the recovery", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, statusError: true })],
      }),
    );

    renderSection();

    const failedStatus = screen.getByText("Couldn't check for updates");
    expect(failedStatus.tagName).toBe("SPAN");
    for (const className of [
      "shrink-0",
      "text-xs",
      "font-semibold",
      "text-destructive",
    ]) {
      expect(failedStatus.className).toContain(className);
    }
    for (const className of [
      "rounded",
      "border",
      "px-",
      "py-",
      "bg-",
      "font-mono",
    ]) {
      expect(failedStatus.className).not.toContain(className);
    }
    expect(
      screen.getByRole("button", { name: /Check workstation's CLIs again/ })
        .className,
    ).not.toContain("text-destructive");
  });

  it("leaves never-installed CLIs off an update page", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const missingCodex = makeUpdateIssue({ provider: "codex" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({
            host,
            issues: [
              {
                ...missingCodex,
                status: {
                  ...missingCodex.status,
                  installed: false,
                  currentVersion: null,
                },
              },
              makeUpdateIssue({ provider: "claude-code" }),
            ],
          }),
        ],
      }),
    );

    renderSection();

    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("removes running and queued provider jobs from Update all", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const codexIssue = makeUpdateIssue({ provider: "codex" });
    const claudeIssue = makeUpdateIssue({ provider: "claude-code" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, issues: [codexIssue, claudeIssue] })],
      }),
    );
    useProviderCliInstallRunnerMock.mockReturnValue({
      failuresByJobKey: new Map(),
      queuedJobKeys: new Set(["host_1:claude-code"]),
      runningJobKey: "host_1:codex",
      startInstall: startInstallMock,
    });

    renderSection();

    expect(screen.queryByRole("button", { name: /Update all/ })).toBeNull();
    expect(screen.queryByText("2 updates in progress")).toBeNull();
    expect(
      document.querySelectorAll(
        '[data-updates-machine="host_1"] [data-resource-row] [data-update-state="in-progress"]',
      ).length,
    ).toBe(2);
    for (const providerId of ["codex", "claude-code"]) {
      await waitFor(() =>
        expect(
          document
            .querySelector(
              `[data-provider-icon="${providerId}"] [data-provider-logo]`,
            )
            ?.getAttribute("class"),
        ).toContain("text-muted-foreground"),
      );
    }
  });

  it("keeps a provider update failure and its command log on the row", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const issue = makeUpdateIssue({ provider: "claude-code" });
    const logDialogState = {
      displayName: "Claude Code",
      log: "$ claude update\npermission denied\n",
      message: "Command exited with code 1",
      title: "Claude Code update log",
    };
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, issues: [issue] })],
      }),
    );
    useProviderCliInstallRunnerMock.mockReturnValue({
      failuresByJobKey: new Map([
        [
          "host_1:claude-code",
          { issueFingerprint: issue.fingerprint, logDialogState },
        ],
      ]),
      queuedJobKeys: new Set(),
      runningJobKey: null,
      startInstall: startInstallMock,
    });

    renderSection();

    expect(screen.getByText("Failed")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toBe(
      "Command exited with code 1",
    );
    expect(
      screen.getByRole("button", {
        name: "Failed · Retry Claude Code on workstation",
      }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "View Claude Code update log" }),
    );
    expect(getProviderCliInstallSnapshot().logDialogState).toEqual(
      logDialogState,
    );
  });

  it("forces the web update check and shows the upgrade command inline", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const availableVersion = {
      currentVersion: "0.0.5",
      latestVersion: "0.0.6",
      source: "npm" as const,
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    };
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        systemVersion: availableVersion,
        appUpdateAvailable: true,
        actionableCount: 1,
        hasAttention: true,
      }),
    );
    vi.mocked(sdk.system.version).mockResolvedValue(availableVersion);

    renderSection();
    expect(screen.getByText("npx bb-app@latest")).toBeDefined();
    expect(screen.getByText("0.0.6")).toBeDefined();
    const copyButton = screen.getByRole("button", {
      name: "Update available · Copy the upgrade command",
    });
    expect(copyButton.textContent).toBe("");
    expect(copyButton.className).not.toContain("bg-secondary");
    const updateSurface = document.querySelector(
      '[data-updates-machine="host_primary"]',
    );
    expect(updateSurface?.querySelector(".bg-card")).not.toBeNull();
    expect(updateSurface?.querySelector(".divide-y")).not.toBeNull();
    expect(screen.queryByText(/^Update available/)).toBeNull();

    await waitFor(() => {
      expect(sdk.system.version).toHaveBeenCalledWith({ force: true });
    });
  });

  it("checks for desktop updates through the desktop bridge", async () => {
    const desktopInfo: BbDesktopInfo = {
      downloadState: "downloaded",
      lastCheckedAt: null,
      latestVersion: "0.0.6",
      pendingVersion: "0.0.6",
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: true,
      version: "0.0.5",
    };
    const checkForUpdates = vi.fn().mockResolvedValue(desktopInfo);
    const installUpdate = vi.fn().mockResolvedValue(undefined);
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: { checkForUpdates, installUpdate } as unknown as BbDesktopApi,
      desktopInfo,
      isDesktop: true,
    });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        desktopInfo,
        desktopUpdateReady: true,
        actionableCount: 1,
        hasAttention: true,
      }),
    );

    renderSection();
    const relaunch = screen.getByRole("button", {
      name: /Relaunch bb to finish updating/,
    });
    expect(relaunch.querySelector("img")?.className).toContain("size-3");
    expect(relaunch.className).toContain("border");
    fireEvent.click(relaunch);
    expect(installUpdate).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });
    expect(sdk.system.version).not.toHaveBeenCalled();
  });

  it("does not claim a legacy desktop shell is downloading an available update", () => {
    const desktopInfo: BbDesktopInfo = {
      lastCheckedAt: null,
      latestVersion: "0.0.6",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: false,
      version: "0.0.5",
    };
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: {} as BbDesktopApi,
      desktopInfo,
      isDesktop: true,
    });
    useUpdateInventoryMock.mockReturnValue(makeInventory({ desktopInfo }));

    renderSection();

    expect(screen.getByText("Update available")).toBeDefined();
    expect(screen.queryByText("Downloading in the background…")).toBeNull();
  });

  it("retries a failed desktop download through the desktop bridge", async () => {
    const desktopInfo: BbDesktopInfo = {
      downloadState: "failed",
      lastCheckedAt: null,
      latestVersion: "0.0.6",
      pendingVersion: null,
      platform: "macos",
      updateAvailable: true,
      updateDownloaded: false,
      version: "0.0.5",
    };
    const checkForUpdates = vi.fn().mockResolvedValue(desktopInfo);
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: { checkForUpdates } as unknown as BbDesktopApi,
      desktopInfo,
      isDesktop: true,
    });
    useUpdateInventoryMock.mockReturnValue(makeInventory({ desktopInfo }));

    renderSection();
    await waitFor(() => {
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Failed · Retry the download" }),
    );

    await waitFor(() => {
      expect(checkForUpdates).toHaveBeenCalledTimes(2);
    });
  });

  it("runs every actionable provider update across machines from Update all", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const laptop = makeHost({ id: "host_1", name: "laptop" });
    const homelab = makeHost({ id: "host_2", name: "homelab" });
    const laptopIssue = makeUpdateIssue({ provider: "codex" });
    const homelabIssue = makeUpdateIssue({ provider: "claude-code" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [
          makeMachine({ host: laptop, issues: [laptopIssue] }),
          makeMachine({ host: homelab, issues: [homelabIssue] }),
        ],
        actionableCount: 2,
        hasAttention: true,
      }),
    );

    renderSection();
    expect(useProviderCliInstallRunnerMock).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "laptop" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "homelab" })).toBeDefined();
    const updateAll = screen.getByRole("button", {
      name: "Update all 2 CLI tools",
    });
    expect(updateAll.textContent).toBe("Update all");
    expect(updateAll.firstElementChild?.getAttribute("data-icon")).toBe(
      "Download",
    );

    fireEvent.click(updateAll);
    expect(startInstallMock).toHaveBeenCalledTimes(2);
    expect(startInstallMock).toHaveBeenNthCalledWith(1, {
      hostId: "host_1",
      issue: laptopIssue,
    });
    expect(startInstallMock).toHaveBeenNthCalledWith(2, {
      hostId: "host_2",
      issue: homelabIssue,
    });
  });

  it("shows an external Claude installation as a manual update without an update button", () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    const host = makeHost({ id: "host_1", name: "workstation" });
    const issue = makeManualUpdateIssue({ provider: "claude-code" });
    useUpdateInventoryMock.mockReturnValue(
      makeInventory({
        machines: [makeMachine({ host, issues: [issue] })],
        actionableCount: 1,
        hasAttention: true,
      }),
    );

    renderSection();

    expect(screen.getAllByText("Update in terminal").length).toBeGreaterThan(0);
    expect(screen.queryByText("1 update needs manual action")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update all/ })).toBeNull();
  });

  it("omits an empty machine container", async () => {
    useDesktopUpdateInfoMock.mockReturnValue({
      desktopApi: null,
      desktopInfo: null,
      isDesktop: false,
    });
    useUpdateInventoryMock.mockReturnValue(makeInventory({ machines: [] }));

    renderSection();

    expect(document.querySelector("[data-updates-machine]")).toBeNull();
    expect(screen.queryByText("No machines yet.")).toBeNull();
    expect(screen.getByText("No machines available.")).toBeDefined();
  });
});
