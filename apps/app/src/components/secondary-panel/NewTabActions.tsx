import { useCallback, useMemo, type ReactNode } from "react";
import { useAtom } from "jotai";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { useAppCommandShortcut } from "@/components/commands/AppCommandProvider";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import type { PluginPanelActionEntry } from "@/components/plugin/PluginPanelActions";
import { useSidebarSortable } from "@/components/sidebar/sortableMotion";
import { useReorderDnd } from "@/components/ui/useReorderDnd";
import { isDesktopBrowserAvailable } from "@/lib/bb-desktop";
import { arrangeByStoredOrder, reorderStoredOrder } from "@/lib/stored-order";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import {
  LAUNCHER_ACTION_ROW_BASE_CLASS,
  LAUNCHER_ROW_ICON_CLASS,
  LauncherSectionHeader,
} from "./launcherRow";
import { newTabActionOrderAtom } from "./newTabActionsAtoms";

export type OpenBrowserHandler = () => void;
export type StartTerminalHandler = () => void;

export interface NewTabActionsProps {
  onOpenBrowser?: OpenBrowserHandler;
  onStartTerminal?: StartTerminalHandler;
  startTerminalDisabled?: boolean;
  startTerminalTrailing?: ReactNode;
  pluginActions?: readonly PluginPanelActionEntry[];
}

interface NewTabAction {
  id: string;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  shortcut: AppShortcutPresentation | null;
  trailing: ReactNode;
  onSelect: () => void;
}

interface NewTabActionListProps {
  actions: readonly NewTabAction[];
}

interface SortableNewTabActionRowProps {
  action: NewTabAction;
}

interface ReorderableNewTabActionListProps {
  actions: readonly NewTabAction[];
  normalizedOrder: readonly string[];
  onOrderChange: (order: string[]) => void;
}

interface NewTabActionRowProps {
  action: NewTabAction;
  dragHandle?: ReactNode;
}

const ACTIONS_SECTION_LABEL = "Actions";
const NEW_TAB_ACTION_DRAG_HANDLE_CLASS =
  "cursor-grab touch-none opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing group-hover:opacity-100 [@media(hover:none)]:opacity-100";
const OPEN_BROWSER_ACTION_ID = "file-search-result-open-browser";
const START_TERMINAL_ACTION_ID = "file-search-result-start-terminal";

function actionIcon(iconName: IconName): ReactNode {
  return (
    <Icon
      name={iconName}
      className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
      aria-hidden
    />
  );
}

export function NewTabActions({
  onOpenBrowser,
  onStartTerminal,
  pluginActions,
  startTerminalDisabled = false,
  startTerminalTrailing,
}: NewTabActionsProps) {
  const terminalShortcut = useAppCommandShortcut("terminal.open");
  const showOpenBrowser =
    onOpenBrowser !== undefined && isDesktopBrowserAvailable();

  const actions: NewTabAction[] = [];
  if (showOpenBrowser) {
    actions.push({
      id: OPEN_BROWSER_ACTION_ID,
      icon: actionIcon("Globe"),
      label: "Open browser",
      disabled: false,
      shortcut: null,
      trailing: null,
      onSelect: () => onOpenBrowser?.(),
    });
  }
  if (onStartTerminal !== undefined) {
    actions.push({
      id: START_TERMINAL_ACTION_ID,
      icon: actionIcon("Terminal"),
      label: "Start terminal",
      disabled: startTerminalDisabled,
      shortcut: terminalShortcut,
      trailing: startTerminalTrailing ?? null,
      onSelect: () => onStartTerminal(),
    });
  }
  for (const action of pluginActions ?? []) {
    actions.push({
      id: action.id,
      icon: (
        <PluginIcon
          pluginId={action.pluginId}
          icon={action.icon}
          className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
        />
      ),
      label: action.title,
      disabled: false,
      shortcut: null,
      trailing: null,
      onSelect: action.onSelect,
    });
  }

  if (actions.length === 0) {
    return null;
  }

  return (
    <div data-testid="new-tab-actions" className="flex min-w-0 flex-col">
      <section>
        <LauncherSectionHeader label={ACTIONS_SECTION_LABEL} className="pb-1" />
        <NewTabActionList actions={actions} />
      </section>
    </div>
  );
}

function NewTabActionList({ actions }: NewTabActionListProps) {
  const [storedOrder, setStoredOrder] = useAtom(newTabActionOrderAtom);
  const { ordered, normalizedOrder } = useMemo(
    () =>
      arrangeByStoredOrder({
        items: actions.map((action) => action.id),
        getId: (id) => id,
        storedOrder,
      }),
    [actions, storedOrder],
  );
  const orderedActions = useMemo(() => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return ordered.flatMap((id) => {
      const action = byId.get(id);
      return action ? [action] : [];
    });
  }, [actions, ordered]);

  if (orderedActions.length < 2) {
    return (
      <div className="flex flex-col gap-px">
        {orderedActions.map((action) => (
          <NewTabActionRow key={action.id} action={action} />
        ))}
      </div>
    );
  }

  return (
    <ReorderableNewTabActionList
      actions={orderedActions}
      normalizedOrder={normalizedOrder}
      onOrderChange={setStoredOrder}
    />
  );
}

function ReorderableNewTabActionList({
  actions,
  normalizedOrder,
  onOrderChange,
}: ReorderableNewTabActionListProps) {
  const orderedIds = useMemo(
    () => actions.map((action) => action.id),
    [actions],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (
        !event.over ||
        typeof event.active.id !== "string" ||
        typeof event.over.id !== "string"
      ) {
        return;
      }
      const nextOrder = reorderStoredOrder({
        activeId: event.active.id,
        overId: event.over.id,
        order: normalizedOrder,
        visibleIds: orderedIds,
      });
      if (nextOrder) onOrderChange(nextOrder);
    },
    [normalizedOrder, onOrderChange, orderedIds],
  );
  const { dndContextProps, onClickCapture } = useReorderDnd({
    onDragEnd: handleDragEnd,
  });

  return (
    <DndContext {...dndContextProps}>
      <SortableContext
        items={orderedIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex flex-col gap-px" onClickCapture={onClickCapture}>
          {actions.map((action) => (
            <SortableNewTabActionRow key={action.id} action={action} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableNewTabActionRow({ action }: SortableNewTabActionRowProps) {
  const { dragBindings, setNodeRef, style } = useSidebarSortable({
    id: action.id,
    disabled: false,
  });
  const { attributes, listeners, setActivatorNodeRef } = dragBindings;

  return (
    <div ref={setNodeRef} style={style}>
      <NewTabActionRow
        action={action}
        dragHandle={
          <button
            type="button"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${action.label}`}
            className={cn(
              LAUNCHER_ROW_ICON_CLASS,
              NEW_TAB_ACTION_DRAG_HANDLE_CLASS,
            )}
            {...attributes}
            {...listeners}
          >
            <Icon
              name="DragDropVertical"
              className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              aria-hidden
            />
          </button>
        }
      />
    </div>
  );
}

function NewTabActionRow({ action, dragHandle }: NewTabActionRowProps) {
  return (
    <div
      className={cn(
        LAUNCHER_ACTION_ROW_BASE_CLASS,
        "relative scroll-mt-7 focus-within:bg-state-hover focus-within:text-foreground",
        !action.disabled && "hover:bg-state-hover",
      )}
    >
      <button
        type="button"
        id={action.id}
        aria-keyshortcuts={action.shortcut?.ariaKeyshortcuts}
        disabled={action.disabled}
        onClick={action.onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none disabled:cursor-default"
      >
        <span className={LAUNCHER_ROW_ICON_CLASS}>{action.icon}</span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {action.label}
        </span>
      </button>
      <AppCommandShortcutHint shortcut={action.shortcut} />
      {dragHandle}
      {action.trailing !== null ? (
        <div className="flex min-w-0 shrink-0 items-center">
          {action.trailing}
        </div>
      ) : null}
    </div>
  );
}
