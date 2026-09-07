import { useSyncExternalStore } from "react";
import {
  ResourceActivitySection,
  ResourceDetailConfigurationSection,
  ResourceDetailPage,
  ResourceDetailReleaseSection,
  ResourceDetailStack,
  ResourceInstallControl,
  ResourceListState,
  ResourceOverflowMenu,
  type ResourceOverflowMenuItem,
} from "@bb/shared-ui/resource-list";
import { Switch } from "@bb/shared-ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { formatHomePathForDisplay } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { Link } from "react-router-dom";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";
import { CheckPluginUpdatesButton } from "@/components/plugin/management/CheckPluginUpdatesButton";
import {
  PluginDetailReleaseControl,
  PluginDetailReleaseStatus,
  pluginHasUpdateSurfaces,
} from "@/components/plugin/management/PluginUpdatesCard";
import {
  CatalogEntryIconChip,
  formatAbsoluteDate,
  formatPluginInstallCount,
  PluginLogo,
} from "@/components/plugin/management/plugin-ui";
import {
  PluginMarketplaceCategoryPill,
  PluginMarketplaceHeaderMetadata,
  PluginMarketplaceListingSections,
  PluginMoreFromAuthorSection,
  PluginOverviewLead,
} from "@/components/plugin/management/PluginMarketplaceListing";
import { pluginRuntimeStatusPresentation } from "@/components/plugin/management/plugin-status";
import {
  PluginHealthBanner,
  PluginIncludes,
  PluginSchedules,
  PluginServices,
} from "@/components/tools/PluginCapabilities";
import {
  PluginDetailFieldRow,
  PluginDetailTable,
} from "@/components/tools/plugin-detail-table";
import { PluginBannerBar } from "@/components/tools/plugin-detail-banner";
import { ProvenancePill } from "@/components/tools/ProvenancePill";
import {
  usePluginSource,
  type PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import {
  getPluginFrontendDiagnostics,
  subscribePluginFrontendDiagnostics,
  type PluginFrontendDiagnostic,
} from "@/lib/plugin-frontend";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useClipboardCopy } from "@/lib/clipboard";

export function PluginProvenancePill({ plugin }: { plugin: PluginListItem }) {
  const label = plugin.publisherLabel;
  return label === null ? null : <ProvenancePill label={label} />;
}

export function pluginIsLocalSource(plugin: PluginListItem): boolean {
  return plugin.source.startsWith("path:");
}

export function pluginRemovalLabel(plugin: PluginListItem): string {
  return pluginIsLocalSource(plugin) ? "Remove from bb" : "Uninstall";
}

export function pluginRemovalDescription(plugin: PluginListItem): string {
  return pluginIsLocalSource(plugin)
    ? `Remove "${plugin.id}" from bb and delete its settings, secrets, and schedules? Its source files stay on disk. To move it to another directory, install the new path instead; that keeps its settings.`
    : `Uninstall "${plugin.id}" and delete its managed files, settings, secrets, and schedules?`;
}

function PluginPath({ path }: { path: string }) {
  const { copied, copy } = useClipboardCopy({
    text: path,
    errorMessage: "Failed to copy path.",
  });

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Copy plugin path: ${path}`}
            onClick={() => void copy()}
            className="group -ml-1.5 mt-0.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span className="min-w-0 truncate text-left font-mono">
              {formatHomePathForDisplay(path)}
            </span>
            <Icon
              name={copied ? "Check" : "Copy"}
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy path"}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function CatalogPluginDetail({
  entry,
  onInstall,
  catalogEntries,
  onOpenPlugin,
}: {
  entry: PluginCatalogSearchEntry;
  onInstall: (entry: PluginCatalogSearchEntry) => void;
  catalogEntries: readonly PluginCatalogSearchEntry[];
  onOpenPlugin: (pluginId: string) => void;
}) {
  const count =
    entry.installs === null
      ? undefined
      : {
          display: formatPluginInstallCount(entry.installs),
          accessibleLabel: `${entry.installs.toLocaleString()} ${entry.installs === 1 ? "install" : "installs"}`,
        };
  return (
    <ResourceDetailPage
      maxWidthClassName="max-w-5xl"
      leading={<CatalogEntryIconChip entry={entry} />}
      leadingClassName="size-10"
      title={entry.displayName}
      titleMeta={<PluginMarketplaceCategoryPill entry={entry} />}
      metadata={<PluginMarketplaceHeaderMetadata entry={entry} />}
      actions={
        <ResourceInstallControl
          accessibleLabel={`Install ${entry.displayName}`}
          disabled={!entry.compatible}
          count={count}
          onAction={() => onInstall(entry)}
        />
      }
    >
      <ResourceDetailStack>
        <PluginMarketplaceListingSections entry={entry} />
        <PluginMoreFromAuthorSection
          entry={entry}
          catalogEntries={catalogEntries}
          onOpenPlugin={onOpenPlugin}
        />
      </ResourceDetailStack>
    </ResourceDetailPage>
  );
}

export function CatalogPluginDetailBanner({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  if (entry.incompatibleReason === null) return null;
  return (
    <PluginBannerBar
      tone="warning"
      icon="AlertTriangle"
      title="Update bb to install this plugin"
      detail={entry.incompatibleReason}
    />
  );
}

function pluginHealthBannerState(
  plugin: PluginListItem,
  frontendDiagnostic: PluginFrontendDiagnostic | undefined,
): { plugin: PluginListItem } | null {
  if (!plugin.enabled) return null;
  if (pluginRuntimeStatusPresentation(plugin) !== null) return { plugin };

  if (pluginFrontendDiagnosticRequiresFailureBanner(frontendDiagnostic)) {
    return {
      plugin: {
        ...plugin,
        status: "error",
        statusDetail: null,
      },
    };
  }
  return null;
}

export function pluginFrontendDiagnosticRequiresFailureBanner(
  diagnostic: PluginFrontendDiagnostic | undefined,
): boolean {
  return diagnostic?.status === "failed";
}

export function PluginDetailBanners({ plugin }: { plugin: PluginListItem }) {
  const frontendDiagnostics = useSyncExternalStore(
    subscribePluginFrontendDiagnostics,
    getPluginFrontendDiagnostics,
    getPluginFrontendDiagnostics,
  );
  const frontendDiagnostic = frontendDiagnostics.get(plugin.id);
  const banner = pluginHealthBannerState(plugin, frontendDiagnostic);
  if (banner === null) return null;
  return (
    <PluginHealthBanner
      plugin={banner.plugin}
      runtimeStatus={pluginRuntimeStatusPresentation(banner.plugin)}
    />
  );
}

export function PluginDetail({
  isLoading,
  plugin,
  pending,
  openSourceDisabled,
  onToggle,
  onEdit,
  onOpenSource,
  onDelete,
  catalogEntry,
  catalogEntries,
  onOpenPlugin,
}: {
  isLoading: boolean;
  plugin: PluginListItem | null;
  pending: boolean;
  openSourceDisabled: boolean;
  onToggle: (plugin: PluginListItem) => void;
  onEdit: (plugin: PluginListItem) => void;
  onOpenSource: (plugin: PluginListItem) => void;
  onDelete: (plugin: PluginListItem) => void;
  catalogEntry?: PluginCatalogSearchEntry;
  catalogEntries: readonly PluginCatalogSearchEntry[];
  onOpenPlugin: (pluginId: string) => void;
}) {
  const { settingsSections } = usePluginSlots();
  const sourceQuery = usePluginSource(plugin?.id ?? "", {
    enabled: plugin !== null && pluginHasUpdateSurfaces(plugin),
  });
  if (isLoading) {
    return (
      <ResourceListState
        state="loading"
        message="Loading plugins"
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  }

  if (plugin === null) {
    return (
      <ResourceListState
        state="empty"
        message="Plugin not found."
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  }

  const hasUpdateManagement = pluginHasUpdateSurfaces(plugin);
  const canEditSource = pluginIsLocalSource(plugin);
  const updatesWithBb = plugin.source.startsWith("builtin:");
  const installedAt = sourceQuery.data?.installedAt ?? null;
  const installedValue = updatesWithBb
    ? "Updates with bb"
    : installedAt !== null
      ? formatAbsoluteDate(installedAt)
      : sourceQuery.isPending
        ? "Loading…"
        : "Install date unavailable";
  const hasReleaseControl =
    hasUpdateManagement && plugin.updateState.availableVersion !== null;
  const hasReleaseUpdate =
    hasUpdateManagement &&
    (plugin.updateState.availableVersion !== null ||
      plugin.updateState.blockedVersion !== null ||
      plugin.updateState.lastFailure !== null);
  const hasConfiguration =
    plugin.hasSettings ||
    settingsSections.some((section) => section.pluginId === plugin.id);

  const pluginName = plugin.name ?? plugin.id;
  const overflowItems: ResourceOverflowMenuItem[] = [
    ...(canEditSource
      ? [
          {
            label: "Edit",
            icon: "Edit" as const,
            disabled: pending,
            onSelect: () => onEdit(plugin),
          },
          {
            label: "Open source",
            icon: "ExternalLink" as const,
            disabled: pending || openSourceDisabled,
            disabledReason: openSourceDisabled
              ? "No editor configured"
              : undefined,
            onSelect: () => onOpenSource(plugin),
          },
        ]
      : []),
    {
      label: pluginRemovalLabel(plugin),
      icon: "Trash2" as const,
      tone: "destructive" as const,
      disabled: pending || plugin.provenance === "builtin",
      disabledReason:
        plugin.provenance === "builtin"
          ? "Included with BB; disable this plugin instead."
          : undefined,
      onSelect: () => onDelete(plugin),
    },
  ];
  return (
    <ResourceDetailPage
      maxWidthClassName="max-w-5xl"
      leading={<PluginLogo plugin={plugin} className="size-4" />}
      title={pluginName}
      titleMeta={
        <span className="flex flex-wrap items-center gap-1.5">
          <PluginProvenancePill plugin={plugin} />
          {catalogEntry === undefined ? null : (
            <PluginMarketplaceCategoryPill entry={catalogEntry} />
          )}
        </span>
      }
      metadata={
        <div className="space-y-1">
          {catalogEntry === undefined ? null : (
            <PluginMarketplaceHeaderMetadata entry={catalogEntry} />
          )}
          <PluginPath path={plugin.rootDir} />
        </div>
      }
      lifecycleControl={
        <Switch
          checked={plugin.enabled}
          disabled={pending}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${pluginName}`}
          onCheckedChange={() => onToggle(plugin)}
        />
      }
      overflowMenu={
        <ResourceOverflowMenu
          label={`${pluginName} actions`}
          items={overflowItems}
        />
      }
    >
      <ResourceDetailStack>
        {catalogEntry === undefined ? (
          <section data-resource-detail-section="overview">
            <PluginOverviewLead
              description={
                plugin.description ?? "This plugin does not describe itself."
              }
            />
          </section>
        ) : (
          <>
            <PluginMarketplaceListingSections entry={catalogEntry} />
            <PluginMoreFromAuthorSection
              entry={catalogEntry}
              catalogEntries={catalogEntries}
              onOpenPlugin={onOpenPlugin}
            />
          </>
        )}
        {hasConfiguration ? (
          <ResourceDetailConfigurationSection
            id="configuration"
            className="scroll-mt-4"
            label="Configuration"
          >
            {}
            <p className="max-w-none text-sm leading-relaxed text-muted-foreground">
              This plugin is configured from{" "}
              <Link
                to={getPluginConfigurationRoutePath({ pluginId: plugin.id })}
                className="inline-flex items-center gap-0.5 rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                its Settings page
                <Icon
                  name="ChevronRight"
                  className="size-3.5 no-underline"
                  aria-hidden
                />
              </Link>
            </p>
          </ResourceDetailConfigurationSection>
        ) : null}
        <ResourceDetailReleaseSection
          label="Release"
          actions={
            hasReleaseControl ? (
              <PluginDetailReleaseControl plugin={plugin} />
            ) : hasUpdateManagement ? (
              <CheckPluginUpdatesButton
                pluginId={plugin.id}
                appearance="inline"
              />
            ) : undefined
          }
        >
          <PluginDetailTable>
            <PluginDetailFieldRow
              label={updatesWithBb ? "Delivery" : "Installed"}
              labelClassName="font-medium"
            >
              {installedValue}
            </PluginDetailFieldRow>
            <PluginDetailFieldRow label="Version" labelClassName="font-medium">
              <span className="font-mono text-xs">{plugin.version}</span>
            </PluginDetailFieldRow>
            {hasReleaseUpdate ? (
              <PluginDetailFieldRow label="Update" stackOnNarrow>
                <PluginDetailReleaseStatus plugin={plugin} />
              </PluginDetailFieldRow>
            ) : null}
          </PluginDetailTable>
        </ResourceDetailReleaseSection>
        <PluginIncludes plugin={plugin} />
        {}
        {plugin.services.length > 0 ? (
          <ResourceActivitySection label="Background services">
            <PluginServices plugin={plugin} />
          </ResourceActivitySection>
        ) : null}
        {plugin.schedules.length > 0 ? (
          <ResourceActivitySection label="Scheduled jobs">
            <PluginSchedules plugin={plugin} />
          </ResourceActivitySection>
        ) : null}
      </ResourceDetailStack>
    </ResourceDetailPage>
  );
}
