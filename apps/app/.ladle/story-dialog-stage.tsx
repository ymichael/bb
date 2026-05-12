import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "../src/lib/utils";

const noop = () => {};

export interface DialogStageProps {
  className?: string;
  children: ReactNode;
}

// Wraps a dialog's inner *Content component so it renders inline in a story
// grid instead of portal-mounting to the document body. Mirrors DialogContent's
// default desktop chrome (border + bg + p-6 + shadow + rounded, max-w-lg);
// pass `className` to override sizing/padding for dialogs that customize their
// own DialogContent (e.g. p-0 wrappers used by GitAction / EnvironmentPromotion).
// DialogPrimitive.Root supplies the Radix context required by DialogTitle /
// DialogDescription / DialogClose.
export function DialogStage({ className, children }: DialogStageProps) {
  return (
    <DialogPrimitive.Root open onOpenChange={noop}>
      <div
        className={cn(
          "grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg",
          className,
        )}
      >
        {children}
      </div>
    </DialogPrimitive.Root>
  );
}
