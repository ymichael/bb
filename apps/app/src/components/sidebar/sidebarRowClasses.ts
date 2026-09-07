import { COARSE_POINTER_DOT_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { CONTEXT_SELECTION_SURFACE_CLASS } from "@/components/ui/context-selection";

export const SIDEBAR_ROW_BASE_CLASS =
  "flex w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors";

export const SIDEBAR_ROW_GLYPH_SLOT_CLASS =
  "inline-flex shrink-0 items-center justify-center text-subtle-foreground";

export const SIDEBAR_UNREAD_DOT_CLASS = `rounded-full bg-foreground ${COARSE_POINTER_DOT_SIZE_CLASS}`;

export const SIDEBAR_WORKING_STATUS_COLOR_CLASS = "text-muted-foreground/50";

export const SIDEBAR_SUCCESS_STATUS_COLOR_CLASS = "text-success-foreground";

export const SIDEBAR_SUCCESS_STATUS_DOT_CLASS =
  "size-[5px] rounded-full bg-muted-foreground/60 max-md:pointer-coarse:size-1.5";

const SIDEBAR_THREAD_ROW_BASE_PADDING_PX = 8;
const SIDEBAR_THREAD_ROW_DEPTH_STEP_PX = 24;
const SIDEBAR_THREAD_ROW_GLYPH_CENTER_OFFSET_PX = 8;

export const SIDEBAR_STANDARD_ROW_PADDING_CLASS = "pl-2";

export function getSidebarThreadRowPaddingLeft(depth: number): number {
  return (
    SIDEBAR_THREAD_ROW_BASE_PADDING_PX +
    depth * SIDEBAR_THREAD_ROW_DEPTH_STEP_PX
  );
}

export function getSidebarThreadGroupLineLeft(depth: number): number {
  return (
    getSidebarThreadRowPaddingLeft(depth) +
    SIDEBAR_THREAD_ROW_GLYPH_CENTER_OFFSET_PX
  );
}

export const SIDEBAR_ROW_INTERACTIVE_STATE_CLASS =
  "cursor-pointer text-sidebar-foreground/85 dark:text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

export const SIDEBAR_ROW_STATIC_STATE_CLASS =
  "text-sidebar-foreground/85 dark:text-sidebar-foreground";

export const SIDEBAR_ROW_SELECTED_STATE_CLASS = `${CONTEXT_SELECTION_SURFACE_CLASS} bb-sidebar-selected-row text-sidebar-foreground`;

export const SIDEBAR_ROW_OPEN_IN_SPLIT_STATE_CLASS =
  "bb-sidebar-open-in-split-row";

export const SIDEBAR_MORE_ACTION_TRIGGER_CLASS =
  "relative m-1 h-5 w-5 after:absolute after:left-1/2 after:top-1/2 after:h-7 after:w-7 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] max-md:pointer-coarse:m-0 max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9 max-md:pointer-coarse:after:hidden";

export const SIDEBAR_PAIRED_ACTION_LEADING_TARGET_CLASS =
  "after:-left-1 after:-right-px after:w-auto after:translate-x-0";

export const SIDEBAR_PAIRED_ACTION_TRAILING_TARGET_CLASS =
  "after:-left-px after:-right-1 after:w-auto after:translate-x-0";

export const SIDEBAR_PROJECT_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-4 before:top-0 before:z-[45] before:w-px before:bg-border-hairline before:opacity-70 before:content-[''] max-md:pointer-coarse:before:left-5";
