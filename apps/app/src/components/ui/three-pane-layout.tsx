import type { ReactNode } from "react";
import { cx } from "./utils.js";

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
      className={cx(
        "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]",
        className,
      )}
    >
      <div className={cx("min-w-0", mainClassName)}>{main}</div>
      {right ? (
        <aside className={cx("min-w-0", rightClassName)}>{right}</aside>
      ) : null}
    </section>
  );
}
