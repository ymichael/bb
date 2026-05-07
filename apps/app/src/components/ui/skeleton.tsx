/* shadcn/ui-derived */
import type { HTMLAttributes } from "react";
import { cn } from "./cn.js";

export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props}
    />
  );
}
