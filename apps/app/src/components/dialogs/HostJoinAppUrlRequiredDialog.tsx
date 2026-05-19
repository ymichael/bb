import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";

export interface HostJoinAppUrlRequiredDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HostJoinAppUrlRequiredDialog({
  open,
  onOpenChange,
}: HostJoinAppUrlRequiredDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <HostJoinAppUrlRequiredDialogContent />
      </DialogContent>
    </Dialog>
  );
}

export function HostJoinAppUrlRequiredDialogContent() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Unable to add new host</DialogTitle>
        <DialogDescription>
          You need to specify the URL that allows the new host to talk to the
          server.
        </DialogDescription>
      </DialogHeader>

      <div className="min-w-0 space-y-2 text-sm text-foreground">
        <p>Run this on the server machine, then restart bb:</p>
        <pre className="min-w-0 overflow-x-auto rounded-md border border-border bg-surface-recessed px-3 py-2 font-mono text-xs leading-5">
          <code>
            {
              "npx bb-app config BB_APP_URL http://<your-machine>.<tailnet>.ts.net:38886"
            }
          </code>
        </pre>
      </div>
    </>
  );
}
