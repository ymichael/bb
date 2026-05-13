import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type {
  ThreadRuntimeDisplayStatus,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  BranchPicker,
  getMergeBaseBranchCandidates,
} from "@/components/pickers/BranchPicker";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  renderChangeSummary,
  toChangeTally,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon.js";

export interface ContextBannerMergeBaseConfig {
  branch: string;
  options?: readonly string[];
  optionsLoading?: boolean;
  onChange: (branch: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
}

export interface ThreadPromptTodoSection {
  pendingTodos: ThreadTimelinePendingTodos;
}

export interface ThreadPromptGitSection {
  changedFiles: WorkspaceChangedFilesSection;
  mergeBase: ContextBannerMergeBaseConfig | null;
  onPromptBannerFileClick: (selection: WorkspaceChangedFileSelection) => void;
}

/**
 * Local mirror of the planned managed-by data lane (see
 * plans/thread-prompt-context-banner.md). Promoted to a shared contract once
 * the manager slice lands and a real manager-thread reference is wired in.
 *
 * The segment is non-interactive aside from navigation: the manager name is
 * a link to the manager thread and there is no expanded body.
 */
export interface ThreadPromptManagedBySection {
  managerName: string;
  href: string;
}

/**
 * Single managed child surfaced in the manager thread's context banner. The
 * caller is responsible for filtering down to active children — the banner
 * just renders what it's given.
 */
export interface ThreadPromptManagerChildItem {
  id: string;
  title: string;
  href: string;
}

export interface ThreadPromptManagerChildrenSection {
  items: readonly ThreadPromptManagerChildItem[];
}

/**
 * Archived-state segment for the banner. When present, the banner renders
 * only this row — archived threads are read-only, so suppressing the other
 * sections keeps the surface focused on "you are looking at a frozen thread".
 */
export interface ThreadPromptArchivedSection {
  archivedAt: number;
}

/**
 * Runtime statuses that count as "active managed work" for the banner's
 * children section. These are the children the banner surfaces and (when the
 * bulk-stop slice lands) the children `Stop all` will target. Keep the set in
 * one place so future status additions don't drift across callers.
 */
export const THREAD_BANNER_ACTIVE_MANAGED_RUNTIME_STATUSES: ReadonlySet<ThreadRuntimeDisplayStatus> =
  new Set(["active", "host-reconnecting", "waiting-for-host"]);

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return THREAD_BANNER_ACTIVE_MANAGED_RUNTIME_STATUSES.has(status);
}

export type ThreadPromptContextBannerExpandedSection =
  | "todos"
  | "git"
  | "managedBy"
  | "managerChildren";

/**
 * Pixel height of the banner's collapsed (single-row) state. Pinned via the
 * outer PromptStackCard's `min-height` so the height is a contract, not a
 * computed coincidence of text size + paddings + border. Imported by
 * FollowUpPromptBox to derive its elastic textarea target — keeping both
 * sides on the same constant means tweaking banner chrome only requires
 * updating this number in one place.
 */
export const THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT = 32;

export interface ThreadPromptContextBannerProps {
  todoSection: ThreadPromptTodoSection | null;
  gitSection: ThreadPromptGitSection | null;
  /**
   * True while the workspace status query for this thread is in flight. Holds
   * banner rendering until the result settles so first paint is the final
   * form — without this, managedBy would render inline then collapse to its
   * icon-only sibling form when git pills arrive.
   */
  gitSectionPending: boolean;
  /**
   * When set, the banner renders the "Thread is archived" row and suppresses
   * todos, git, and manager-children — those represent live work that no
   * longer applies. managedBy still renders alongside if provided, since the
   * manager relationship remains relevant context for a frozen thread.
   */
  archivedSection: ThreadPromptArchivedSection | null;
  managedBySection: ThreadPromptManagedBySection | null;
  managerChildrenSection: ThreadPromptManagerChildrenSection | null;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

const KIND_PREFIX: Record<WorkspaceChangedFilesSection["kind"], string> = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
};

// Stable ids for aria-controls / aria-labelledby pairing between each
// section's toggle button and its expanded body region.
const SECTION_IDS = {
  managedBy: {
    toggle: "thread-prompt-banner-managed-by-toggle",
    body: "thread-prompt-banner-managed-by-body",
  },
  managerChildren: {
    toggle: "thread-prompt-banner-manager-children-toggle",
    body: "thread-prompt-banner-manager-children-body",
  },
  todos: {
    toggle: "thread-prompt-banner-todos-toggle",
    body: "thread-prompt-banner-todos-body",
  },
  git: {
    toggle: "thread-prompt-banner-git-toggle",
    body: "thread-prompt-banner-git-body",
  },
} as const;

const STATUS_SORT_RANK: Record<ThreadTimelinePendingTodoItemStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function hasObservedTodoItems(
  pendingTodos: ThreadTimelinePendingTodos,
): boolean {
  return pendingTodos.items.length > 0;
}

function renderTodoCounts(
  items: readonly ThreadTimelinePendingTodoItem[],
): ReactNode {
  if (items.length === 0) return null;
  let completedCount = 0;
  for (const item of items) {
    if (item.status === "completed") completedCount += 1;
  }
  if (completedCount === 0) {
    return `${items.length}`;
  }
  return `${completedCount}/${items.length}`;
}

/**
 * L-shape "managed child" indicator. Mirrors the sidebar's
 * `ManagedChildChevron` (a 45°-rotated `ChevronDown`) so the banner uses the
 * same visual idiom for managed-children context.
 */
function ManagedChildIcon({ className }: { className?: string }) {
  return (
    <Icon
      name="ChevronDown"
      className={cn("size-3.5 shrink-0 rotate-45", className)}
      aria-hidden="true"
    />
  );
}

function SectionToggleButton({
  id,
  controlsId,
  ariaLabel,
  icon,
  label,
  isExpanded,
  onToggle,
}: {
  id: string;
  controlsId: string;
  ariaLabel?: string;
  icon: ReactNode;
  label: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "flex min-w-0 items-center rounded px-1 py-0.5 text-xs transition-colors hover:bg-state-hover",
        // When a label sits between the icon and the chevron we space the row
        // for legibility (6px). With no label the chevron sits right after the
        // icon — the icons' own internal padding provides enough separation,
        // and a gap here makes the pair look untethered.
        label !== null && label !== undefined ? "gap-1.5" : "gap-0",
        isExpanded ? "text-foreground/90" : "text-muted-foreground",
      )}
    >
      {icon}
      {label !== null && label !== undefined ? (
        <span className="min-w-0 truncate">{label}</span>
      ) : null}
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200",
          isExpanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function TodoStatusIcon({
  status,
}: {
  status: ThreadTimelinePendingTodoItemStatus;
}) {
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "in_progress":
      return (
        <Icon
          name="Square"
          className={cn(className, "fill-current text-muted-foreground/30")}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <Icon
          name="Check"
          className={cn(className, "text-muted-foreground/60")}
          aria-hidden="true"
        />
      );
    case "pending":
      return (
        <Icon
          name="Square"
          className={cn(className, "text-muted-foreground/45")}
          aria-hidden="true"
        />
      );
  }
}

function TodoBody({
  items,
}: {
  items: readonly ThreadTimelinePendingTodoItem[];
}) {
  const ordered = [...items].sort(
    (a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status],
  );
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
      {ordered.map((item) => (
        <li
          key={item.id}
          className="flex min-w-0 items-center gap-2 py-0.5 text-xs"
        >
          <TodoStatusIcon status={item.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              item.status === "in_progress" && "font-medium text-foreground/90",
              item.status === "pending" && "text-foreground/85",
              item.status === "completed" &&
                "text-muted-foreground/70 line-through decoration-muted-foreground/40",
            )}
            title={item.text}
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ManagedByBody({
  managerName,
  href,
}: {
  managerName: string;
  href: string;
}) {
  return (
    <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
      This thread is managed by{" "}
      <NavLink
        to={href}
        className="text-foreground/90 underline-offset-2 hover:underline"
      >
        {managerName}
      </NavLink>
      .
    </div>
  );
}

function ManagerChildrenBody({
  items,
}: {
  items: readonly ThreadPromptManagerChildItem[];
}) {
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto px-3 pb-2 pt-1.5">
      {items.map((item) => (
        <li key={item.id} className="text-xs">
          <NavLink
            to={item.href}
            title={item.title}
            className="flex min-w-0 items-center gap-2 py-0.5 text-foreground/90 underline-offset-2 hover:underline"
          >
            <ManagedChildIcon className="text-muted-foreground/60 no-underline" />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function AnimatedBody({
  id,
  labelledBy,
  isExpanded,
  children,
}: {
  id: string;
  labelledBy: string;
  isExpanded: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!isExpanded}
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
        isExpanded
          ? "grid-rows-[1fr] border-t border-border/40 opacity-100"
          : "pointer-events-none grid-rows-[0fr] border-t border-transparent opacity-0",
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </section>
  );
}

/**
 * Single rounded strip rendered above the FollowUp prompt input. Hosts the
 * thread's high-signal context as inline section toggles (TODO, git) plus
 * the merge-base picker pinned to the right. Only one section can be
 * expanded at a time; the caller owns expandedSection state. See
 * plans/thread-prompt-context-banner.md.
 */
export function ThreadPromptContextBanner({
  todoSection,
  gitSection,
  gitSectionPending,
  archivedSection,
  managedBySection,
  managerChildrenSection,
  expandedSection,
  onToggleSection,
}: ThreadPromptContextBannerProps) {
  if (gitSectionPending) {
    return null;
  }
  if (archivedSection) {
    const isManagedByExpandedInArchived =
      expandedSection === "managedBy" && managedBySection !== null;
    return (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className="overflow-hidden"
        style={{ minHeight: THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT }}
      >
        <div className="flex items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground">
          {managedBySection ? (
            <SectionToggleButton
              id={SECTION_IDS.managedBy.toggle}
              controlsId={SECTION_IDS.managedBy.body}
              ariaLabel={`Managed by ${managedBySection.managerName}`}
              icon={
                <Icon
                  name="UserRound"
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
              }
              label={null}
              isExpanded={isManagedByExpandedInArchived}
              onToggle={() => onToggleSection("managedBy")}
            />
          ) : null}
          <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
            <Icon
              name="Archive"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">Thread is archived</span>
          </div>
        </div>
        {managedBySection ? (
          <AnimatedBody
            id={SECTION_IDS.managedBy.body}
            labelledBy={SECTION_IDS.managedBy.toggle}
            isExpanded={isManagedByExpandedInArchived}
          >
            <ManagedByBody
              managerName={managedBySection.managerName}
              href={managedBySection.href}
            />
          </AnimatedBody>
        ) : null}
      </PromptStackCard>
    );
  }
  const showTodo =
    todoSection !== null && hasObservedTodoItems(todoSection.pendingTodos);
  const showGit = gitSection !== null;
  const showManagedBy = managedBySection !== null;
  const showManagerChildren =
    managerChildrenSection !== null && managerChildrenSection.items.length > 0;
  if (!showTodo && !showGit && !showManagedBy && !showManagerChildren) {
    return null;
  }
  const todoItems =
    showTodo && todoSection ? todoSection.pendingTodos.items : [];
  const isTodoExpanded = expandedSection === "todos" && showTodo;
  // selectWorkspaceChangedFilesSection only emits a section when files exist,
  // so showGit implies a non-empty file list.
  const isGitExpanded = expandedSection === "git" && showGit;
  const isManagedByExpanded = expandedSection === "managedBy" && showManagedBy;
  const isManagerChildrenExpanded =
    expandedSection === "managerChildren" && showManagerChildren;

  const gitSummary: ReactNode = showGit ? (
    <>
      {showTodo ? null : <>{KIND_PREFIX[gitSection.changedFiles.kind]} · </>}
      {renderChangeSummary(toChangeTally(gitSection.changedFiles.stats))}
    </>
  ) : null;

  const mergeBaseCandidates =
    showGit && gitSection.mergeBase
      ? getMergeBaseBranchCandidates({
          mergeBaseBranch: gitSection.mergeBase.branch,
          mergeBaseBranchOptions: gitSection.mergeBase.options,
        })
      : [];

  // When the managed-by segment is the only item in the banner, render it
  // inline as "Managed by <name>" with the name as a link. There's no other
  // context to compete for the row, so the icon-only toggle would be a strict
  // downgrade in legibility.
  const isManagedByOnly =
    showManagedBy && !showTodo && !showGit && !showManagerChildren;

  return (
    <PromptStackCard
      ariaLabel="Thread context before sending"
      className="overflow-hidden"
      style={{ minHeight: THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT }}
    >
      <div className="flex items-center gap-0.5 px-2 py-1 text-xs text-muted-foreground">
        {showManagedBy && managedBySection && isManagedByOnly ? (
          <div className="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
            <Icon
              name="UserRound"
              className="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">
              Managed by{" "}
              <NavLink
                to={managedBySection.href}
                className="text-foreground/90 underline underline-offset-2"
              >
                {managedBySection.managerName}
              </NavLink>
            </span>
          </div>
        ) : null}
        {showManagedBy && managedBySection && !isManagedByOnly ? (
          <SectionToggleButton
            id={SECTION_IDS.managedBy.toggle}
            controlsId={SECTION_IDS.managedBy.body}
            ariaLabel={`Managed by ${managedBySection.managerName}`}
            icon={
              <Icon
                name="UserRound"
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            }
            label={null}
            isExpanded={isManagedByExpanded}
            onToggle={() => onToggleSection("managedBy")}
          />
        ) : null}
        {showManagerChildren && managerChildrenSection ? (
          <SectionToggleButton
            id={SECTION_IDS.managerChildren.toggle}
            controlsId={SECTION_IDS.managerChildren.body}
            icon={
              <Icon
                name="CircleDashed"
                className="size-3.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
            }
            label={`${managerChildrenSection.items.length} active managed ${
              managerChildrenSection.items.length === 1 ? "thread" : "threads"
            }`}
            isExpanded={isManagerChildrenExpanded}
            onToggle={() => onToggleSection("managerChildren")}
          />
        ) : null}
        {showTodo ? (
          <SectionToggleButton
            id={SECTION_IDS.todos.toggle}
            controlsId={SECTION_IDS.todos.body}
            icon={
              <Icon
                name="ListTodo"
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            }
            label={renderTodoCounts(todoItems)}
            isExpanded={isTodoExpanded}
            onToggle={() => onToggleSection("todos")}
          />
        ) : null}
        {showGit && gitSummary ? (
          <SectionToggleButton
            id={SECTION_IDS.git.toggle}
            controlsId={SECTION_IDS.git.body}
            icon={
              <Icon
                name="FileDiff"
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            }
            label={gitSummary}
            isExpanded={isGitExpanded}
            onToggle={() => onToggleSection("git")}
          />
        ) : null}
        {showGit && gitSection.mergeBase ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground/90">
            <span className="shrink-0">Merge base:</span>
            <BranchPicker
              value={gitSection.mergeBase.branch}
              options={mergeBaseCandidates}
              variant="minimal"
              loading={gitSection.mergeBase.optionsLoading}
              onChange={gitSection.mergeBase.onChange}
              onOpenChange={gitSection.mergeBase.onPickerOpenChange}
              className="max-w-[10rem]"
              muted
              popoverAlign="end"
            />
          </div>
        ) : null}
      </div>
      {showManagedBy && managedBySection && !isManagedByOnly ? (
        <AnimatedBody
          id={SECTION_IDS.managedBy.body}
          labelledBy={SECTION_IDS.managedBy.toggle}
          isExpanded={isManagedByExpanded}
        >
          <ManagedByBody
            managerName={managedBySection.managerName}
            href={managedBySection.href}
          />
        </AnimatedBody>
      ) : null}
      {showManagerChildren && managerChildrenSection ? (
        <AnimatedBody
          id={SECTION_IDS.managerChildren.body}
          labelledBy={SECTION_IDS.managerChildren.toggle}
          isExpanded={isManagerChildrenExpanded}
        >
          <ManagerChildrenBody items={managerChildrenSection.items} />
        </AnimatedBody>
      ) : null}
      {showTodo ? (
        <AnimatedBody
          id={SECTION_IDS.todos.body}
          labelledBy={SECTION_IDS.todos.toggle}
          isExpanded={isTodoExpanded}
        >
          <TodoBody items={todoItems} />
        </AnimatedBody>
      ) : null}
      {showGit ? (
        <AnimatedBody
          id={SECTION_IDS.git.body}
          labelledBy={SECTION_IDS.git.toggle}
          isExpanded={isGitExpanded}
        >
          <div className="px-3 pb-2 pt-1">
            <WorkspaceChangesList
              files={gitSection.changedFiles.files}
              onFileClick={(file) =>
                gitSection.onPromptBannerFileClick({
                  file,
                  section: gitSection.changedFiles,
                })
              }
            />
          </div>
        </AnimatedBody>
      ) : null}
    </PromptStackCard>
  );
}
