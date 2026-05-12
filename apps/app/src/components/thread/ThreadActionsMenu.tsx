import type { Thread } from "@bb/domain";
import { MoreHorizontal } from "lucide-react";
import {
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

interface ThreadActionsMenuProps {
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}

export function ThreadActionsMenu({
  thread,
  canDelete = true,
  viewerToggleLabel,
  viewerToggleChecked,
  onViewerToggleCheckedChange,
  open,
  onOpenChange,
  triggerClassName,
  align = "end",
}: ThreadActionsMenuProps) {
  const { requestRename, requestDelete, toggleArchive, toggleRead } =
    useThreadActions();
  const label = threadTypeLabel(thread.type);
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  const isRead = isThreadRead(thread);
  const isArchived = thread.archivedAt != null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
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
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleRead(thread);
          }}
        >
          {isRead ? "Mark as unread" : "Mark as read"}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            window.setTimeout(() => {
              requestRename(thread);
            }, 0);
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleArchive(thread);
          }}
        >
          {isArchived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
        {canDelete ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              window.setTimeout(() => {
                requestDelete(thread);
              }, 0);
            }}
          >
            Delete
          </DropdownMenuItem>
        ) : null}
        {viewerToggleLabel && onViewerToggleCheckedChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={viewerToggleChecked}
              onCheckedChange={(checked) => {
                onViewerToggleCheckedChange(checked === true);
              }}
              onSelect={(event) => {
                event.preventDefault();
              }}
            >
              {viewerToggleLabel}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
