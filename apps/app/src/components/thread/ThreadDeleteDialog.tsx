import type { Thread } from "@bb/core"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getThreadDisplayTitle, threadTypeLabel } from "@/lib/thread-title"

interface ThreadDeleteDialogProps {
  target: Thread | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (thread: Thread) => void
}

export function ThreadDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: ThreadDeleteDialogProps) {
  const threadTitle = target ? getThreadDisplayTitle(target) : ""
  const label = target ? threadTypeLabel(target.type) : "thread"

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            Delete {label}?
          </DialogTitle>
          <DialogDescription>
            {target
              ? `Delete "${threadTitle}" and its timeline permanently? This cannot be undone.`
              : `Delete this ${label} permanently? This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || pending}
            onClick={() => {
              if (!target) return
              onDelete(target)
            }}
          >
            Delete {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
