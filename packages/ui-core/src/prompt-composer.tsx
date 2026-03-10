import type { ReactNode } from "react";
import { cx } from "./utils.js";

export interface PromptComposerShellProps {
  children: ReactNode;
  statusLabel?: ReactNode;
  className?: string;
}

export function PromptComposerShell({
  children,
  statusLabel,
  className,
}: PromptComposerShellProps) {
  return (
    <div className={cx("space-y-2", className)}>
      {statusLabel ? (
        typeof statusLabel === "string" ? (
          <div className="text-xs text-muted-foreground">{statusLabel}</div>
        ) : (
          statusLabel
        )
      ) : null}
      {children}
    </div>
  );
}
