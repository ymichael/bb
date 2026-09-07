import * as React from "react";

import { COARSE_POINTER_TEXT_BASE_CLASS } from "./coarse-pointer-sizing.js";
import { cn } from "../../lib/utils";
import { CONTROL_HOVER_TRANSITION } from "./motion.js";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        `flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 ${CONTROL_HOVER_TRANSITION} placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50`,
        COARSE_POINTER_TEXT_BASE_CLASS,
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
