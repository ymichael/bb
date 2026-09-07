import type { ReactNode } from "react";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { cn } from "@bb/shared-ui/lib/utils";

const LAUNCHER_ROW_SHELL_CLASS = `group flex w-full min-w-0 items-center gap-1.5 rounded px-2 py-1.5 text-left ${LIST_HOVER_TRANSITION} focus-visible:outline-none ${COARSE_POINTER_TEXT_SM_CLASS}`;
export const LAUNCHER_ROW_BASE_CLASS = `${LAUNCHER_ROW_SHELL_CLASS} focus-visible:ring-1 focus-visible:ring-ring`;
export const LAUNCHER_ACTION_ROW_BASE_CLASS = `${LAUNCHER_ROW_SHELL_CLASS} focus-visible:bg-state-hover focus-visible:text-foreground`;
export const LAUNCHER_ROW_ICON_CLASS = `flex shrink-0 items-center justify-center overflow-hidden text-muted-foreground ${COARSE_POINTER_ICON_SIZE_CLASS}`;

const LAUNCHER_SECTION_LABEL_CLASS = CHROME_SECTION_LABEL_CLASS;

interface LauncherRowTrailingProps {
  idle: ReactNode;
  isActive: boolean;
}

export function LauncherRowTrailing({
  idle,
  isActive,
}: LauncherRowTrailingProps) {
  return (
    <span className="ml-auto flex shrink-0 items-center justify-end">
      <span
        className={cn(
          `whitespace-nowrap text-muted-foreground ${COARSE_POINTER_TEXT_SM_CLASS}`,
          isActive ? "hidden" : "group-hover:hidden",
        )}
      >
        {idle}
      </span>
      <span
        className={cn(
          `items-center gap-1 text-subtle-foreground ${COARSE_POINTER_TEXT_SM_CLASS}`,
          isActive ? "flex" : "hidden group-hover:flex",
        )}
        aria-hidden
      >
        <Icon
          name="ArrowUpRight"
          className="size-3 max-md:pointer-coarse:size-4"
          aria-hidden
        />
        open
      </span>
    </span>
  );
}

interface LauncherSectionHeaderProps {
  label: ReactNode;
  count?: number;
  action?: ReactNode;
  sticky?: boolean;
  className?: string;
}

export function LauncherSectionHeader({
  label,
  count,
  action,
  sticky = false,
  className,
}: LauncherSectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 px-2 pb-2",
        LAUNCHER_SECTION_LABEL_CLASS,
        sticky && "sticky top-0 z-10 bg-sidebar",
        className,
      )}
    >
      <span>{label}</span>
      {count !== undefined ? (
        <span
          className={cn(
            "font-mono text-muted-foreground opacity-80",
            COARSE_POINTER_TEXT_SM_CLASS,
          )}
        >
          {count}
        </span>
      ) : null}
      {action ? (
        <div className="ml-auto flex items-center">{action}</div>
      ) : null}
    </div>
  );
}
