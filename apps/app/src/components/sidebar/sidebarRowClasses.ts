export const SIDEBAR_ROW_BASE_CLASS =
  "flex w-full items-center gap-2 rounded-md pr-0 text-sm transition-colors";

export const SIDEBAR_STANDARD_ROW_PADDING_CLASS = "pl-2";

export const SIDEBAR_PROJECT_THREAD_ROW_PADDING_CLASS = "pl-8";

export const SIDEBAR_MANAGER_ROW_PADDING_CLASS = "pl-8";

export const SIDEBAR_MANAGER_CHILD_ROW_PADDING_CLASS = "pl-14";

export const SIDEBAR_MANAGER_ENV_GROUPED_CHILD_ROW_PADDING_CLASS = "pl-20";

// Nested manager renders one indent level deeper than a root manager, sharing
// the indent of a managed child so it lands inside the parent's child list.
export const SIDEBAR_NESTED_MANAGER_ROW_PADDING_CLASS = "pl-14";

// Direct child of a nested manager. Sits one indent level deeper than a root
// manager's child, matching the env sub-group indent so the depth caps cleanly
// even for 3+ level chains.
export const SIDEBAR_NESTED_MANAGER_CHILD_ROW_PADDING_CLASS = "pl-20";

export const SIDEBAR_ROW_INTERACTIVE_STATE_CLASS =
  "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

/**
 * Hairline that runs through an expanded project's thread list, sitting
 * under the center of the project chevron/folder icon. The coarse-pointer
 * variant nudges the line a few px right to follow the larger icon.
 *
 * Z-index sits between the manager (z-40) and project (z-50) sticky tiers
 * so the line paints over manager rows and ordinary thread rows (showing
 * through their hover/active backgrounds) but a stuck project row covers
 * it cleanly.
 */
export const SIDEBAR_PROJECT_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-4 before:top-0 before:z-[45] before:w-px before:bg-border-hairline before:content-[''] max-md:pointer-coarse:before:left-5";

/**
 * Hairline that runs through a manager's managed-child list, sitting under
 * the center of the manager's user icon. Z-index sits below both the
 * manager (z-40), env (z-35), and project (z-50) sticky tiers so a stuck
 * parent row covers the line, while ordinary thread rows still let it show
 * through their hover/active backgrounds.
 */
export const SIDEBAR_MANAGER_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-10 before:top-0 before:z-30 before:w-px before:bg-border-hairline before:content-['']";

/**
 * Hairline that runs through an env sub-group nested inside a manager.
 * Sits under the center of the sub-group header's worktree glyph at the
 * managed-child indent (pl-14), so the line lands at left-16. It stays below
 * the env sticky tier (z-35).
 */
export const SIDEBAR_MANAGED_ENV_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-16 before:top-0 before:z-30 before:w-px before:bg-border-hairline before:content-['']";

export const SIDEBAR_MANAGER_LINE_CONTINUATION_CLASS =
  "pointer-events-none absolute bottom-0 left-10 top-0 z-[1] w-px bg-border-hairline";

export const SIDEBAR_COLLAPSED_CHILD_COUNT_BADGE_CLASS =
  "pointer-events-none absolute -bottom-0.5 -right-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-semibold leading-none text-primary-foreground transition-opacity duration-150";

/**
 * Hairline that runs through a nested manager's child list. The nested
 * manager row sits at pl-14, so its UserRound icon center lands at left-16,
 * matching the env sub-group line. Reused for any chain of managers below
 * the first nested level since the indent caps at pl-14 for the manager row
 * itself.
 */
export const SIDEBAR_NESTED_MANAGER_GROUP_LINE_CLASS =
  "before:pointer-events-none before:absolute before:bottom-0 before:left-16 before:top-0 before:z-30 before:w-px before:bg-border-hairline before:content-['']";

// Continuation line for a nested manager group. Sits at the same x position
// as SIDEBAR_NESTED_MANAGER_GROUP_LINE_CLASS (left-16, center of the nested
// manager's UserRound icon at pl-14) so collapsed nested managers can still
// participate in their parent's vertical guide.
export const SIDEBAR_NESTED_MANAGER_LINE_CONTINUATION_CLASS =
  "pointer-events-none absolute bottom-0 left-16 top-0 z-[1] w-px bg-border-hairline";
