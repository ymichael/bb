import { useState } from "react";
import { Button } from "./button";
import {
  MobileTrigger,
  ResponsiveDrawerShell,
  useResponsiveRoot,
} from "./responsive-overlay";

export default {
  title: "Primitives/ResponsiveOverlay",
};

export function MobileTriggerStates() {
  return (
    <div className="flex max-w-2xl flex-wrap items-center gap-3 p-6">
      <MobileTrigger
        open={false}
        onOpenChange={ignoreOpenChange}
        haspopup="menu"
      >
        Closed menu
      </MobileTrigger>
      <MobileTrigger
        open={true}
        onOpenChange={ignoreOpenChange}
        haspopup="dialog"
      >
        Open dialog
      </MobileTrigger>
      <MobileTrigger
        asChild
        open={true}
        onOpenChange={ignoreOpenChange}
        haspopup="menu"
      >
        <Button variant="outline">As child</Button>
      </MobileTrigger>
    </div>
  );
}

export function RootDrivenDrawerShell() {
  return <ResponsiveRootDemo />;
}

function ResponsiveRootDemo() {
  const [open, setOpen] = useState(true);
  const root = useResponsiveRoot(open, setOpen);

  return (
    <div className="min-h-[24rem] p-6">
      <MobileTrigger
        open={root.open}
        onOpenChange={root.onOpenChange}
        haspopup="dialog"
      >
        Runtime details
      </MobileTrigger>
      <ResponsiveDrawerShell
        open={root.open}
        onOpenChange={root.onOpenChange}
        srLabel="Runtime details"
      >
        <div className="grid gap-4 px-4 pb-6 pt-2">
          <div className="grid gap-1">
            <h3 className="text-base font-semibold">Runtime details</h3>
            <p className="text-sm text-muted-foreground">
              Local execution is ready for a new browser session.
            </p>
          </div>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-4 rounded-md border border-border p-3">
              <dt className="text-muted-foreground">Breakpoint</dt>
              <dd>{root.isMobile ? "mobile" : "desktop"}</dd>
            </div>
            <div className="flex justify-between gap-4 rounded-md border border-border p-3">
              <dt className="text-muted-foreground">State</dt>
              <dd>{root.open ? "open" : "closed"}</dd>
            </div>
          </dl>
        </div>
      </ResponsiveDrawerShell>
    </div>
  );
}

function ignoreOpenChange(_open: boolean): void {}
