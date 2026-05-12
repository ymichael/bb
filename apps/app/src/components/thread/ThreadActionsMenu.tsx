import type { Thread } from "@bb/domain";
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui";
import { Button } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui";
import { cn } from "@/lib/utils";
import { threadTypeLabel } from "@/lib/thread-title";
import { isThreadRead } from "@/lib/thread-read-state";
import { useThreadActions } from "./ThreadActionsProvider";

interface ThreadActionsMenuBaseProps {
  thread: Thread;
  /**
   * Pass `false` to hide the Delete entry (e.g. sidebar rows that intentionally
   * route users to the thread detail page for destructive actions). Defaults
   * to true.
   */
  canDelete?: boolean;
  viewerToggleLabel?: string;
  viewerToggleChecked?: boolean;
  onViewerToggleCheckedChange?: (checked: boolean) => void;
}

interface ThreadActionsMenuProps extends ThreadActionsMenuBaseProps {
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}

interface ThreadActionsContextMenuProps extends ThreadActionsMenuBaseProps {
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

type ThreadActionsMenuSurface = "context" | "dropdown";
type ThreadActionsMenuCheckedState = boolean | "indeterminate";

interface ThreadActionsMenuItemsProps extends ThreadActionsMenuBaseProps {
  surface: ThreadActionsMenuSurface;
}

interface ThreadActionMenuItemProps {
  children: ReactNode;
  className?: string;
  onSelect?: (event: Event) => void;
  surface: ThreadActionsMenuSurface;
}

interface ThreadActionMenuCheckboxItemProps {
  checked?: ThreadActionsMenuCheckedState;
  children: ReactNode;
  onCheckedChange?: (checked: ThreadActionsMenuCheckedState) => void;
  onSelect?: (event: Event) => void;
  surface: ThreadActionsMenuSurface;
}

interface ThreadActionMenuSeparatorProps {
  surface: ThreadActionsMenuSurface;
}

function ThreadActionMenuItem({
  children,
  className,
  onSelect,
  surface,
}: ThreadActionMenuItemProps) {
  if (surface === "context") {
    return (
      <ContextMenuItem className={className} onSelect={onSelect}>
        {children}
      </ContextMenuItem>
    );
  }

  return (
    <DropdownMenuItem className={className} onSelect={onSelect}>
      {children}
    </DropdownMenuItem>
  );
}

function ThreadActionMenuCheckboxItem({
  checked,
  children,
  onCheckedChange,
  onSelect,
  surface,
}: ThreadActionMenuCheckboxItemProps) {
  if (surface === "context") {
    return (
      <ContextMenuCheckboxItem
        checked={checked}
        onCheckedChange={onCheckedChange}
        onSelect={onSelect}
      >
        {children}
      </ContextMenuCheckboxItem>
    );
  }

  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={onSelect}
    >
      {children}
    </DropdownMenuCheckboxItem>
  );
}

function ThreadActionMenuSeparator({
  surface,
}: ThreadActionMenuSeparatorProps) {
  if (surface === "context") {
    return <ContextMenuSeparator />;
  }

  return <DropdownMenuSeparator />;
}

function ThreadActionsMenuItems({
  thread,
  canDelete = true,
  viewerToggleLabel,
  viewerToggleChecked,
  onViewerToggleCheckedChange,
  surface,
}: ThreadActionsMenuItemsProps) {
  const { requestRename, requestDelete, toggleArchive, toggleRead } =
    useThreadActions();
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;

  return (
    <>
      <ThreadActionMenuItem
        surface={surface}
        onSelect={(event) => {
          if (surface === "dropdown") {
            event.preventDefault();
          }
          toggleRead(thread);
        }}
      >
        {isRead ? "Mark as unread" : "Mark as read"}
      </ThreadActionMenuItem>
      <ThreadActionMenuItem
        surface={surface}
        onSelect={() => {
          window.setTimeout(() => {
            requestRename(thread);
          }, 0);
        }}
      >
        Rename
      </ThreadActionMenuItem>
      <ThreadActionMenuItem
        surface={surface}
        onSelect={(event) => {
          if (surface === "dropdown") {
            event.preventDefault();
          }
          toggleArchive(thread);
        }}
      >
        {isArchived ? "Unarchive" : "Archive"}
      </ThreadActionMenuItem>
      {canDelete ? (
        <ThreadActionMenuItem
          surface={surface}
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            window.setTimeout(() => {
              requestDelete(thread);
            }, 0);
          }}
        >
          Delete
        </ThreadActionMenuItem>
      ) : null}
      {viewerToggleLabel && onViewerToggleCheckedChange ? (
        <>
          <ThreadActionMenuSeparator surface={surface} />
          <ThreadActionMenuCheckboxItem
            surface={surface}
            checked={viewerToggleChecked}
            onCheckedChange={(checked) => {
              onViewerToggleCheckedChange(checked === true);
            }}
            onSelect={(event) => {
              if (surface === "dropdown") {
                event.preventDefault();
              }
            }}
          >
            {viewerToggleLabel}
          </ThreadActionMenuCheckboxItem>
        </>
      ) : null}
    </>
  );
}

export function ThreadActionsMenu({
  thread,
  canDelete = true,
  viewerToggleLabel,
  viewerToggleChecked,
  onViewerToggleCheckedChange,
  onOpenChange,
  triggerClassName,
  align = "end",
}: ThreadActionsMenuProps) {
  const label = threadTypeLabel(thread.type);
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground",
            triggerClassName,
          )}
          aria-label={`${capitalizedLabel} actions`}
          title={`${capitalizedLabel} actions`}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <MoreHorizontal className={COARSE_POINTER_ICON_SIZE_CLASS} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <ThreadActionsMenuItems
          thread={thread}
          canDelete={canDelete}
          viewerToggleLabel={viewerToggleLabel}
          viewerToggleChecked={viewerToggleChecked}
          onViewerToggleCheckedChange={onViewerToggleCheckedChange}
          surface="dropdown"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThreadActionsContextMenu({
  children,
  thread,
  canDelete = true,
  viewerToggleLabel,
  viewerToggleChecked,
  onViewerToggleCheckedChange,
  onOpenChange,
}: ThreadActionsContextMenuProps) {
  const label = threadTypeLabel(thread.type);
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${capitalizedLabel} actions`}
        className="w-44"
      >
        <ThreadActionsMenuItems
          thread={thread}
          canDelete={canDelete}
          viewerToggleLabel={viewerToggleLabel}
          viewerToggleChecked={viewerToggleChecked}
          onViewerToggleCheckedChange={onViewerToggleCheckedChange}
          surface="context"
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
