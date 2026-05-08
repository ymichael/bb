import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ThreePaneLayoutProps {
  main: ReactNode;
  right?: ReactNode;
  className?: string;
  mainClassName?: string;
  rightClassName?: string;
}

export function ThreePaneLayout({
  main,
  right,
  className,
  mainClassName,
  rightClassName,
}: ThreePaneLayoutProps) {
  return (
    <section
      className={cn(
        "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]",
        className,
      )}
    >
      <div className={cn("min-w-0", mainClassName)}>{main}</div>
      {right ? (
        <aside className={cn("min-w-0", rightClassName)}>{right}</aside>
      ) : null}
    </section>
  );
}
