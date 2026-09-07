import type { ReactNode } from "react";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { pluginCliCall } from "@bb/domain/plugin-cli";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@bb/shared-ui/button";
import type { PluginCapability, SkillListResponse } from "@bb/server-contract";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  ResourceDetailIncludesSection,
  ResourceStatus,
  type ResourceStatusTone,
} from "@bb/shared-ui/resource-list";
import { cn } from "@bb/shared-ui/lib/utils";
import { PluginBannerBar } from "@/components/tools/plugin-detail-banner";
import {
  PluginDetailGlyph,
  PluginDetailRow,
  PluginDetailTable,
  PLUGIN_DETAIL_HEADER_CELL_CLASS,
  PLUGIN_DETAIL_PRIMARY_COLUMN_CLASS,
} from "@/components/tools/plugin-detail-table";
import { formatAbsoluteDate } from "@/components/plugin/management/plugin-ui";
import type { PluginRuntimeStatusPresentation } from "@/components/plugin/management/plugin-status";
import { appToast } from "@/components/ui/app-toast";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  reloadPlugin,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { usePluginSlots, type PluginSlotSnapshot } from "@/lib/plugin-slots";
import {
  getPluginConfigurationRoutePath,
  getPluginPanelRoutePath,
  getRootComposeRoutePath,
  getSettingsRoutePath,
  getSkillDetailRoutePath,
  getSkillsRoutePath,
} from "@/lib/route-paths";
import { getPluginHomepageSectionAnchor } from "@/lib/plugin-homepage-section";
import { projectSkillsQueryKey } from "@/hooks/queries/query-keys";

function pluginActivityIcon(state: "running" | "ok" | "error" | null): {
  name: IconName;
  className: string;
  label: string;
} {
  if (state === null) {
    return {
      name: "Clock",
      className: "text-muted-foreground",
      label: "Scheduled",
    };
  }
  if (state === "running") {
    return {
      name: "Clock",
      className: "animate-shine-icon text-muted-foreground",
      label: "Running",
    };
  }
  if (state === "ok") {
    return {
      name: "CircleCheck",
      className: "text-success",
      label: "Succeeded",
    };
  }
  if (state === "error") {
    return { name: "CircleX", className: "text-destructive", label: "Failed" };
  }
  return {
    name: "Clock",
    className: "text-muted-foreground",
    label: "Scheduled",
  };
}

function pluginServiceStatus(state: "running" | "backoff" | "stopped"): {
  label: string;
  labelClassName?: string;
  statusClassName?: string;
  tone: ResourceStatusTone;
} {
  if (state === "running") {
    return {
      label: "Running",
      labelClassName: "animate-shine",
      tone: "success",
    };
  }
  if (state === "backoff") {
    return {
      label: "Restarting",
      labelClassName: "animate-shine",
      tone: "muted",
    };
  }
  return {
    label: "Stopped",
    statusClassName: "opacity-50",
    tone: "muted",
  };
}

function PluginActivityState({
  state,
}: {
  state: "running" | "ok" | "error" | null;
}) {
  const icon = pluginActivityIcon(state);
  return (
    <PluginDetailGlyph
      icon={icon.name}
      label={icon.label}
      className={icon.className}
    />
  );
}

interface PluginCapabilityItem {
  key: string;
  label: ReactNode;
  detail?: ReactNode;
  mono?: boolean;
  destinationPath?: string;
}

function namedSurface(
  prefix: string,
  id: string,
  title: string | undefined,
  description: string,
  destinationPath?: string,
): PluginCapabilityItem {
  const label = title?.trim() || id;
  return {
    key: `${prefix}:${id}`,
    label,
    detail:
      label === id ? (
        description
      ) : (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span>{description}</span>
          <span className="break-all font-mono text-subtle-foreground">
            {id}
          </span>
        </span>
      ),
    mono: label === id,
    destinationPath,
  };
}

function namedSlotItems<
  Slot extends { pluginId: string; id: string; title?: string },
>(
  pluginId: string,
  slots: readonly Slot[],
  prefix: string,
  description: string,
  destinationPath?: (slot: Slot) => string,
): PluginCapabilityItem[] {
  return slots
    .filter((slot) => slot.pluginId === pluginId)
    .map((slot) =>
      namedSurface(
        prefix,
        slot.id,
        slot.title,
        description,
        destinationPath?.(slot),
      ),
    );
}

function pluginAppSurfaceItems(
  plugin: PluginListItem,
  slots: PluginSlotSnapshot,
): PluginCapabilityItem[] {
  const pluginId = plugin.id;
  const settingsSections = slots.settingsSections.filter(
    (section) => section.pluginId === pluginId,
  );
  return [
    ...(plugin.hasSettings || settingsSections.length > 0
      ? [
          namedSurface(
            "settings",
            "settings",
            "Settings",
            "Opens this plugin's configuration.",
            getPluginConfigurationRoutePath({ pluginId }),
          ),
        ]
      : []),
    ...namedSlotItems(
      pluginId,
      slots.navPanels,
      "nav",
      "Adds a page to the app sidebar.",
      (panel) =>
        getPluginPanelRoutePath({
          pluginId,
          path: panel.path,
        }),
    ),
    ...namedSlotItems(
      pluginId,
      slots.homepageSections,
      "homepage",
      "Adds content to the Home page.",
      (section) =>
        `${getRootComposeRoutePath()}#${getPluginHomepageSectionAnchor(pluginId, section.id)}`,
    ),
    ...namedSlotItems(
      pluginId,
      slots.appOverlays,
      "app-overlay",
      "Renders app-wide floating interface content.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.threadLists,
      "thread-list",
      "Can replace the sidebar thread list; configured in Appearance.",
      () => getSettingsRoutePath("appearance"),
    ),
    ...namedSlotItems(
      pluginId,
      slots.experimentalSidebarNavigations,
      "sidebar-navigation",
      "Can replace the sidebar navigation controls; configured in Appearance.",
      () => getSettingsRoutePath("appearance"),
    ),
    ...namedSlotItems(
      pluginId,
      slots.sourceCodeRenderers,
      "source-code-renderer",
      "Replaces how source code is displayed everywhere in the app.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.diffRenderers,
      "diff-renderer",
      "Replaces how diffs are displayed everywhere in the app.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.threadPanelActions,
      "thread-panel",
      "Adds an action that opens a panel beside a thread.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.newThreadPanelActions,
      "new-thread-panel",
      "Adds an action that opens a panel beside the New thread screen.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.pendingInteractions,
      "input",
      "Renders a custom interaction inside a thread.",
    ),
    ...slots.sidebarFooterItems
      .filter((slot) => slot.pluginId === pluginId)
      .map((slot) =>
        namedSurface(
          "sidebar-footer",
          slot.id,
          slot.label,
          slot.kind === "action"
            ? "Adds an action to the app sidebar footer."
            : "Adds content revealed from the app sidebar footer.",
        ),
      ),
    ...namedSlotItems(
      pluginId,
      slots.messageActions,
      "message-action",
      "Adds an action to messages in threads.",
    ),
    ...namedSlotItems(
      pluginId,
      slots.threadHeaderActions,
      "thread-header",
      "Adds an action to thread headers.",
    ),
    ...slots.composerCustomizations
      .filter((slot) => slot.pluginId === pluginId)
      .flatMap((slot) => [
        ...(slot.actions ?? []).map((action) =>
          namedSurface(
            `composer:${slot.id}:action`,
            action.id,
            undefined,
            "Adds an action beside the thread composer.",
          ),
        ),
        ...(slot.banners ?? []).map((banner) =>
          namedSurface(
            `composer:${slot.id}:banner`,
            banner.id,
            undefined,
            "Shows information above the thread composer.",
          ),
        ),
        ...(slot.plusMenu ?? []).map((item) =>
          namedSurface(
            `composer:${slot.id}:plus-menu`,
            item.id,
            item.label,
            "Adds an item to the composer’s add menu.",
          ),
        ),
        ...(slot.richText?.effects ?? []).map((effect) =>
          namedSurface(
            `composer:${slot.id}:rich-text`,
            effect.id,
            undefined,
            "Adds rich-text behavior while composing a message.",
          ),
        ),
      ]),
    ...slots.fileOpeners
      .filter((slot) => slot.pluginId === pluginId)
      .map((slot) => ({
        ...namedSurface(
          "file",
          slot.id,
          slot.title,
          "Opens supported files in a plugin-provided viewer.",
          getSettingsRoutePath("files"),
        ),
        detail: (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span>Opens these files in a plugin-provided viewer:</span>
            <span className="font-mono">
              {slot.extensions.map((extension) => `.${extension}`).join(", ")}
            </span>
          </span>
        ),
      })),
    ...slots.messageDirectives
      .filter((slot) => slot.pluginId === pluginId)
      .map((slot) => ({
        key: `directive:${slot.id}`,
        label: `::${slot.id}`,
        detail: "Renders plugin-provided content inside thread messages.",
        mono: true,
      })),
  ];
}

export function PluginIncludes({ plugin }: { plugin: PluginListItem }) {
  const slots = usePluginSlots();
  const queryClient = useQueryClient();
  const cachedSkills = queryClient.getQueryData<SkillListResponse>(
    projectSkillsQueryKey(PERSONAL_PROJECT_ID),
  );
  const appItems = pluginAppSurfaceItems(plugin, slots);

  const skillDestination = (capabilityId: string): string => {
    const installedSkill = cachedSkills?.skills.find((skill) => {
      if (skill.pluginId !== plugin.id) return false;
      const segments = skill.filePath.split(/[\\/]/u);
      return segments.at(-2) === capabilityId || skill.name === capabilityId;
    });
    return installedSkill === undefined
      ? `${getSkillsRoutePath()}?view=library`
      : getSkillDetailRoutePath({ skillId: installedSkill.id });
  };

  const declared = (kind: PluginCapability["kind"]): PluginCapabilityItem[] =>
    plugin.capabilities
      .filter((capability) => capability.kind === kind)
      .map((capability) => ({
        key: `${capability.kind}:${capability.id}`,
        label: capability.label,
        detail: capability.detail ?? undefined,
        mono: kind === "skill" || kind === "agent-tool",
        destinationPath:
          kind === "theme"
            ? getSettingsRoutePath("appearance")
            : kind === "skill"
              ? skillDestination(capability.id)
              : undefined,
      }));

  const categories: Array<{
    icon: IconName;
    kind: string;
    items: PluginCapabilityItem[];
  }> = [
    {
      icon: "AppWindow",
      kind: "App surface",
      items: appItems,
    },
    {
      icon: "Terminal",
      kind: "Command",
      items: plugin.cliCommand
        ? [
            {
              key: plugin.cliCommand.name,
              label: pluginCliCall(plugin.id, plugin.cliCommand.name),
              detail: plugin.cliCommand.summary || undefined,
              mono: true,
            },
          ]
        : [],
    },
    {
      icon: "Explore",
      kind: "Skill",
      items: declared("skill"),
    },
    {
      icon: "Toolbox",
      kind: "Agent tool",
      items: declared("agent-tool"),
    },
    {
      icon: "MessageCirclePlus",
      kind: "Thread integration",
      items: declared("thread-integration"),
    },
    {
      icon: "Palette",
      kind: "Theme",
      items: declared("theme"),
    },
  ];
  const items = categories.flatMap(({ icon, kind, items: groupItems }) =>
    groupItems.map((item) => ({ ...item, icon, kind })),
  );

  if (!plugin.enabled || items.length === 0) return null;

  const live =
    plugin.status === "running" ||
    plugin.status === "degraded" ||
    plugin.status === "needs-configuration";
  const liveCapabilitiesNote =
    "This plugin isn't running, so its commands, settings, agent tools, app surfaces, and thread integrations can't be listed.";

  return (
    <ResourceDetailIncludesSection label="Capabilities">
      <div className="space-y-3">
        <PluginDetailTable>
          {items.map((item) => (
            <PluginDetailRow
              key={item.key}
              glyph={
                <PluginDetailGlyph
                  icon={item.icon}
                  label={item.kind}
                  className="text-muted-foreground"
                />
              }
              name={
                item.destinationPath === undefined ? (
                  item.label
                ) : (
                  <Link
                    to={item.destinationPath}
                    className="rounded-sm text-xs underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {item.label}
                  </Link>
                )
              }
              nameClassName="text-xs"
              mono={item.mono}
              detail={item.detail}
            />
          ))}
        </PluginDetailTable>
        {live ? null : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {liveCapabilitiesNote}
          </p>
        )}
      </div>
    </ResourceDetailIncludesSection>
  );
}

function PluginRuntimeStatusAlert({
  plugin,
  runtimeStatus,
  onReload,
  reloadPending,
}: {
  plugin: PluginListItem;
  runtimeStatus: PluginRuntimeStatusPresentation;
  onReload: () => void;
  reloadPending: boolean;
}) {
  const canReload =
    plugin.status === "error" ||
    plugin.status === "degraded" ||
    (plugin.status === "needs-configuration" && !plugin.hasSettings);
  const condition =
    plugin.status === "needs-configuration" && plugin.statusDetail?.trim()
      ? plugin.statusDetail
      : runtimeStatus.condition;
  const detail = [condition, runtimeStatus.recovery]
    .filter((part): part is string => part !== null && part.length > 0)
    .map((part) => {
      const capitalized = `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
    })
    .join(" ");
  return (
    <PluginBannerBar
      role="alert"
      tone={runtimeStatus.tone === "error" ? "destructive" : "warning"}
      icon={runtimeStatus.icon}
      title={runtimeStatus.label}
      detail={detail}
      separator={plugin.status !== "degraded"}
      action={
        canReload ? (
          <Button
            type="button"
            size="sm"
            disabled={reloadPending}
            className="h-7 px-2.5 text-xs"
            onClick={onReload}
          >
            {reloadPending ? (
              <Icon
                name="Loading"
                className="size-3.5 animate-spin"
                aria-hidden
              />
            ) : null}
            {reloadPending ? "Reloading\u2026" : "Reload"}
          </Button>
        ) : undefined
      }
    />
  );
}

export function PluginHealthBanner({
  plugin,
  runtimeStatus,
}: {
  plugin: PluginListItem;
  runtimeStatus: PluginRuntimeStatusPresentation | null;
}) {
  const queryClient = useQueryClient();
  const reload = useMutation({
    meta: { showErrorToast: false },
    mutationFn: () => reloadPlugin(fetch, plugin.id),
    onSuccess: () => invalidatePluginList({ queryClient }),
    onError: (error) => {
      appToast.error("Failed to reload plugin", {
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const showOverallState = plugin.enabled && runtimeStatus !== null;
  if (!showOverallState || runtimeStatus === null) return null;
  return (
    <PluginRuntimeStatusAlert
      plugin={plugin}
      runtimeStatus={runtimeStatus}
      reloadPending={reload.isPending}
      onReload={() => reload.mutate()}
    />
  );
}

export function PluginServices({ plugin }: { plugin: PluginListItem }) {
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border bg-card align-top">
      <table
        aria-label="Background services"
        className="w-full max-w-full table-fixed border-collapse text-left"
      >
        <colgroup>
          <col className={PLUGIN_DETAIL_PRIMARY_COLUMN_CLASS} />
          <col />
        </colgroup>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th
              scope="col"
              className={cn(
                PLUGIN_DETAIL_HEADER_CELL_CLASS,
                "px-4 py-2 font-medium",
              )}
            >
              Status
            </th>
            <th
              scope="col"
              className={cn(
                PLUGIN_DETAIL_HEADER_CELL_CLASS,
                "border-l border-border px-4 py-2 font-medium",
              )}
            >
              Service
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {plugin.services.map((service) => {
            const status = pluginServiceStatus(service.state);
            return (
              <tr key={service.name}>
                <td
                  className={cn(
                    "px-4 py-1.5 align-middle text-left",
                    status.statusClassName,
                  )}
                >
                  <ResourceStatus tone={status.tone}>
                    <span className={status.labelClassName}>
                      {status.label}
                    </span>
                  </ResourceStatus>
                </td>
                <th
                  scope="row"
                  className="break-words border-l border-border px-4 py-1.5 text-left text-sm font-normal leading-snug text-foreground"
                >
                  {service.name}
                </th>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PluginSchedules({ plugin }: { plugin: PluginListItem }) {
  return (
    <PluginDetailTable>
      {plugin.schedules.map((schedule) => (
        <PluginDetailRow
          key={schedule.name}
          glyph={<PluginActivityState state={schedule.lastStatus} />}
          name={schedule.name}
          detail={
            schedule.lastError ??
            `Next ${formatAbsoluteDate(schedule.nextRunAt)}`
          }
        />
      ))}
    </PluginDetailTable>
  );
}
