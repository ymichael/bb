import {
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import "@bb/shared-ui/icon-extended";
import { useMutation } from "@tanstack/react-query";
import { buildPluginEditThreadPrompt } from "@bb/shared-ui/resource-edit-prompt";
import { appToast } from "@/components/ui/app-toast";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import { AddPluginDialog } from "@/components/plugin/management/AddPluginDialog";
import {
  ResourceListState,
  useResourceRouteLabel,
} from "@bb/shared-ui/resource-list";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { PluginsOverview } from "@/components/plugin/PluginsOverview";
import {
  CatalogPluginDetail,
  CatalogPluginDetailBanner,
  PluginDetail,
  PluginDetailBanners,
  pluginIsLocalSource,
  pluginRemovalDescription,
  pluginRemovalLabel,
} from "@/components/tools/PluginDetail";
import {
  usePluginCatalogSearch,
  type PluginCatalogSearchEntry,
} from "@/hooks/queries/plugin-catalog-queries";
import {
  removePlugin,
  setPluginEnabled,
  usePluginList,
  type PluginListItem,
} from "@/hooks/queries/plugin-settings-queries";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import {
  TOOLS_REGISTRY_SKILLS_ROUTE_PATH,
  TOOLS_SKILLS_ROUTE_PATH,
  getPluginDetailRoutePath,
  getPluginsRoutePath,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import {
  getToolsOwnedCollectionRoutePath,
  resolveToolsSection,
  type ToolsSectionId,
} from "@/components/tools/tools-navigation";
import { cn } from "@bb/shared-ui/lib/utils";
import { SkillsLibrary } from "@/components/tools/SkillsLibrary";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import { pluginToast } from "@/components/plugin/PluginNotificationDescription";
import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import { ThreadSecondaryPanel } from "@/components/secondary-panel/ThreadSecondaryPanel";
import type { SecondaryPanelRenderableTab } from "@/components/secondary-panel/secondaryPanelTab";

function ToolsBodyFallback() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pb-4 pt-2 md:px-5">
        <div className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
    </div>
  );
}

function ToolsScrollPage({
  children,
  fillViewport = false,
}: {
  children: ReactNode;
  fillViewport?: boolean;
}) {
  const {
    scrollRef,
    topSentinelRef,
    bottomSentinelRef,
    aboveOverflow,
    belowOverflow,
  } = useScrollOverflowState<HTMLDivElement>({ measureOverflow: true });
  if (fillViewport) {
    return (
      <div className="box-border h-full w-full pb-4 pt-3 md:pt-4">
        {children}
      </div>
    );
  }
  return (
    <div className="relative h-full overflow-hidden">
      <div ref={scrollRef} className="h-full overflow-y-auto">
        <div ref={topSentinelRef} aria-hidden className="h-0" />
        <div
          className={cn(
            "mx-auto box-border min-h-full w-full space-y-4 px-4 pb-4 pt-3 md:px-5 md:pt-4",
            "max-w-5xl",
          )}
        >
          {children}
        </div>
        <div ref={bottomSentinelRef} aria-hidden className="h-0" />
      </div>
      {aboveOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0">
          <OverflowFade placement="below" tone="background" />
        </div>
      ) : null}
      {belowOverflow ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0">
          <OverflowFade placement="above" tone="background" />
        </div>
      ) : null}
    </div>
  );
}

function ToolsSectionBody({
  activeSection,
  pathname,
  onOpenPlugin,
}: {
  activeSection: ToolsSectionId;
  pathname: string;
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  if (activeSection === "skills") {
    const isCollection =
      pathname === TOOLS_SKILLS_ROUTE_PATH ||
      pathname === TOOLS_REGISTRY_SKILLS_ROUTE_PATH;
    return (
      <ToolsScrollPage fillViewport={isCollection}>
        <SkillsLibrary />
      </ToolsScrollPage>
    );
  }
  return <PluginsToolView onOpenPlugin={onOpenPlugin} />;
}

function PluginsToolView({
  onOpenPlugin,
}: {
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  return (
    <ToolsScrollPage fillViewport>
      <PluginsOverview onOpenPlugin={onOpenPlugin} />
    </ToolsScrollPage>
  );
}

function PluginDetailToolView({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<PluginListItem | null>(null);
  const [installTarget, setInstallTarget] =
    useState<PluginCatalogSearchEntry | null>(null);
  const listQuery = usePluginList({ enabled: true });
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const plugins = useMemo(
    () => listQuery.data?.plugins ?? [],
    [listQuery.data],
  );
  const {
    canOpenPreferredDirectoryTarget,
    openPathInPreferredDirectoryTarget,
  } = useLocalOpenTargets({
    enabled: plugins.some(
      (plugin) => pluginIsLocalSource(plugin) && plugin.rootDir !== null,
    ),
  });
  const pluginToggle = useMutation({
    meta: { showErrorToast: false },
    mutationFn: async (plugin: PluginListItem) => {
      const action = plugin.enabled ? "disable" : "enable";
      try {
        await setPluginEnabled(fetch, plugin.id, !plugin.enabled);
      } catch {
        throw new Error(`Failed to ${action} plugin`);
      }
    },
    onSuccess: () => listQuery.refetch(),
    onError: (error) => {
      appToast.error(error instanceof Error ? error.message : String(error));
    },
  });
  const pluginDelete = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (plugin: PluginListItem) => removePlugin(fetch, plugin.id),
    onSuccess: (_data, deletedPlugin) => {
      const isLocal = pluginIsLocalSource(deletedPlugin);
      pluginToast.success(
        isLocal ? "Plugin removed from bb" : "Plugin uninstalled",
        deletedPlugin,
        "catalog",
      );
      setDeleteTarget(null);
      navigate(getToolsOwnedCollectionRoutePath("plugins"));
      return listQuery.refetch();
    },
    onError: (error, plugin) => {
      const isLocal = pluginIsLocalSource(plugin);
      pluginToast.error(
        isLocal ? "Plugin removal failed" : "Plugin uninstall failed",
        plugin,
        "installed",
        pluginAdminErrorMessage(error),
      );
    },
  });
  const isLoading = listQuery.isFetching && listQuery.data === undefined;
  const selectedPlugin =
    plugins.find((plugin) => plugin.id === pluginId) ?? null;
  const selectedCatalogEntry =
    catalogQuery.data?.entries.find((entry) => entry.pluginId === pluginId) ??
    null;
  useResourceRouteLabel(
    selectedPlugin?.name ??
      selectedPlugin?.id ??
      selectedCatalogEntry?.displayName ??
      null,
  );
  const pendingPluginId =
    pluginToggle.isPending && pluginToggle.variables
      ? pluginToggle.variables.id
      : pluginDelete.isPending && pluginDelete.variables
        ? pluginDelete.variables.id
        : null;
  const handleEditPlugin = useCallback(
    (plugin: PluginListItem) => {
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          initialPrompt: buildPluginEditThreadPrompt({
            name: plugin.name ?? plugin.id,
            path: plugin.rootDir,
          }),
          replaceInitialPrompt: true,
        },
      });
    },
    [navigate],
  );
  const handleOpenPluginSource = useCallback(
    (plugin: PluginListItem) => {
      if (!canOpenPreferredDirectoryTarget) return;
      void openPathInPreferredDirectoryTarget({
        path: plugin.rootDir,
        lineNumber: null,
      });
    },
    [canOpenPreferredDirectoryTarget, openPathInPreferredDirectoryTarget],
  );
  const handleOpenCatalogPlugin = useCallback(
    (nextPluginId: string) => {
      navigate({
        pathname: getPluginDetailRoutePath({ pluginId: nextPluginId }),
        search: location.search,
      });
    },
    [location.search, navigate],
  );

  let detailContent: ReactNode;
  if (listQuery.isError) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void listQuery.refetch()}
      />
    );
  } else if (isLoading) {
    detailContent = (
      <ResourceListState
        state="loading"
        message="Loading plugin"
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  } else if (selectedPlugin !== null) {
    detailContent = (
      <PluginDetail
        isLoading={false}
        plugin={selectedPlugin}
        pending={pendingPluginId === selectedPlugin.id}
        openSourceDisabled={!canOpenPreferredDirectoryTarget}
        onToggle={(target) => pluginToggle.mutate(target)}
        onEdit={handleEditPlugin}
        onOpenSource={handleOpenPluginSource}
        onDelete={setDeleteTarget}
        catalogEntry={selectedCatalogEntry ?? undefined}
        catalogEntries={catalogQuery.data?.entries ?? []}
        onOpenPlugin={handleOpenCatalogPlugin}
      />
    );
  } else if (selectedCatalogEntry !== null && !selectedCatalogEntry.installed) {
    detailContent = (
      <CatalogPluginDetail
        entry={selectedCatalogEntry}
        onInstall={setInstallTarget}
        catalogEntries={catalogQuery.data?.entries ?? []}
        onOpenPlugin={handleOpenCatalogPlugin}
      />
    );
  } else if (catalogQuery.isError) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void catalogQuery.refetch()}
      />
    );
  } else if (catalogQuery.isFetching && catalogQuery.data === undefined) {
    detailContent = (
      <ResourceListState
        state="loading"
        message="Loading plugin"
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  } else if (selectedCatalogEntry?.installed) {
    detailContent = (
      <ResourceListState
        state="error"
        message="Couldn't load the installed plugin."
        layout="detail"
        maxWidthClassName="max-w-5xl"
        onRetry={() => void listQuery.refetch()}
      />
    );
  } else {
    detailContent = (
      <ResourceListState
        state="empty"
        message="Plugin not found."
        layout="detail"
        maxWidthClassName="max-w-5xl"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectedPlugin !== null ? (
        <PluginDetailBanners plugin={selectedPlugin} />
      ) : selectedCatalogEntry !== null && !selectedCatalogEntry.installed ? (
        <CatalogPluginDetailBanner entry={selectedCatalogEntry} />
      ) : null}
      <div className="min-h-0 flex-1">
        <ToolsScrollPage>
          {detailContent}
          <ConfirmDeleteDialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open && !pluginDelete.isPending) setDeleteTarget(null);
            }}
          >
            {deleteTarget ? (
              <ConfirmDeleteDialogContent
                title={
                  pluginIsLocalSource(deleteTarget)
                    ? "Remove plugin from bb?"
                    : "Uninstall plugin?"
                }
                description={pluginRemovalDescription(deleteTarget)}
                confirmLabel={pluginRemovalLabel(deleteTarget)}
                pending={pluginDelete.isPending}
                onConfirm={() => pluginDelete.mutate(deleteTarget)}
                onCancel={() => setDeleteTarget(null)}
              />
            ) : null}
          </ConfirmDeleteDialog>
          <AddPluginDialog
            open={installTarget !== null}
            initial={
              installTarget === null
                ? null
                : {
                    entryId: installTarget.entryId,
                    marketplace: installTarget.marketplace,
                    pluginId: installTarget.pluginId,
                    publisherLabel: installTarget.publisherLabel,
                    displayName: installTarget.displayName,
                    icon: installTarget.icon,
                    iconUrl: installTarget.iconUrl,
                    iconTinted: installTarget.iconTinted,
                    source: installTarget.source,
                  }
            }
            onOpenChange={(open) => {
              if (!open) setInstallTarget(null);
            }}
            onInstalled={() => void listQuery.refetch()}
          />
        </ToolsScrollPage>
      </div>
    </div>
  );
}

export function PluginDetailPaneView({ pluginId }: { pluginId: string }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<ToolsBodyFallback />}>
          <PluginDetailToolView pluginId={pluginId} />
        </Suspense>
      </div>
    </div>
  );
}

export function ToolsView({ pluginId }: { pluginId?: string } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeSection = resolveToolsSection(location.pathname);
  const focusReturnRef = useRef<HTMLButtonElement | null>(null);
  const [isPluginDetailFullPage, setIsPluginDetailFullPage] = useState(false);
  const catalogQuery = usePluginCatalogSearch("", {
    enabled: activeSection === "plugins",
  });
  const listQuery = usePluginList({ enabled: activeSection === "plugins" });
  const isPanelOpen = activeSection === "plugins" && pluginId !== undefined;

  const openPlugin = useCallback(
    (nextPluginId: string, trigger: HTMLButtonElement) => {
      focusReturnRef.current = trigger;
      navigate({
        pathname: getPluginDetailRoutePath({ pluginId: nextPluginId }),
        search: location.search,
      });
    },
    [location.search, navigate],
  );
  const closePanel = useCallback(() => {
    setIsPluginDetailFullPage(false);
    navigate({
      pathname: getPluginsRoutePath(),
      search: location.search,
    });
    const focusTarget = focusReturnRef.current;
    window.requestAnimationFrame(() => {
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
    });
  }, [location.search, navigate]);
  const catalogEntry = catalogQuery.data?.entries.find(
    (entry) => entry.pluginId === pluginId,
  );
  const installedPlugin = listQuery.data?.plugins.find(
    (entry) => entry.id === pluginId,
  );
  const panelLabel =
    catalogEntry?.displayName ??
    installedPlugin?.name ??
    installedPlugin?.id ??
    pluginId ??
    "Plugin";
  const panelTab = useMemo<SecondaryPanelRenderableTab | null>(() => {
    if (pluginId === undefined) return null;
    return {
      contentFillsRegion: true,
      label: panelLabel,
      leadingVisual: (
        <PluginIcon
          pluginId={pluginId}
          icon={catalogEntry?.icon ?? installedPlugin?.icon ?? null}
          compactIconUrl={installedPlugin?.compactIconUrl}
          className="size-3.5"
        />
      ),
      onClose: closePanel,
      onSelect: () => undefined,
      renderContent: () => <PluginDetailToolView pluginId={pluginId} />,
      statusLabel: null,
      tab: {
        id: `marketplace-plugin:${pluginId}`,
        kind: "marketplace-plugin-detail",
      },
    };
  }, [
    catalogEntry?.icon,
    closePanel,
    installedPlugin?.compactIconUrl,
    installedPlugin?.icon,
    panelLabel,
    pluginId,
  ]);
  const panelTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(
    () => (panelTab === null ? [] : [panelTab]),
    [panelTab],
  );
  const mainContent = (
    <div className="min-h-0 flex-1 overflow-hidden">
      <Suspense fallback={<ToolsBodyFallback />}>
        <ToolsSectionBody
          activeSection={activeSection}
          pathname={location.pathname}
          onOpenPlugin={openPlugin}
        />
      </Suspense>
    </div>
  );
  const renderPanel = useCallback(
    ({
      presentation,
      isMainCollapsed,
      onToggleMainCollapse,
      resizablePanelId,
    }: {
      presentation: "inline" | "drawer";
      isMainCollapsed: boolean;
      onToggleMainCollapse: () => void;
      resizablePanelId?: string;
    }) => (
      <ThreadSecondaryPanel
        activeTab={panelTab?.tab ?? null}
        canUseGitUi={false}
        metadataContent={null}
        tabs={panelTabs}
        fixedTabs={[]}
        onTabReorder={() => undefined}
        isOpen={isPanelOpen}
        showConversationCollapseControl
        showNewTabButton={false}
        onPanelFocus={() => undefined}
        onCollapse={closePanel}
        onClose={closePanel}
        onOpenNewTab={() => undefined}
        isConversationCollapsed={isMainCollapsed}
        onToggleConversationCollapse={onToggleMainCollapse}
        renderAsDrawer={presentation === "drawer"}
        resizablePanelId={resizablePanelId}
      />
    ),
    [closePanel, isPanelOpen, panelTab?.tab, panelTabs],
  );

  if (
    activeSection === "plugins" &&
    pluginId !== undefined &&
    new URLSearchParams(location.search).get("view") === "installed"
  ) {
    return (
      <Navigate
        replace
        to={`${getPluginDetailRoutePath({ pluginId, view: "installed" })}${location.hash}`}
      />
    );
  }

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <SecondaryPanelLayout
        open={isPanelOpen}
        onToggle={isPanelOpen ? closePanel : () => undefined}
        onClose={closePanel}
        panelGroupKey="extensions-plugin-details"
        resetKey="extensions-plugin-details"
        contentKey={pluginId ?? "extensions-plugins"}
        drawerLabel="Plugin details"
        drawerFallback={<ToolsBodyFallback />}
        mainPanelId="extensions-main-panel"
        main={mainContent}
        collapse={{
          active: isPluginDetailFullPage,
          onToggle: () => setIsPluginDetailFullPage((current) => !current),
        }}
        renderPanel={renderPanel}
        composerHost={null}
        compactPresentation="full"
      />
    </div>
  );
}
