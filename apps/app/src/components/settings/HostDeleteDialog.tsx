import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export interface HostDeleteDialogTarget {
  id: string
  name: string
}

interface HostDeleteDialogProps {
  target: HostDeleteDialogTarget | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onDelete: (hostId: string) => void
}

export function HostDeleteDialog({
  target,
  pending,
  onOpenChange,
  onDelete,
}: HostDeleteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove host?</DialogTitle>
          <DialogDescription>
            {target
              ? `Remove "${target.name}" and all of its project sources? This cannot be undone.`
              : "Remove this host? This cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || pending}
            onClick={() => {
              if (!target) return
              onDelete(target.id)
            }}
          >
            Remove host
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
