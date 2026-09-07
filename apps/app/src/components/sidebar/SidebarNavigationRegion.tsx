import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ExperimentalSidebarNavigationAction,
  ExperimentalSidebarNavigationActivationOptions,
  ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { appToast } from "@/components/ui/app-toast";
import { useSidebar } from "@/components/ui/sidebar";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import {
  BuiltInSidebarNavigation,
  type BuiltInSidebarNavigationProps,
} from "./BuiltInSidebarNavigation";
import {
  activateSidebarNavigationItem,
  createSidebarNavigationItems,
  resolveActiveSidebarNavigationItemId,
} from "./sidebarNavigationItems";
import { useSidebarNavigationReplacement } from "./sidebarNavigationProvider";
import { usePaneContentSplitActions } from "./usePaneContentSplitDrag";

const SIDEBAR_NAVIGATION_SLOT_KIND = "sidebarNavigation";
const NEW_THREAD_CONTENT = { kind: "new-thread" } as const;

function contentForAction(
  action: ExperimentalSidebarNavigationAction,
  navPanels: ReturnType<typeof usePluginSlots>["navPanels"],
) {
  if (action.kind === "new-thread") return NEW_THREAD_CONTENT;
  if (action.kind !== "open-plugin-panel") return null;
  const panel = navPanels.find(
    (candidate) =>
      candidate.pluginId === action.pluginId && candidate.id === action.panelId,
  );
  return panel
    ? ({
        kind: "plugin-panel",
        pluginId: panel.pluginId,
        panelPath: panel.path,
        subPath: "",
      } as const)
    : null;
}

export function SidebarNavigationRegion(props: BuiltInSidebarNavigationProps) {
  const { navPanels } = usePluginSlots();
  const replacement = useSidebarNavigationReplacement();
  const { isCompactViewport } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const commandRunner = useAppCommandRunner();
  const splitActions = usePaneContentSplitActions();
  const newThreadShortcut = useAppCommandShortcut("thread.new");
  const threadSearchShortcut = useAppCommandShortcut("thread.search");

  const splitPropsFor = useCallback(
    (
      action: ExperimentalSidebarNavigationAction,
      label: string,
    ): ExperimentalSidebarNavigationItem["experimental_splitProps"] => {
      const content = contentForAction(action, navPanels);
      if (content === null || splitActions.isCompact) return {};
      return {
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) =>
          splitActions.beginDrag(event, {
            content,
            enabled: props.splitEnabled ?? false,
            label,
            onNavigate: props.onNavigate,
          }),
      };
    },
    [navPanels, props.onNavigate, props.splitEnabled, splitActions],
  );
  const items = useMemo(
    () =>
      createSidebarNavigationItems({
        navPanels,
        newThreadDisabled: props.onNewChat === undefined,
        newThreadShortcut: newThreadShortcut
          ? {
              label: newThreadShortcut.label,
              ariaKeyShortcuts: newThreadShortcut.ariaKeyshortcuts,
            }
          : null,
        searchThreadsDisabled: !commandRunner.isCommandAvailable(
          "thread.search",
          null,
        ),
        searchThreadsShortcut: threadSearchShortcut
          ? {
              label: threadSearchShortcut.label,
              ariaKeyShortcuts: threadSearchShortcut.ariaKeyshortcuts,
            }
          : null,
        showExtensions: props.toolsRoutePath !== undefined,
        splitPropsFor,
      }),
    [
      commandRunner,
      navPanels,
      newThreadShortcut,
      props.onNewChat,
      props.toolsRoutePath,
      splitPropsFor,
      threadSearchShortcut,
    ],
  );
  const activeItemId = resolveActiveSidebarNavigationItemId({
    items,
    pathname: location.pathname,
    navPanels,
  });
  const replacementIdentity =
    replacement.kind === "plugin"
      ? `${replacement.registration.pluginId}/${replacement.registration.id}/${replacement.registration.generation}`
      : "owner";
  const activationRef = useRef({
    replacementIdentity,
    items,
    navPanels,
    props,
    navigate,
    commandRunner,
    splitActions,
  });
  useLayoutEffect(() => {
    activationRef.current = {
      replacementIdentity,
      items,
      navPanels,
      props,
      navigate,
      commandRunner,
      splitActions,
    };
  }, [
    commandRunner,
    items,
    navPanels,
    navigate,
    props,
    replacementIdentity,
    splitActions,
  ]);

  const handleActivate = useCallback(
    (
      identity: string,
      itemId: string,
      options: ExperimentalSidebarNavigationActivationOptions,
    ) => {
      const current = activationRef.current;
      if (identity !== current.replacementIdentity) return;
      activateSidebarNavigationItem(
        current.items,
        itemId,
        options.openInSplit,
        {
          newThread: (openInSplit) => {
            if (!openInSplit) {
              current.props.onNewChat?.();
              return;
            }
            current.splitActions.openInSplit({
              content: NEW_THREAD_CONTENT,
              enabled: current.props.splitEnabled ?? false,
              label: "New thread",
              onNavigate: current.props.onNavigate,
            });
          },
          searchThreads: () => {
            current.props.onSearchThreads?.();
            current.commandRunner.dispatch("thread.search", null);
          },
          openExtensions: () => {
            if (current.props.toolsRoutePath === undefined) return;
            current.props.onNavigate?.();
            void current.navigate(current.props.toolsRoutePath);
          },
          openPluginPanel: (action, openInSplit) => {
            const panel = current.navPanels.find(
              (candidate) =>
                candidate.pluginId === action.pluginId &&
                candidate.id === action.panelId,
            );
            if (!panel) return;
            if (openInSplit) {
              current.splitActions.openInSplit({
                content: {
                  kind: "plugin-panel",
                  pluginId: panel.pluginId,
                  panelPath: panel.path,
                  subPath: "",
                },
                enabled: current.props.splitEnabled ?? false,
                label: panel.title,
                onNavigate: current.props.onNavigate,
              });
              return;
            }
            current.props.onNavigate?.();
            void current.navigate(
              getPluginPanelRoutePath({
                pluginId: panel.pluginId,
                path: panel.path,
              }),
            );
          },
        },
      );
    },
    [],
  );

  const original = <BuiltInSidebarNavigation {...props} />;
  const title =
    replacement.kind === "plugin" ? replacement.registration.title : "Plugin";
  return (
    <nav
      aria-label="Sidebar navigation"
      data-testid="sidebar-navigation-region"
      className={cn(
        props.compactCustomizeMode && "flex min-h-0 flex-1 flex-col",
      )}
    >
      <PluginReplacementSlot
        replacement={replacement}
        original={original}
        slotKind={SIDEBAR_NAVIGATION_SLOT_KIND}
        onCrash={(pluginId) => {
          appToast.error("Sidebar navigation plugin crashed", {
            description: `${title} (${pluginId}) stopped working, so bb's own navigation is back.`,
          });
        }}
      >
        {(slot, Original) => {
          const identity = `${slot.pluginId}/${slot.id}/${slot.generation}`;
          return (
            <slot.component
              items={items}
              activeItemId={activeItemId}
              isCompactViewport={isCompactViewport}
              experimental_activate={(itemId, options) =>
                handleActivate(identity, itemId, options)
              }
              experimental_Original={Original}
            />
          );
        }}
      </PluginReplacementSlot>
    </nav>
  );
}
