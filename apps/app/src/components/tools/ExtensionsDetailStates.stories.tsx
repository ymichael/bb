import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillProvider } from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  ResourceActionButton,
  ResourceCreateButton,
  ResourceInstallControl,
  ResourceListState,
  ResourceOverflowMenu,
} from "@bb/shared-ui/resource-list";
import { Switch } from "@bb/shared-ui/switch";
import { AddPluginDialog } from "@/components/plugin/management/AddPluginDialog";
import { PluginDetailReleaseControl } from "@/components/plugin/management/PluginUpdatesCard";
import {
  AutomationLifecycleControl,
  AutomationRunStatusIndicator,
} from "bb-plugin-automations/detail-view";
import { AUTOMATION_CREATE_TEMPLATES } from "bb-plugin-automations/overview-view";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { pluginSourceQueryKey } from "@/hooks/queries/query-keys";
import {
  EMPTY_PLUGIN_UPDATE_STATE,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  CatalogPluginDetail,
  CatalogPluginDetailBanner,
  PluginDetail,
  PluginDetailBanners,
  PluginProvenancePill,
} from "@/components/tools/PluginDetail";
import {
  ProviderLogo,
  SkillProvenanceTooltip,
} from "@/components/tools/SkillsCollection";
import { BbLogo } from "@/components/ui/bb-logo";
import { ProvenancePill } from "@/components/tools/ProvenancePill";
import { SkillDetailView } from "@/components/tools/SkillDetailView";
import {
  makePluginListItem,
  makePluginRegistrationSet,
} from "@/test/fixtures/plugins";

export default {
  title: "Extensions",
};

const noop = () => {};

function PluginStoryQueryBoundary({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnMount: false,
          refetchOnReconnect: false,
          refetchOnWindowFocus: false,
        },
      },
    });
    for (const pluginId of [
      "github",
      "github-official",
      "github-app-surfaces",
      "github-update-available",
      "github-update-failed",
      "github-compatibility-blocked",
      "enterprise-issue-tracker-synchronization",
    ]) {
      client.setQueryData(pluginSourceQueryKey(pluginId), {
        requested: `npm:@bb-plugins/${pluginId}`,
        resolved: "1.4.0",
        integrity: null,
        registry: "npm",
        engines: { bb: null, bbPluginSdk: null },
        installedAt: new Date(2026, 6, 8).getTime(),
        history: [],
      });
    }
    return client;
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function Story({
  title,
  description,
  renderedLabel = "Rendered page",
  renderedNote = "The real component",
  children,
}: {
  title: string;
  description: string;
  renderedLabel?: string;
  renderedNote?: string;
  children: ReactNode;
}) {
  return (
    <main
      className="mx-auto w-full max-w-[72rem] space-y-4 px-5 py-6"
      style={{ "--story-doc-width": "232px" } as CSSProperties}
    >
      <header>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {description}
        </p>
      </header>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
        <div className="grid grid-cols-[var(--story-doc-width)_minmax(0,1fr)] max-[900px]:hidden">
          <span className="flex flex-col border-r border-border bg-surface-recessed px-4 py-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              State
            </span>
            <span className="text-2xs text-subtle-foreground">
              When it happens
            </span>
          </span>
          <span className="flex flex-col px-4 py-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {renderedLabel}
            </span>
            <span className="text-2xs text-subtle-foreground">
              {renderedNote}
            </span>
          </span>
        </div>
        {children}
      </div>
    </main>
  );
}

function State({
  name,
  note,
  children,
}: {
  name: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[var(--story-doc-width)_minmax(0,1fr)] items-start max-[900px]:grid-cols-1">
      <div className="h-full border-r border-border bg-surface-recessed max-[900px]:border-b max-[900px]:border-r-0">
        <div className="sticky top-0 px-4 py-4">
          <h2 className="text-sm font-medium text-foreground">{name}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {note}
          </p>
        </div>
      </div>
      <div className="min-w-0 px-5 py-5">{children}</div>
    </section>
  );
}

const SKILL_PATH = "/Users/you/.bb/skills/writing-voice/SKILL.md";

function SkillLeading({ provider }: { provider: SkillProvider | null }) {
  if (provider === null) {
    return <BbLogo />;
  }
  return <ProviderLogo providerId={provider} className="size-4" />;
}

function Skill({
  files = [SKILL_PATH],
  contentState = {
    kind: "ready" as const,
    content:
      "# writing-voice\n\nLead with the answer. Cut hedging. Prefer short sentences.",
  },
  titleBadge,
  headerActions,
  provider = null,
}: {
  files?: readonly string[];
  contentState?: Parameters<typeof SkillDetailView>[0]["contentState"];
  titleBadge?: Parameters<typeof SkillDetailView>[0]["titleBadge"];
  headerActions?: Parameters<typeof SkillDetailView>[0]["headerActions"];
  provider?: SkillProvider | null;
}) {
  return (
    <SkillDetailView
      leading={<SkillLeading provider={provider} />}
      title="writing-voice"
      path={SKILL_PATH}
      files={files}
      selectedPath={files[0] ?? SKILL_PATH}
      onSelectFile={noop}
      contentState={contentState}
      titleBadge={titleBadge}
      headerActions={headerActions}
    />
  );
}

export function SkillDetailStates() {
  return (
    <Story
      title="Skill detail states"
      description="A skill page is Files (only when there is more than one) then Definition. Everything else is a state of those two sections or of the route around them."
    >
      <State
        name="Single file"
        note="The common case: one SKILL.md, so no Files section is rendered."
      >
        <Skill />
      </State>

      <State
        name="Multiple files"
        note="Files appears above Definition and never below it."
      >
        <Skill
          files={[SKILL_PATH, "/Users/you/.bb/skills/writing-voice/tone.md"]}
        />
      </State>

      <State
        name="Provider-owned"
        note="A skill discovered under Claude Code or Codex carries that provider's logo where a bb-owned skill carries the bb mark."
      >
        <Skill provider="claude-code" />
      </State>

      <State
        name="Content loading"
        note="The selected file is still being read. The page keeps its shape."
      >
        <Skill contentState={{ kind: "loading" }} />
      </State>

      <State
        name="Content failed"
        note="Explains what failed and offers a specific retry inside the affected section. The copy stays neutral; the red icon carries failure severity."
      >
        <Skill
          contentState={{
            kind: "error",
            message: "Couldn't read SKILL.md.",
            onRetry: noop,
          }}
        />
      </State>

      <State
        name="BB Official"
        note="A skill that ships with bb uses the same publisher badge as a BB Official plugin. Its read-only behavior remains a separate permission fact."
      >
        <Skill
          titleBadge={{
            label: "BB Official",
            tooltip: "Ships with bb",
          }}
        />
      </State>

      <State
        name="Included"
        note="A skill supplied by another plugin names that dependency without implying that the skill was acquired separately."
      >
        <Skill
          titleBadge={{
            label: "Included",
            tooltip: (
              <SkillProvenanceTooltip
                prefix="Included with"
                providerId={null}
                name="GitHub plugin"
              />
            ),
          }}
        />
      </State>

      <State
        name="Imported"
        note="Ownership is passive: a skill bb cannot write shows its origin as a status, with no edit or acquisition control."
      >
        <Skill
          provider="claude-code"
          titleBadge={{
            label: "Imported",
            tooltip: (
              <SkillProvenanceTooltip
                prefix="Discovered from"
                providerId="claude-code"
                name="Claude Code"
              />
            ),
          }}
        />
      </State>

      <State
        name="Before ownership"
        note="A registry skill has no ownership badge. Fork is the acquisition action at the trailing edge of the detail header."
      >
        <Skill
          headerActions={
            <ResourceInstallControl
              accessibleLabel="Fork writing-voice into a new bb skill"
              label="Fork"
              icon="Fork"
              onAction={noop}
            />
          }
        />
      </State>

      <State
        name="Route loading"
        note="Before the skill itself resolves. Shares one treatment with plugins and automations."
      >
        <ResourceListState
          state="loading"
          message="Loading skill"
          layout="detail"
        />
      </State>

      <State name="Route not found" note="The skill does not exist locally.">
        <ResourceListState
          state="empty"
          message="Skill not found."
          layout="detail"
        />
      </State>

      <State
        name="Source unavailable"
        note="Deliberately distinct from not-found: the skill exists, its external source does not."
      >
        <ResourceListState
          state="error"
          message="This registry skill is no longer available from its source."
          layout="detail"
          onRetry={noop}
        />
      </State>
    </Story>
  );
}

const PLUGIN: PluginListItem = makePluginListItem({
  id: "github",
  source: "npm:@bb-plugins/github",
  rootDir: "/Users/you/.bb/plugins/github",
  version: "1.4.0",
  description: "Browse GitHub issues and pull requests without leaving bb.",
  name: "GitHub",
  icon: "Github",
  sourceDisplay: "npm · @bb-plugins/github",
});

const NEXT_RUN_AT = new Date(2027, 0, 15, 9).getTime();

const STATIC_CAPABILITIES: PluginListItem["capabilities"] = [
  {
    kind: "skill",
    id: "skills",
    label: "skills",
    detail: "Skills bundled with this plugin",
  },
  {
    kind: "theme",
    id: "github.dark",
    label: "GitHub Dark",
    detail: "A dark palette matching github.com",
  },
];

const FULL_PLUGIN: PluginListItem = {
  ...PLUGIN,
  cliCommand: { name: "gh", summary: "Work with GitHub from the terminal" },
  services: [
    { name: "issue-sync", state: "running" },
    { name: "webhook-listener", state: "backoff" },
    { name: "indexer", state: "stopped" },
  ],
  schedules: [
    {
      name: "daily-digest",
      cron: "0 9 * * *",
      nextRunAt: NEXT_RUN_AT,
      lastRunAt: null,
      lastStatus: "ok",
      lastError: null,
    },
    {
      name: "stale-sweep",
      cron: "0 3 * * 0",
      nextRunAt: NEXT_RUN_AT,
      lastRunAt: null,
      lastStatus: "error",
      lastError: "GitHub API rate limit exceeded",
    },
  ],
  capabilities: [
    ...STATIC_CAPABILITIES,
    {
      kind: "agent-tool",
      id: "gh_search",
      label: "gh_search",
      detail: "Search issues and pull requests",
    },
    {
      kind: "thread-integration",
      id: "mention:pr",
      label: "Pull requests",
      detail: "Mentions with #",
    },
  ],
};

const APP_SURFACE_PLUGIN = {
  ...PLUGIN,
  id: "github-app-surfaces",
  app: { hasApp: true, bundle: null },
} satisfies PluginListItem;

const AWKWARD_PLUGIN: PluginListItem = {
  ...FULL_PLUGIN,
  id: "enterprise-issue-tracker-synchronization",
  name: "Enterprise Issue Tracker Synchronization",
  rootDir:
    "/Users/you/.bb/plugins/enterprise-issue-tracker-synchronization/packages/runtime",
  description:
    "Keeps issues, pull requests, review comments, and release checklists synchronized between bb threads and your issue tracker, including bidirectional status mapping, attachment mirroring, and per-project field translation.",
  cliCommand: {
    name: "enterprise-issue-tracker-sync",
    summary:
      "Synchronize issues, pull requests, and release checklists in both directions",
  },
  capabilities: [
    ...FULL_PLUGIN.capabilities,
    {
      kind: "agent-tool",
      id: "enterprise_issue_tracker_bulk_transition",
      label: "enterprise_issue_tracker_bulk_transition",
      detail:
        "Transition many issues at once, respecting per-project workflow rules and required fields",
    },
    {
      kind: "thread-integration",
      id: "mention:release-checklist",
      label: "Release checklists",
      detail: "Mentions with @ and #",
    },
  ],
};

const UPDATE_AVAILABLE_PLUGIN: PluginListItem = {
  ...PLUGIN,
  id: "github-update-available",
  updateState: {
    ...EMPTY_PLUGIN_UPDATE_STATE,
    availableVersion: "1.5.0",
    lastCheckAt: new Date(2026, 6, 20).getTime(),
  },
};

const UPDATE_FAILED_PLUGIN: PluginListItem = {
  ...PLUGIN,
  id: "github-update-failed",
  updateState: {
    ...EMPTY_PLUGIN_UPDATE_STATE,
    availableVersion: "1.5.0",
    lastFailure: {
      version: "1.5.0",
      at: new Date(2026, 6, 22).getTime(),
      detail: "The plugin failed to load after the update.",
    },
  },
};

const BUNDLED_PLUGIN: PluginListItem = {
  ...PLUGIN,
  id: "github-bundled",
  source: "builtin:github",
  rootDir: "/managed/plugins/github",
  provenance: "builtin",
  sourceDisplay: "Ships with bb",
  capabilities: STATIC_CAPABILITIES,
};

const UNINSTALLED_CATALOG_PLUGIN = {
  entryId: "github",
  marketplace: "bb-official",
  pluginId: "github",
  displayName: "GitHub",
  description: "Browse GitHub issues and pull requests without leaving bb.",
  icon: "Github",
  iconUrl: null,
  iconTinted: false,
  category: "Developer tools",
  screenshots: [],
  collections: [],
  source: "builtin:github",
  repositoryUrl: null,
  marketplaceDisplayName: "BB Official",
  publisherKey: "bb-official",
  publisherLabel: "BB Official",
  official: true,
  author: null,
  installed: false,
  installs: null,
  compatible: true,
  incompatibleReason: null,
} satisfies PluginCatalogSearchEntry;

const COMPATIBILITY_BLOCKED_PLUGIN: PluginListItem = {
  ...PLUGIN,
  id: "github-compatibility-blocked",
  updateState: {
    ...EMPTY_PLUGIN_UPDATE_STATE,
    blockedVersion: "2.0.0",
    blockedReasons: ["Requires bb 0.20 or newer, and this bb is 0.18."],
  },
};

function FailedReleaseLifecycle() {
  const [plugin, setPlugin] = useState(UPDATE_FAILED_PLUGIN);

  useEffect(() => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.endsWith(`/plugins/${UPDATE_FAILED_PLUGIN.id}/update`)) {
        return originalFetch.call(globalThis, input, init);
      }

      await new Promise((resolve) => window.setTimeout(resolve, 8_000));
      if (!cancelled) {
        setPlugin((current) => ({
          ...current,
          version: "1.5.0",
          updateState: {
            ...EMPTY_PLUGIN_UPDATE_STATE,
            outcome: "current",
            lastCheckAt: Date.now(),
          },
        }));
      }
      return new Response(
        JSON.stringify({
          applied: true,
          from: { version: "1.4.0", display: "1.4.0" },
          to: { version: "1.5.0", display: "1.5.0" },
          outcome: "updated",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    return () => {
      cancelled = true;
      globalThis.fetch = originalFetch;
    };
  }, []);

  return <Plugin plugin={plugin} />;
}

function Plugin({
  plugin,
  isLoading = false,
}: {
  plugin: PluginListItem | null;
  isLoading?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      {plugin === null ? null : (
        <div className="-mx-4 md:-mx-5">
          <PluginDetailBanners plugin={plugin} />
        </div>
      )}
      <div className="pt-3 md:pt-4">
        <PluginDetail
          isLoading={isLoading}
          plugin={plugin}
          pending={false}
          openSourceDisabled
          onToggle={noop}
          onEdit={noop}
          onOpenSource={noop}
          onDelete={noop}
          catalogEntries={[]}
          onOpenPlugin={noop}
        />
      </div>
    </div>
  );
}

function CatalogPlugin({
  entry = UNINSTALLED_CATALOG_PLUGIN,
}: {
  entry?: PluginCatalogSearchEntry;
}) {
  const [installOpen, setInstallOpen] = useState(false);
  return (
    <>
      <div className="-mx-4 md:-mx-5">
        <CatalogPluginDetailBanner entry={entry} />
      </div>
      <div className="pt-3 md:pt-4">
        <CatalogPluginDetail
          entry={entry}
          onInstall={() => setInstallOpen(true)}
          catalogEntries={[entry]}
          onOpenPlugin={noop}
        />
      </div>
      <AddPluginDialog
        open={installOpen}
        initial={{
          entryId: entry.entryId,
          pluginId: entry.pluginId,
          marketplace: "bb-official",
          publisherLabel: "BB Official",
          displayName: entry.displayName,
          icon: entry.icon,
          iconUrl: entry.iconUrl,
          iconTinted: entry.iconTinted,
          source: entry.source,
        }}
        onOpenChange={setInstallOpen}
      />
    </>
  );
}

function PluginWithAppSurfaces() {
  useEffect(() => {
    setPluginSlotRegistrations(
      APP_SURFACE_PLUGIN.id,
      makePluginRegistrationSet({
        navPanels: [
          {
            id: "issues",
            title: "Issues",
            icon: "Github",
            path: "issues",
            component: () => null,
          },
        ],
        threadPanelActions: [
          {
            id: "open-pr",
            title: "Open pull request",
            icon: "GitPullRequest",
            component: () => null,
          },
        ],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    return () => removePluginSlotRegistrations(APP_SURFACE_PLUGIN.id);
  }, []);
  return <Plugin plugin={APP_SURFACE_PLUGIN} />;
}

export function PluginDetailStates() {
  return (
    <PluginStoryQueryBoundary>
      <Story
        title="Plugin detail states"
        description="An uninstalled BB Official plugin shows the catalog facts bb can verify and offers Install. Once installed, the page adds runtime capabilities, settings, services, and schedules when they apply."
      >
        <State
          name="Before ownership"
          note="An uninstalled BB Official plugin opens as a real detail page. Install is the primary header action; the full-trust confirmation is the commit step."
        >
          <CatalogPlugin />
        </State>

        <State
          name="Before ownership · incompatible"
          note="The same page keeps Install visible but disabled. Its acquisition blocker uses the same full-width notice alignment as installed-plugin conditions, while the copy keeps the taxonomy clear."
        >
          <CatalogPlugin
            entry={{
              ...UNINSTALLED_CATALOG_PLUGIN,
              compatible: false,
              incompatibleReason: "Requires bb 0.20 or newer.",
            }}
          />
        </State>

        <State
          name="Full"
          note="Capabilities names what the plugin adds. Background services use a conventional Status/Service table; scheduled jobs use a separate table for next-run and failure detail."
        >
          <Plugin plugin={FULL_PLUGIN} />
        </State>

        <State
          name="Minimal"
          note="Nothing user-facing is declared, so Capabilities says so rather than vanishing, and neither activity section renders."
        >
          <Plugin plugin={PLUGIN} />
        </State>

        <State
          name="Disabled"
          note="Manifest-declared skills and themes stay accurate; the live capabilities are deferred honestly."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              enabled: false,
              status: "disabled",
              capabilities: STATIC_CAPABILITIES,
            }}
          />
        </State>

        <State
          name="Unhealthy"
          note="Runtime health is the primary banner. It explains the user-facing condition and recovery without exposing the service identifier or unrelated cumulative handler failures."
        >
          <Plugin
            plugin={{
              ...FULL_PLUGIN,
              status: "degraded",
              statusDetail: "service issue-sync did not stop",
              handlerStats: {
                count: 12,
                totalMs: 340,
                maxMs: 90,
                errorCount: 3,
              },
            }}
          />
        </State>

        <State
          name="App surfaces"
          note="Surfaces a plugin frontend registers in the browser once it loads. They enrich Capabilities; the manifest alone cannot name them."
        >
          <PluginWithAppSurfaces />
        </State>

        <State
          name="Awkward content"
          note="Long unbroken names, a wordy description, and every capability group at once. Real plugins are messier than fixtures; this is where wrapping and truncation break."
        >
          <Plugin plugin={AWKWARD_PLUGIN} />
        </State>

        <State
          name="BB Official · catalog"
          note="Installed from bb's catalog. It shares the BB Official badge with built-in plugins, while its install date and ownership menu preserve the lifecycle difference."
        >
          <Plugin plugin={CATALOG_PLUGIN} />
        </State>

        <State
          name="BB Official · built-in"
          note="Ships with bb. The badge matches catalog-installed official plugins; the missing install date and ownership menu show that it cannot be uninstalled separately."
        >
          <Plugin plugin={BUNDLED_PLUGIN} />
        </State>

        <State
          name="Update available"
          note="Identity and path use the standard detail header. Installed date and current version remain passive table facts; the compact Update action sits in the Release section header, separate from activation and ownership."
        >
          <Plugin plugin={UPDATE_AVAILABLE_PLUGIN} />
        </State>

        <State
          name="Update failed"
          note="The current version is still running after rollback. A dedicated Update row explains what was restored; Retry remains the primary Release action above the table."
        >
          <Plugin plugin={UPDATE_FAILED_PLUGIN} />
        </State>

        <State
          name="Compatibility blocked"
          note="A newer release requires a newer bb. A dedicated Update row explains the requirement and preserved version; there is no unavailable action or modal."
        >
          <Plugin plugin={COMPATIBILITY_BLOCKED_PLUGIN} />
        </State>

        <State name="Route loading" note="Before the plugin list resolves.">
          <Plugin plugin={null} isLoading />
        </State>

        <State
          name="Route not found"
          note="No plugin with this id is installed."
        >
          <ResourceListState
            state="empty"
            message="Plugin not found."
            layout="detail"
          />
        </State>

        <State
          name="Route failed"
          note="The list request failed; retry is the only useful action."
        >
          <ResourceListState
            state="error"
            message="Couldn't load plugin."
            layout="detail"
            onRetry={noop}
          />
        </State>
      </Story>
    </PluginStoryQueryBoundary>
  );
}

export function PluginBannerStates() {
  return (
    <PluginStoryQueryBoundary>
      <Story
        title="Plugin health banners"
        description="Each present-tense runtime condition appears in its production position on the real plugin detail page: a full-width banner above the plugin identity and content it affects."
        renderedLabel="Rendered detail page"
        renderedNote="The real health banner above the plugin page"
      >
        <State
          name="Health · Failed"
          note="The plugin runtime or browser interface could not start. The banner gives Reload recovery without exposing the underlying process error."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              status: "error",
              statusDetail: "worker process exited unexpectedly",
            }}
          />
        </State>

        <State
          name="Health · Degraded"
          note="The plugin still runs while a background service finishes stopping. The banner gives the supported wait-and-reload recovery; service identifiers and cumulative handler failures remain diagnostic data."
        >
          <Plugin
            plugin={{
              ...FULL_PLUGIN,
              status: "degraded",
              statusDetail: "service issue-sync did not stop",
              handlerStats: {
                count: 12,
                totalMs: 340,
                maxMs: 90,
                errorCount: 3,
              },
            }}
          />
        </State>

        <State
          name="Health · Incompatible"
          note="The installed plugin cannot run with this version of bb. The banner directs the user to install a compatible version without repeating the server's raw compatibility string."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              status: "incompatible",
              statusDetail: "requires bb 0.20 or newer",
            }}
          />
        </State>

        <State
          name="Health · Missing"
          note="The installed entry remains, but its plugin files are missing. The banner gives the source-appropriate remove-and-reinstall resolution."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              status: "missing",
              statusDetail: "plugin directory was not found",
            }}
          />
        </State>

        <State
          name="Health · Needs configuration"
          note="Required settings are incomplete. Saving Settings reloads the plugin, so the banner adds no duplicate action."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              status: "needs-configuration",
              statusDetail: "an API token is required",
              hasSettings: true,
            }}
          />
        </State>

        <State
          name="Health · Needs configuration · external"
          note="The required value lives outside the Settings section. The plugin-authored message names it, and Reload becomes the supported action after the user adds it."
        >
          <Plugin
            plugin={{
              ...PLUGIN,
              status: "needs-configuration",
              statusDetail: "Set GITHUB_TOKEN in the server environment.",
              hasSettings: false,
            }}
          />
        </State>
      </Story>
    </PluginStoryQueryBoundary>
  );
}

export function PluginReleaseStates() {
  return (
    <PluginStoryQueryBoundary>
      <Story
        title="Plugin release states"
        description="Release actions stay beside the section label. A dedicated Update row appears only when a release is available, failed, or blocked; successful updates return to the normal release state after a transient confirmation."
        renderedLabel="Rendered detail page"
        renderedNote="The real Release section below plugin identity"
      >
        <State
          name="Release · normal"
          note="No update action or outcome is present. Release contains only the installed date and current version."
        >
          <Plugin plugin={PLUGIN} />
        </State>

        <State
          name="Release · update available"
          note="The Update row names the available version while the optional action stays in the Release section header and opens confirmation before changing anything."
        >
          <Plugin plugin={UPDATE_AVAILABLE_PLUGIN} />
        </State>

        <State
          name="Release · failed / retry / updating / completed"
          note="The Update row explains the rollback while Retry stays beside Release. Click Retry to inspect the real pending action for 8 seconds; success advances Version to 1.5.0, removes the stale Update row, and shows the production completion toast."
        >
          <FailedReleaseLifecycle />
        </State>

        <State
          name="Release · update blocked"
          note="Not a banner and not a failed attempt. The Update row names the bb-version requirement and preserved installed version; there is no unavailable action or dialog to dismiss."
        >
          <Plugin plugin={COMPATIBILITY_BLOCKED_PLUGIN} />
        </State>
      </Story>
    </PluginStoryQueryBoundary>
  );
}

function NoControl({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs italic text-subtle-foreground">{children}</span>
  );
}

function ControlTable({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="max-w-full overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <thead className="bg-surface-recessed/55 text-xs text-muted-foreground">
            <tr>
              <th className="w-48 px-3 py-2 text-left font-medium">State</th>
              <th className="w-64 px-3 py-2 text-left font-medium">
                Rendered control
              </th>
              <th className="px-3 py-2 text-left font-medium">Meaning</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">{children}</tbody>
        </table>
      </div>
    </section>
  );
}

function ControlRow({
  state,
  control,
  meaning,
}: {
  state: string;
  control: ReactNode;
  meaning: ReactNode;
}) {
  return (
    <tr>
      <th className="px-3 py-2.5 text-left align-top text-xs font-medium text-foreground">
        {state}
      </th>
      <td className="px-3 py-2.5 text-left align-top">
        <div className="flex min-h-7 items-start justify-start">{control}</div>
      </td>
      <td className="px-3 py-2.5 text-left align-top text-xs leading-relaxed text-muted-foreground">
        {meaning}
      </td>
    </tr>
  );
}

const CATALOG_PLUGIN = {
  ...PLUGIN,
  id: "github-official",
  provenance: "catalog",
  catalogEntryId: "github",
  publisherLabel: "BB Community",
} satisfies PluginListItem;

const pluginUninstallItems = [
  {
    label: "Uninstall",
    icon: "Trash2" as const,
    tone: "destructive" as const,
    onSelect: noop,
  },
];

const pluginCatalogItems = [
  {
    label: "Uninstall",
    icon: "Trash2" as const,
    tone: "destructive" as const,
    onSelect: noop,
  },
];

const pluginLocalItems = [
  { label: "Edit", icon: "Edit" as const, onSelect: noop },
  { label: "Open source", icon: "ExternalLink" as const, onSelect: noop },
  {
    label: "Remove from bb",
    icon: "Trash2" as const,
    tone: "destructive" as const,
    onSelect: noop,
  },
];

const skillLocalItems = [
  { label: "Edit", icon: "Edit" as const, onSelect: noop },
  { label: "Open source", icon: "ExternalLink" as const, onSelect: noop },
  { kind: "separator" as const },
  {
    label: "Delete",
    icon: "Trash2" as const,
    tone: "destructive" as const,
    onSelect: noop,
  },
];

const automationMenuItems = [
  { label: "Run now", icon: "Play" as const, onSelect: noop },
  { kind: "separator" as const },
  {
    label: "Delete",
    icon: "Trash2" as const,
    tone: "destructive" as const,
    onSelect: noop,
  },
];

export function ResourceControlStates() {
  return (
    <PluginStoryQueryBoundary>
      <main className="mx-auto w-full max-w-[72rem] space-y-8 px-5 py-6">
        <header>
          <h1 className="text-lg font-semibold text-foreground">
            Resource badge and button states
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            The real controls used by Automations, Plugins, and Skills, grouped
            by the meaning they carry. Cells are deliberately left-aligned so
            shape, weight, and vocabulary can be compared directly.
          </p>
        </header>

        <ControlTable
          title="Before ownership"
          description="Install and Fork are sibling acquisition actions. They share one control shape; their verbs describe what ownership means for each resource."
        >
          <ControlRow
            state="Plugin · Install"
            control={
              <ResourceInstallControl
                accessibleLabel="Install example plugin"
                onAction={noop}
              />
            }
            meaning="Canonical BB Official plugin acquisition action on both Browse and the pre-ownership detail page."
          />
          <ControlRow
            state="Plugin · installing"
            control={
              <ResourceInstallControl
                accessibleLabel="Install example plugin"
                pending
                onAction={noop}
              />
            }
            meaning="The same acquisition action while installation is in flight."
          />
          <ControlRow
            state="Skill · Fork"
            control={
              <ResourceInstallControl
                accessibleLabel="Fork example skill into a new bb skill"
                label="Fork"
                icon="Fork"
                onAction={noop}
              />
            }
            meaning="Creates a new bb-owned skill from a registry source on the skill detail page."
          />
          <ControlRow
            state="Skill · forking"
            control={
              <ResourceInstallControl
                accessibleLabel="Fork example skill into a new bb skill"
                label="Fork"
                icon="Fork"
                pending
                pendingLabel="Forking"
                onAction={noop}
              />
            }
            meaning="The sibling skill acquisition action while the fork is in flight."
          />
        </ControlTable>

        <ControlTable
          title="Owned detail-page badges"
          description="Badges appear only when provenance changes how the resource should be understood. Ordinary owned resources stay unlabelled in their detail-page stories."
        >
          <ControlRow
            state="Plugin · BB Official catalog"
            control={<PluginProvenancePill plugin={CATALOG_PLUGIN} />}
            meaning="Published by bb and installed from the catalog."
          />
          <ControlRow
            state="Plugin · BB Official built-in"
            control={<PluginProvenancePill plugin={BUNDLED_PLUGIN} />}
            meaning="Ships with bb. The same badge communicates publisher; lifecycle differences remain in metadata and actions."
          />
          <ControlRow
            state="Skill · BB Official"
            control={
              <ProvenancePill label="BB Official" tooltip="Ships with bb" />
            }
            meaning="A skill that ships with bb."
          />
          <ControlRow
            state="Skill · Included"
            control={
              <ProvenancePill
                label="Included"
                tooltip={
                  <SkillProvenanceTooltip
                    prefix="Included with"
                    providerId="claude-code"
                    name="GitHub plugin"
                  />
                }
              />
            }
            meaning="A skill bundled inside another plugin."
          />
          <ControlRow
            state="Skill · Imported"
            control={
              <ProvenancePill
                label="Imported"
                tooltip={
                  <SkillProvenanceTooltip
                    prefix="Discovered from"
                    providerId="claude-code"
                    name="Claude Code"
                  />
                }
              />
            }
            meaning="A skill discovered from another provider."
          />
        </ControlTable>

        <ControlTable
          title="Plugin lifecycle and ownership actions"
          description="The provenance badge never doubles as a control. Runtime lifecycle and destructive ownership actions remain separate."
        >
          <ControlRow
            state="Enabled"
            control={
              <Switch
                checked
                aria-label="Disable example plugin"
                onCheckedChange={noop}
              />
            }
            meaning="The plugin runtime is enabled."
          />
          <ControlRow
            state="Disabled"
            control={
              <Switch
                checked={false}
                aria-label="Enable example plugin"
                onCheckedChange={noop}
              />
            }
            meaning="The plugin remains installed but its runtime is disabled."
          />
          <ControlRow
            state="Lifecycle pending"
            control={
              <Switch
                checked
                disabled
                aria-label="Plugin update pending"
                onCheckedChange={noop}
              />
            }
            meaning="A plugin mutation is in flight, so the lifecycle switch cannot race it."
          />
          <ControlRow
            state="Direct installed actions"
            control={
              <ResourceOverflowMenu
                label="Direct plugin actions"
                items={pluginUninstallItems}
              />
            }
            meaning="Direct installs can be submitted to the marketplace or uninstalled."
          />
          <ControlRow
            state="Catalog installed actions"
            control={
              <ResourceOverflowMenu
                label="Catalog plugin actions"
                items={pluginCatalogItems}
              />
            }
            meaning="Official catalog installs are already published, so their ownership menu only offers uninstall."
          />
          <ControlRow
            state="Local actions"
            control={
              <ResourceOverflowMenu
                label="Local plugin actions"
                items={pluginLocalItems}
              />
            }
            meaning="Local sources can be edited, opened, submitted to the marketplace, or removed from bb without deleting the source directory."
          />
          <ControlRow
            state="BB Official built-in actions"
            control={<NoControl>No ownership menu</NoControl>}
            meaning="Built-in plugins cannot be uninstalled or source-edited here."
          />
        </ControlTable>

        <ControlTable
          title="Plugin release actions"
          description="Update and Retry are primary Release actions. Their context stays with Version; a blocked update has no unavailable action. The complete flow is demonstrated in Plugin release states."
        >
          <ControlRow
            state="Update available"
            control={
              <PluginDetailReleaseControl plugin={UPDATE_AVAILABLE_PLUGIN} />
            }
            meaning="A compatible release is available; no warning or failure has occurred."
          />
          <ControlRow
            state="Retry update"
            control={
              <PluginDetailReleaseControl plugin={UPDATE_FAILED_PLUGIN} />
            }
            meaning="The last attempt rolled back; the compatible update remains available to retry."
          />
        </ControlTable>

        <ControlTable
          title="Skill ownership actions"
          description="Only mutable local skills expose ownership actions; provenance badges remain passive."
        >
          <ControlRow
            state="Fork · browse card"
            control={
              <ResourceInstallControl
                accessibleLabel="Fork example skill into a new bb skill"
                label="Fork"
                icon="Fork"
                presentation="icon"
                tooltip="Fork example skill"
                onAction={noop}
              />
            }
            meaning="The same action in the compact card-header presentation."
          />
          <ControlRow
            state="Local actions"
            control={
              <ResourceOverflowMenu
                label="Local skill actions"
                items={skillLocalItems}
              />
            }
            meaning="A bb-owned skill can be edited, opened, or deleted."
          />
          <ControlRow
            state="Read-only actions"
            control={<NoControl>No ownership menu</NoControl>}
            meaning="BB Official, Included, and Imported skills expose provenance without pretending they are mutable."
          />
        </ControlTable>

        <ControlTable
          title="Automations"
          description="Lifecycle is the primary control. Creation, editing, run status, and ownership actions remain visually distinct."
        >
          <ControlRow
            state="Active"
            control={
              <AutomationLifecycleControl
                checked
                label="Pause automation"
                onCheckedChange={noop}
              />
            }
            meaning="A recurring or future one-time automation is enabled."
          />
          <ControlRow
            state="Paused"
            control={
              <AutomationLifecycleControl
                checked={false}
                label="Resume automation"
                onCheckedChange={noop}
              />
            }
            meaning="The automation is retained but will not run."
          />
          <ControlRow
            state="Lifecycle pending"
            control={
              <AutomationLifecycleControl
                checked
                disabled
                label="Pause automation"
                onCheckedChange={noop}
              />
            }
            meaning="An automation mutation is in flight."
          />
          <ControlRow
            state="Completed one-time"
            control={
              <AutomationLifecycleControl
                checked={false}
                disabled
                disabledReason="This one-time automation has completed. Edit it to schedule another run."
                label="Completed automation"
                onCheckedChange={noop}
              />
            }
            meaning="The schedule is terminal; focus or hover the disabled switch for the reason."
          />
          <ControlRow
            state="Expired one-time"
            control={
              <AutomationLifecycleControl
                checked={false}
                disabled
                disabledReason="This one-time automation expired. Edit it to schedule another run."
                label="Expired automation"
                onCheckedChange={noop}
              />
            }
            meaning="The scheduled time passed without a completed run."
          />
          {(["succeeded", "failed", "running", "skipped"] as const).map(
            (status) => (
              <ControlRow
                key={status}
                state={`Run · ${status}`}
                control={
                  <AutomationRunStatusIndicator status={status} showLabel />
                }
                meaning="Persisted run status used in automation history."
              />
            ),
          )}
          <ControlRow
            state="Create"
            control={
              <ResourceCreateButton
                label="New automation"
                templates={AUTOMATION_CREATE_TEMPLATES}
                onCreate={noop}
              />
            }
            meaning="Starts a blank chat-authored automation or opens the example menu."
          />
          <ControlRow
            state="Edit"
            control={
              <ResourceActionButton
                label="Edit with chat"
                tooltipLabel="Edit with chat"
                icon="Edit"
                onClick={noop}
              />
            }
            meaning="Contextual action attached to the Prompt or Script section."
          />
          <ControlRow
            state="Edit loading"
            control={
              <ResourceActionButton
                label="Editing with chat"
                tooltipLabel="Editing with chat"
                icon="Edit"
                loading
                onClick={noop}
              />
            }
            meaning="The section action is in flight."
          />
          <ControlRow
            state="Edit unavailable"
            control={
              <ResourceActionButton
                label="Edit with chat"
                icon="Edit"
                disabled
                disabledReason="No writable automation source"
                onClick={noop}
              />
            }
            meaning="The action remains discoverable and explains why it cannot run."
          />
          <ControlRow
            state="Actions"
            control={
              <ResourceOverflowMenu
                label="Automation actions"
                items={automationMenuItems}
              />
            }
            meaning="Run now and Delete live in the automation ownership menu."
          />
          <ControlRow
            state="Actions pending"
            control={
              <ResourceOverflowMenu
                label="Automation actions pending"
                disabled
                items={automationMenuItems}
              />
            }
            meaning="The menu is disabled while another automation action is pending."
          />
          <ControlRow
            state="Run now"
            control={
              <Button type="button" variant="outline" size="sm" onClick={noop}>
                <Icon name="Play" className="size-3.5" aria-hidden />
                Run now
              </Button>
            }
            meaning="The empty Runs state offers the manual action inline."
          />
          <ControlRow
            state="Run now pending"
            control={
              <Button type="button" variant="outline" size="sm" disabled>
                <Icon name="Play" className="size-3.5" aria-hidden />
                Run now
              </Button>
            }
            meaning="Manual execution is unavailable while another action is pending."
          />
        </ControlTable>
      </main>
    </PluginStoryQueryBoundary>
  );
}
