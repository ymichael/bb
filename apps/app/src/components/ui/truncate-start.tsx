import type { HTMLAttributes } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

interface TruncateStartProps extends HTMLAttributes<HTMLSpanElement> {
  children: string;
}

export function TruncateStart({
  children,
  className,
  ...props
}: TruncateStartProps) {
  return (
    <span
      {...props}
      dir="rtl"
      className={cn("block w-min max-w-full truncate", className)}
    >
      {`‎${children}`}
    </span>
  );
}
