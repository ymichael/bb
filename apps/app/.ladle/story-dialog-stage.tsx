import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";

const noop = () => {};

interface DialogStageProps {
  className?: string;
  children: ReactNode;
}

export function DialogStage({ className, children }: DialogStageProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={noop}>
      <div
        className={cn(
          "relative grid w-full max-w-lg grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border bg-background p-6 shadow-lg",
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
