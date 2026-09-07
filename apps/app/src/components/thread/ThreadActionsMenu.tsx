import {
  ActionMenuItem,
  ActionMenuSeparator,
} from "@/components/ui/action-menu-items";
import type { Thread } from "@bb/domain";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { cn } from "@bb/shared-ui/lib/utils";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import { isThreadRead } from "@bb/client-core";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useThreadActions } from "./ThreadActionsProvider";

interface ThreadActionsMenuBaseProps {
  thread: Thread;
  onOpenInSplit?: () => void;
}

export interface ThreadActionsMenuResponsiveAction {
  icon: IconName;
  label: string;
  onSelect: () => void | Promise<void>;
}

interface ThreadActionsMenuProps extends ThreadActionsMenuBaseProps {
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
}

interface ThreadActionsContextMenuProps extends ThreadActionsMenuBaseProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

type ThreadActionsMenuSurface = "context" | "dropdown";

interface ThreadActionsMenuItemsProps extends ThreadActionsMenuBaseProps {
  responsiveActions?: readonly ThreadActionsMenuResponsiveAction[];
  surface: ThreadActionsMenuSurface;
}

function ThreadActionsMenuItems({
  thread,
  onOpenInSplit,
  responsiveActions = [],
  surface,
}: ThreadActionsMenuItemsProps) {
  const {
    archiveThreadAndChildren,
    requestRename,
    requestDelete,
    togglePin,
    toggleRead,
    unarchiveThread,
  } = useThreadActions();
  const isCompactViewport = useIsCompactViewport();
  const isDrawer = surface === "dropdown" && isCompactViewport;
  const showSeparators = !isDrawer;
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;
  const isPinned = thread.pinnedAt !== null;
  const threadUrl = new URL(
    getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id }),
    window.location.origin,
  ).toString();

  return (
    <>
      {responsiveActions.length > 0 ? (
        <>
          {responsiveActions.map((action) => (
            <ActionMenuItem
              key={action.label}
              surface={surface}
              icon={action.icon}
              onSelect={() => {
                void action.onSelect();
              }}
            >
              {action.label}
            </ActionMenuItem>
          ))}
          {showSeparators ? (
            <ActionMenuSeparator surface={surface} />
          ) : null}
        </>
      ) : null}
      {onOpenInSplit ? (
        <>
          <ActionMenuItem
            surface={surface}
            icon="Columns2"
            onSelect={() => {
              onOpenInSplit();
            }}
          >
            Open in split
          </ActionMenuItem>
          {showSeparators ? (
            <ActionMenuSeparator surface={surface} />
          ) : null}
        </>
      ) : null}
      <ActionMenuItem
        surface={surface}
        icon="Copy"
        onSelect={() => {
          void copyToClipboardWithToast(threadUrl, {
            successMessage: "Thread link copied",
            errorMessage: "Failed to copy thread link",
          });
        }}
      >
        Copy thread link
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isRead ? "Mail" : "MailOpen"}
        onSelect={() => {
          toggleRead(thread);
        }}
      >
        {isRead ? "Mark unread" : "Mark read"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon={isPinned ? "PinOff" : "Pin"}
        onSelect={() => {
          togglePin(thread);
        }}
      >
        {isPinned ? "Unpin" : "Pin"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon="Edit"
        onSelect={() => {
          window.setTimeout(() => {
            requestRename(thread);
          }, 0);
        }}
      >
        Rename
      </ActionMenuItem>
      {showSeparators ? <ActionMenuSeparator surface={surface} /> : null}
      <ActionMenuItem
        surface={surface}
        icon={isArchived ? "ArchiveRestore" : "Archive"}
        onSelect={() => {
          if (isArchived) {
            unarchiveThread(thread);
            return;
          }
          archiveThreadAndChildren(thread);
        }}
      >
        {isArchived ? "Unarchive" : "Archive"}
      </ActionMenuItem>
      <ActionMenuItem
        surface={surface}
        icon="Trash2"
        variant="destructive"
        onSelect={() => {
          window.setTimeout(() => {
            requestDelete(thread);
          }, 0);
        }}
      >
        Delete
      </ActionMenuItem>
    </>
  );
}

export function ThreadArchiveQuickAction({
  thread,
  className,
}: {
  thread: Thread;
  className?: string;
}) {
  const { archiveThreadAndChildren, unarchiveThread } = useThreadActions();
  const isArchived = thread.archivedAt != null;
  const label = isArchived ? "Unarchive" : "Archive";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("rounded-md p-0", className)}
          aria-label={`${label} thread`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isArchived) {
              unarchiveThread(thread);
              return;
            }
            archiveThreadAndChildren(thread);
          }}
        >
          <Icon
            name={isArchived ? "ArchiveRestore" : "Archive"}
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ThreadActionsMenu({
  thread,
  onOpenInSplit,
  responsiveActions,
  onOpenChange,
  triggerClassName,
}: ThreadActionsMenuProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0",
            triggerClassName,
            "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
          aria-label="Thread actions"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Icon
            name="MoreHorizontal"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          responsiveActions={responsiveActions}
          surface="dropdown"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadActionsContextMenu(props: ThreadActionsContextMenuProps) {
  const isCompactViewport = useIsCompactViewport();
  if (isCompactViewport) {
    return <ThreadActionsCompactLongPressMenu {...props} />;
  }
  return <ThreadActionsDesktopContextMenu {...props} />;
}

function ThreadActionsCompactLongPressMenu({
  children,
  thread,
  onOpenInSplit,
  onOpenChange,
}: ThreadActionsContextMenuProps) {
  return (
    <CompactLongPressMenu
      label="Thread actions"
      onOpenChange={onOpenChange}
      items={
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          surface="dropdown"
        />
      }
    >
      {children}
    </CompactLongPressMenu>
  );
}

function ThreadActionsDesktopContextMenu({
  children,
  thread,
  onOpenInSplit,
  onOpenChange,
}: ThreadActionsContextMenuProps) {
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label="Thread actions">
        <ThreadActionsMenuItems
          thread={thread}
          onOpenInSplit={onOpenInSplit}
          surface="context"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
