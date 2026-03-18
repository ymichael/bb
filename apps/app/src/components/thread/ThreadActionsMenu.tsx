import type { ThreadType } from "@bb/core"
import { MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { threadTypeLabel } from "@/lib/thread-title"

interface ThreadActionsMenuProps {
  onToggleRead: () => void
  onRename: () => void
  onToggleArchive: () => void
  onDelete?: () => void
  debugToggleLabel?: string
  debugToggleChecked?: boolean
  onDebugToggleCheckedChange?: (checked: boolean) => void
  isRead: boolean
  isArchived: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  triggerClassName?: string
  align?: "start" | "center" | "end"
  threadType?: ThreadType
}

export function ThreadActionsMenu({
  onToggleRead,
  onRename,
  onToggleArchive,
  onDelete,
  debugToggleLabel,
  debugToggleChecked,
  onDebugToggleCheckedChange,
  isRead,
  isArchived,
  onOpenChange,
  disabled = false,
  triggerClassName,
  align = "end",
  threadType,
}: ThreadActionsMenuProps) {
  const label = threadTypeLabel(threadType ?? "standard")
  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1)
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "rounded-md p-0 text-muted-foreground hover:bg-accent/45 hover:text-foreground data-[state=open]:bg-accent/35 data-[state=open]:text-foreground",
            triggerClassName
          )}
          aria-label={`${capitalizedLabel} actions`}
          title={`${capitalizedLabel} actions`}
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-44">
        <DropdownMenuItem
          disabled={disabled}
          onSelect={(event) => {
            event.preventDefault()
            onToggleRead()
          }}
        >
          {isRead ? "Mark as unread" : "Mark as read"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            // Defer opening the rename dialog until Radix closes the menu.
            window.setTimeout(() => {
              onRename()
            }, 0)
          }}
        >
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={(event) => {
            event.preventDefault()
            onToggleArchive()
          }}
        >
          {isArchived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
        {onDelete ? (
          <DropdownMenuItem
            disabled={disabled}
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              window.setTimeout(() => {
                onDelete()
              }, 0)
            }}
          >
            Delete
          </DropdownMenuItem>
        ) : null}
        {debugToggleLabel && onDebugToggleCheckedChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              disabled={disabled}
              checked={debugToggleChecked}
              onCheckedChange={(checked) => {
                onDebugToggleCheckedChange(checked === true)
              }}
              onSelect={(event) => {
                event.preventDefault()
              }}
            >
              {debugToggleLabel}
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
