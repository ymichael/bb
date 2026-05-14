export const SIDEBAR_ROW_BASE_CLASS =
  "flex w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors";

export const SIDEBAR_STANDARD_ROW_PADDING_CLASS = "pl-2";

export const SIDEBAR_PROJECT_THREAD_ROW_PADDING_CLASS = "pl-8";

export const SIDEBAR_MANAGER_ROW_PADDING_CLASS = "pl-8";

export const SIDEBAR_MANAGER_CHILD_ROW_PADDING_CLASS = "pl-14";

export const SIDEBAR_ROW_INTERACTIVE_STATE_CLASS =
  "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

/**
 * Hairline that runs through an expanded project's thread list, sitting
 * under the center of the project chevron/folder icon. The coarse-pointer
 * variant nudges the line a few px right to follow the larger icon.
 *
 * The line uses `z-50` so it draws on top of manager-row and selected-row
 * backgrounds (which would otherwise occlude a behind-row line); at 1px
 * wide it never overlaps row text, which starts at pl-8 / pl-14.
 */
export const SIDEBAR_PROJECT_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-4 before:top-0 before:z-50 before:w-px before:bg-sidebar-foreground/15 before:content-[''] max-md:pointer-coarse:before:left-5";

/**
 * Hairline that runs through a manager's managed-child list, sitting under
 * the center of the manager's user icon. Same z-50 trick as the project
 * line so it stays visible behind active/hover row backgrounds.
 */
export const SIDEBAR_MANAGER_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-10 before:top-0 before:z-50 before:w-px before:bg-sidebar-foreground/15 before:content-['']";
