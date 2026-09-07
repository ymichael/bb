import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import type { TerminalLinkTarget } from "./terminal-links";

interface TerminalLinkOpenDialogProps {
  onConfirm: (target: TerminalLinkTarget) => void;
  onOpenChange: (open: boolean) => void;
  target: TerminalLinkTarget | null;
}

export function TerminalLinkOpenDialog({
  onConfirm,
  onOpenChange,
  target,
}: TerminalLinkOpenDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {target ? (
          <>
            <DialogHeader>
              <DialogTitle>Open terminal link?</DialogTitle>
              <DialogDescription>
                Terminal output can disguise a link destination. Check the
                address before opening it.
              </DialogDescription>
            </DialogHeader>
            <div
              aria-label="Link target"
              className="max-h-40 overflow-y-auto break-all rounded-md border bg-muted/40 p-3 font-mono text-xs text-foreground"
            >
              {target.uri}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="button" onClick={() => onConfirm(target)}>
                Open
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
