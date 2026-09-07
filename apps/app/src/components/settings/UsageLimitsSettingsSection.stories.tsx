import { useState, type ReactNode } from "react";
import type { Host, ProviderInfo } from "@bb/domain";
import { makeHost, makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  UsageLimitsSettingsSectionContent,
  type UsageLimitsSettingsSectionContentProps,
} from "./UsageLimitsSettingsSection";

export default {
  title: "settings/Usage Limits",
};

type Usage = UsageLimitsSettingsSectionContentProps["usage"];

const noop = () => {};

function futureIso(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

const HEALTHY_USAGE: Usage = {
  codex: {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Pro",
    windows: [
      {
        label: "Weekly usage limit",
        usedPercent: 8,
        resetsAt: futureIso(5 * 24 * 60),
      },
    ],
  },
  "claude-code": {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Max (20x)",
    windows: [
      {
        label: "Current session",
        usedPercent: 53,
        resetsAt: futureIso(187),
      },
      {
        label: "All models",
        usedPercent: 25,
        resetsAt: futureIso(67),
      },
      {
        label: "Fable",
        usedPercent: 48,
        resetsAt: futureIso(67),
      },
    ],
  },
  "acp-cursor": {
    status: "ok",
    accountEmail: "sawyer@example.com",
    planLabel: "Pro",
    windows: [
      {
        label: "Plan usage",
        usedPercent: 72,
        resetsAt: futureIso(14 * 24 * 60),
      },
      {
        label: "On-demand spend",
        usedPercent: 25,
        resetsAt: futureIso(14 * 24 * 60),
        cost: { usedUsdCents: 1_250, limitUsdCents: 5_000 },
      },
    ],
  },
};

const AUTH_USAGE: Usage = {
  codex: { status: "unauthenticated" },
  "claude-code": { status: "expired" },
  "acp-cursor": { status: "not_installed" },
};

const EMPTY_AND_ERROR_USAGE: Usage = {
  codex: {
    status: "ok",
    accountEmail: null,
    planLabel: "Team",
    windows: [],
  },
  "claude-code": {
    status: "error",
    message: "Claude usage is temporarily unavailable.",
    planLabel: "Max (5x)",
    accountEmail: null,
  },
  "acp-cursor": { status: "not_installed" },
};

const HOSTS: Host[] = [
  makeHost({
    id: "host-macbook",
    name: "MacBook Pro",
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1,
    updatedAt: 2,
  }),
  makeHost({
    id: "host-studio",
    name: "Mac Studio",
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1,
    updatedAt: 2,
  }),
  makeHost({
    id: "host-build",
    name: "Build machine",
    status: "disconnected",
    lastSeenAt: 1_700_000_000_000,
    createdAt: 1,
    updatedAt: 2,
  }),
];

function provider(id: string, displayName: string): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
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
  });
}

const PROVIDERS = [
  provider("codex", "Codex"),
  provider("claude-code", "Claude Code"),
  provider("acp-cursor", "Cursor"),
];

function Stage({ children }: { children: ReactNode }) {
  return <div className="w-full min-w-0 max-w-3xl">{children}</div>;
}

type UsagePreviewProps = Pick<UsageLimitsSettingsSectionContentProps, "usage"> &
  Partial<
    Pick<
      UsageLimitsSettingsSectionContentProps,
      | "hosts"
      | "isError"
      | "isFetching"
      | "isLoading"
      | "onSelectHost"
      | "selectedHostId"
    >
  >;

function UsagePreview({
  usage,
  hosts,
  isError = false,
  isFetching = false,
  isLoading = false,
  onSelectHost,
  selectedHostId,
}: UsagePreviewProps) {
  return (
    <Stage>
      <UsageLimitsSettingsSectionContent
        usage={usage}
        isLoading={isLoading}
        isError={isError}
        isFetching={isFetching}
        onRefresh={noop}
        providers={PROVIDERS}
        hosts={hosts}
        selectedHostId={selectedHostId}
        onSelectHost={onSelectHost}
      />
    </Stage>
  );
}

function MultipleMachinesPreview() {
  const [selectedHostId, setSelectedHostId] = useState(HOSTS[0]?.id ?? null);

  return (
    <UsagePreview
      usage={HEALTHY_USAGE}
      hosts={HOSTS}
      selectedHostId={selectedHostId}
      onSelectHost={setSelectedHostId}
    />
  );
}

export function Usage() {
  return (
    <StoryCard labelWidth="170px">
      <StoryRow
        label="complete usage"
        hint="Provider plans, Claude Fable, and Cursor on-demand spend"
      >
        <UsagePreview usage={HEALTHY_USAGE} />
      </StoryRow>
      <StoryRow
        label="authentication"
        hint="Signed out, expired, and uninstalled providers"
      >
        <UsagePreview usage={AUTH_USAGE} />
      </StoryRow>
      <StoryRow
        label="provider responses"
        hint="An empty plan beside a provider-specific error"
      >
        <UsagePreview usage={EMPTY_AND_ERROR_USAGE} />
      </StoryRow>
      <StoryRow label="loading" hint="Initial request with no cached data">
        <UsagePreview usage={{}} isLoading />
      </StoryRow>
      <StoryRow
        label="request failed"
        hint="The selected machine could not return usage"
      >
        <UsagePreview usage={{}} isError />
      </StoryRow>
      <StoryRow
        label="multiple machines"
        hint="Connected machines are selectable; disconnected ones are disabled"
      >
        <MultipleMachinesPreview />
      </StoryRow>
    </StoryCard>
  );
}
