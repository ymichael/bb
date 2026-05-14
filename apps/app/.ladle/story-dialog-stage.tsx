import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../src/lib/utils";
import { Icon } from "../src/components/ui/icon";

const noop = () => {};

export interface DialogStageProps {
  className?: string;
  children: ReactNode;
}

// Wraps a dialog's inner *Content component so it renders inline in a story
// grid instead of portal-mounting to the document body. Mirrors DialogContent's
// default desktop chrome (border + bg + p-6 + shadow + rounded, max-w-lg) plus
// the top-right close affordance; pass `className` to override sizing/padding
// for dialogs that customize their own DialogContent (e.g. p-0 wrappers used
// by GitAction). DialogPrimitive.Root supplies the Radix context required by
// DialogTitle / DialogDescription / DialogClose.
export function DialogStage({ className, children }: DialogStageProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={noop}>
      <div
        className={cn(
          "relative grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg",
          className,
        )}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-state-active data-[state=open]:text-foreground">
          <Icon name="X" className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    </DialogPrimitive.Root>
  );
}
