import type { Thread } from "@bb/domain"
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
import { threadTypeLabel } from "@/lib/thread-title"

interface ThreadArchiveConfirmationDialogProps {
  target: Thread | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onArchive: (thread: Thread) => void
}

export function ThreadArchiveConfirmationDialog({
  target,
  pending,
  onOpenChange,
  onArchive,
}: ThreadArchiveConfirmationDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" />
            Archive and clean up workspace?
          </DialogTitle>
          <DialogDescription>
            This {target ? threadTypeLabel(target.type) : "thread"} has uncommitted or unmerged
            work in its worktree. Archiving will remove that workspace and changes may be lost.
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
              onArchive(target)
            }}
          >
            Archive anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
