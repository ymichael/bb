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
        <p>
          Please add this line to your{" "}
          <code className="font-mono text-xs">.env</code> file and restart bb:
        </p>
        <pre className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs leading-5">
          <code>
            BB_APP_URL=http://&lt;your-machine&gt;.&lt;tailnet&gt;.ts.net:38886
          </code>
        </pre>
      </div>
    </>
  );
}
