/* shadcn/ui-derived */
import * as React from "react";

import {
  COARSE_POINTER_INPUT_HEIGHT_CLASS,
  COARSE_POINTER_TEXT_BASE_CLASS,
} from "./coarse-pointer-sizing.js";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex w-full rounded-md border border-input bg-transparent px-3 py-1 transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          COARSE_POINTER_INPUT_HEIGHT_CLASS,
          COARSE_POINTER_TEXT_BASE_CLASS,
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
