// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderInfo } from "@bb/domain";
import { makeHost, makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsSettingsSectionContent } from "./UsageLimitsSettingsSection";

const primaryHost = makeHost({
  id: "host-primary",
  name: "MacBook Pro",
  lastSeenAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

const remoteHost = makeHost({
  ...primaryHost,
  id: "host-remote",
  name: "Build machine",
});

function provider(
  id: string,
  displayName: string,
  supportsUsage = true,
  strings?: ProviderInfo["strings"],
): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    maintenance: { health: true, usage: supportsUsage, installation: false },
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: false,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
    },
    ...(strings === undefined ? {} : { strings }),
  });
}

const FIRST_PARTY_PROVIDERS: ProviderInfo[] = [
  provider("codex", "Codex", true, {
    signInHint: "Run `codex` to sign in and see your usage.",
    expiredHint: "Your Codex session expired. Run `codex`, then reload usage.",
    installUrl: "https://developers.openai.com/codex/cli",
  }),
  provider("claude-code", "Claude Code", true, {
    signInHint: "Run `claude` to sign in and see your usage.",
    expiredHint:
      "Your Claude session expired. Run `claude`, then reload usage.",
    installUrl: "https://claude.com/claude-code",
  }),
  provider("acp-cursor", "Cursor", true, {
    signInHint: "Run `cursor-agent login` to sign in and see your usage.",
    expiredHint:
      "Your Cursor session expired. Run `cursor-agent login`, then reload usage.",
    installUrl: "https://cursor.com/docs/cli/installation",
  }),
];

afterEach(cleanup);

function renderContent(
  props: ComponentProps<typeof UsageLimitsSettingsSectionContent>,
) {
  return render(
    <TooltipProvider>
      <UsageLimitsSettingsSectionContent
        providers={FIRST_PARTY_PROVIDERS}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("UsageLimitsSettingsSectionContent", () => {
  it("renders Cursor plan and on-demand limits", () => {
    renderContent({
      usage: {
        "acp-cursor": {
          status: "ok",
          accountEmail: "cursor@example.com",
          planLabel: "Pro",
          windows: [
            { label: "Plan usage", usedPercent: 50, resetsAt: null },
            {
              label: "On-demand spend",
              usedPercent: 10,
              resetsAt: null,
              cost: { usedUsdCents: 500, limitUsdCents: 5_000 },
            },
          ],
        },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Cursor" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Cursor" })).toBeDefined();
    expect(screen.getByText("cursor@example.com")).toBeDefined();
    expect(screen.getByText("Plan usage")).toBeDefined();
    expect(screen.getByText("50% used")).toBeDefined();
    expect(screen.getByText("On-demand spend")).toBeDefined();
    expect(screen.getByText("$5.00 / $50")).toBeDefined();
  });

  it("hides an uninstalled provider", () => {
    renderContent({
      usage: {
        codex: { status: "unauthenticated" },
        "acp-cursor": { status: "not_installed" },
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    expect(screen.queryByRole("heading", { name: "Cursor" })).toBeNull();
    expect(screen.queryByText("Not installed on this machine.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeDefined();
  });

  it("keeps states without usage bars with the provider heading", () => {
    renderContent({
      usage: { codex: { status: "unauthenticated" } },
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    const heading = screen.getByRole("heading", { name: "Codex" });
    const status = screen.getByText(/Run `codex` to sign in/u);
    expect(heading.parentElement?.contains(status)).toBe(true);
  });

  it("renders usage reported by a plugin provider", () => {
    renderContent({
      usage: {
        "echo-agent": {
          status: "ok",
          accountEmail: null,
          planLabel: "Team",
          windows: [
            { label: "Monthly messages", usedPercent: 25, resetsAt: null },
          ],
        },
      },
      providers: [provider("echo-agent", "Echo Agent")],
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Echo Agent" })).toBeDefined();
    expect(screen.getByText("Monthly messages")).toBeDefined();
    expect(screen.getByText("25% used")).toBeDefined();
  });

  it("renders supported registry providers in registry order", () => {
    renderContent({
      usage: { codex: { status: "unauthenticated" } },
      providers: [
        provider("echo-agent", "Echo Agent"),
        provider("no-usage", "No Usage", false),
        provider("codex", "Codex from registry"),
      ],
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Echo Agent", "Codex from registry"]);
    expect(screen.queryByRole("heading", { name: "No Usage" })).toBeNull();
    expect(screen.getByText("Usage not provided.")).toBeDefined();
  });

  it("loads supported providers and hides unsupported providers", () => {
    renderContent({
      usage: {},
      providers: [
        provider("codex", "Codex"),
        provider("echo-agent", "Echo Agent", false),
      ],
      isLoading: true,
      isError: false,
      isFetching: true,
      onRefresh: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Codex" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Echo Agent" })).toBeNull();
    expect(screen.getByText("Loading usage…")).toBeDefined();
    expect(screen.queryByText("Usage not provided.")).toBeNull();
  });

  it("renders completed providers while their peers are still loading", () => {
    renderContent({
      usage: { codex: { status: "unauthenticated" } },
      providers: FIRST_PARTY_PROVIDERS.filter(
        (entry) => entry.id === "codex" || entry.id === "claude-code",
      ),
      providerStates: {
        codex: { isError: false, isLoading: false },
        "claude-code": { isError: false, isLoading: true },
      },
      isLoading: true,
      isError: false,
      isFetching: true,
      onRefresh: vi.fn(),
    });

    expect(screen.getByText(/Run `codex` to sign in/u)).toBeDefined();
    const claudeHeading = screen.getByRole("heading", {
      name: "Claude Code",
    });
    const loading = screen.getByText("Loading usage…");
    expect(claudeHeading.parentElement?.contains(loading)).toBe(true);
  });

  it("shows an initial loading message before the provider list arrives", () => {
    renderContent({
      usage: {},
      providers: [],
      isLoading: true,
      isError: false,
      isProviderListLoading: true,
      isFetching: true,
      onRefresh: vi.fn(),
    });

    expect(screen.getByText("Loading providers and usage…")).toBeDefined();
  });

  it("keeps provider rows visible when the usage request fails", () => {
    renderContent({
      usage: {},
      providers: [provider("echo-agent", "Echo Agent")],
      isLoading: false,
      isError: true,
      isFetching: false,
      onRefresh: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Echo Agent" })).toBeDefined();
    expect(screen.getByText(/Couldn't load usage right now/u)).toBeDefined();
  });

  it("selects which connected machine supplies usage", () => {
    const onSelectHost = vi.fn();
    renderContent({
      usage: {},
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
      hosts: [primaryHost, remoteHost],
      selectedHostId: primaryHost.id,
      onSelectHost,
    });

    const sectionHeader = screen
      .getByRole("heading", { name: "Usage limits" })
      .closest("section")?.firstElementChild;
    expect(sectionHeader?.classList.contains("flex-col")).toBe(true);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Usage limits machine" }),
      { button: 0 },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Build machine/u }));

    expect(onSelectHost).toHaveBeenCalledWith(remoteHost.id);
  });

  it("does not show a machine selector when there is only one machine", () => {
    renderContent({
      usage: {},
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: vi.fn(),
      hosts: [primaryHost],
      selectedHostId: primaryHost.id,
      onSelectHost: vi.fn(),
    });

    const sectionHeader = screen
      .getByRole("heading", { name: "Usage limits" })
      .closest("section")?.firstElementChild;
    expect(sectionHeader?.classList.contains("flex-row")).toBe(true);
    expect(sectionHeader?.classList.contains("flex-col")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Usage limits machine" }),
    ).toBeNull();
  });
});

describe("UsageLimitsSettingsSectionContent marks", () => {
  it("draws each provider's declared logo beside its usage block", () => {
    renderContent({
      providers: [
        {
          ...provider("codex", "Codex"),
          logoUrl: "/api/v1/system/providers/codex/logo",
        },
      ],
      usage: {},
      isLoading: false,
      isError: false,
      isFetching: false,
      onRefresh: () => {},
    });
    expect(
      document.querySelector(
        '[data-provider-logo="/api/v1/system/providers/codex/logo"]',
      ),
    ).not.toBeNull();
  });
});
