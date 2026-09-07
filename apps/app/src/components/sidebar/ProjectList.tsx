import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type {
  ProjectResponse,
  ThreadSectionResponse,
} from "@bb/server-contract";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type ThreadListEntry,
} from "@bb/domain";
import { useRouteState } from "@/hooks/useRouteState";
import {
  useConnectionAwareQueryState,
  type ConnectionAwareQueryStatus,
} from "@/hooks/queries/connection-aware-query-state";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useReorderPinnedThread } from "@/hooks/mutations/thread-state-mutations";
import {
  useCreateThreadSection,
  useDeleteThreadSection,
  useUpdateThreadSection,
} from "@/hooks/mutations/thread-section-mutations";
import {
  isHostPathMissing,
  useHostPathExistence,
} from "@/hooks/queries/host-path-queries";
import { useHosts, usePrimaryHost } from "@/hooks/queries/host-queries";
import { useDialogState } from "@/hooks/useDialogState";
import { usePromptDraftInputThreadIds } from "@/hooks/usePromptDraftStorage";
import { getCollapsedChildActivity } from "@bb/client-core";
import { getRootComposeRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { BbHttpError } from "@bb/sdk/browser";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import {
  AppCommandShortcutHint,
  AppCommandShortcutPill,
} from "@/components/commands/AppCommandShortcutHint";
import {
  ThreadSectionCreateDialog,
  ThreadSectionRenameDialog,
  type ThreadSectionRenameDialogTarget,
} from "@/components/dialogs/ThreadSectionCreateDialog";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  SidebarGroupContent,
  SidebarStickyStack,
} from "@/components/ui/sidebar.js";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import {
  ChronologicalSectionThreadSections,
  ProjectThreadTree,
} from "./ProjectRow";
import type { ProjectThreadListState } from "./ProjectRow";
import {
  buildMachineThreadGroups,
  buildPinnedSidebarState,
  CHRONOLOGICAL_CONTAINER_ID,
  compareByCreatedAtDescending,
  compareStandardThreads,
  createSidebarProjectIdResolver,
  isSidebarProjectThread,
  NO_MACHINE_GROUP_KEY,
  resolveSidebarProjectId,
  sectionKeyForThreadSection,
  buildSidebarEntitySectionId,
  type ProjectThreadItem,
  type SidebarSectionDefinition,
  type ThreadComparator,
} from "@bb/client-core";
import {
  SortableProjectRow,
  type ProjectListRowModel,
} from "./ProjectListProjects";
import {
  PinnedThreadTree,
  type PinnedThreadTreeProps,
} from "./PinnedThreadTree";
import { useThreadTitleMentionResources } from "@/components/thread/ThreadTitleMentions";
import {
  collapsedEnvironmentIdsAtom,
  collapsedThreadIdsAtom,
  collapsedProjectIdsAtom,
  collapsedSidebarSectionIdsAtom,
  sidebarChronologicalSortAtom,
  sidebarCollapsedThreadSectionsAtom,
  sidebarCollapsedMachinesAtom,
  sidebarOrganizationModeAtom,
  type SidebarChronologicalSort,
  type CollapsibleSidebarSectionId,
  type SidebarOrganizationMode,
  type SidebarSectionId,
} from "./sidebarCollapsedAtoms";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
} from "./sidebarRowClasses";
export { TopLevelSidebarSection } from "./TopLevelSidebarSection";
import {
  useAppCommandRunner,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";
import { SplitPaneMiniMap } from "./SplitPaneMiniMap";
import {
  renderBuiltInSidebarSection,
  SortableSidebarSection,
  type BuiltInSidebarSectionOptions,
  type BuiltInSidebarSectionOptionsById,
} from "./BuiltInSidebarSection";
import { ReorderableSidebarSectionOrderList } from "./ReorderableSidebarSectionOrderList";
import { useSidebarModeSectionOrder } from "./useSidebarModeSectionOrder";
import { haveSameOrder } from "@/lib/stored-order";
import {
  resolveThreadTitleDisplayText,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";

interface ProjectListProps {
  onNewProject?: () => void;
  onProjectSelect?: () => void;
  isCreatingProject?: boolean;
}

interface ProjectListNewThreadActionProps {
  splitEnabled?: boolean;
  newThreadSplit?: {
    onPointerDown?: PointerEventHandler<HTMLElement>;
    openInSplit(): void;
  };
  onNewChat?: () => void;
}

interface ProjectListSearchThreadsActionProps {
  onSearchThreads?: () => void;
}

interface ProjectListActionButtonsProps
  extends ProjectListNewThreadActionProps,
    ProjectListSearchThreadsActionProps {}

interface ProjectListShellProps {
  children: ReactNode;
}

interface ProjectListSectionIconButtonProps {
  ariaLabel: string;
  disabled?: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
}

interface ProjectListProjectsSectionActionsProps {
  isCreatingProject: boolean;
  onNewProject: () => void;
}

interface ProjectListThreadsSectionActionsProps {
  isCreatingSection: boolean;
  onNewSection?: () => void;
  onNewThread: () => void;
}

interface SidebarDisplayOptionsMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ProjectListNavigationLoadingRowProps {
  textWidthClassName: string;
}

interface LocalSourcePathTarget {
  path: string;
  projectId: string;
}

export const PROJECT_LIST_ACTION_BUTTON_CLASS = cn(
  SIDEBAR_ROW_BASE_CLASS,
  LIST_HOVER_TRANSITION,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
  "min-w-0 cursor-pointer justify-start overflow-hidden font-normal ring-sidebar-ring focus-visible:ring-2 disabled:cursor-default disabled:opacity-70 max-md:pointer-coarse:[&_svg]:size-5",
);

const PROJECT_LIST_SECTION_ACTION_BUTTON_CLASS = cn(
  "inline-flex items-center justify-center rounded-md text-muted-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 disabled:opacity-50",
  LIST_HOVER_TRANSITION,
  COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
);

const PROJECT_LIST_SECTION_ACTION_TOOLTIP_DELAY_MS = 350;

interface ProjectThreadListStateArgs {
  status: ConnectionAwareQueryStatus | undefined;
  threads: ThreadListEntry[] | undefined;
}

interface ToggleCollapsedIdListArgs {
  current: string[];
  id: string;
}

interface SelectedThreadSidebarExpansionArgs {
  organizationMode: SidebarOrganizationMode;
  isPinned: boolean;
  selectedThread: ThreadListEntry;
  sidebarProjectId: string;
}

interface SelectedThreadSidebarExpansion {
  sectionKey?: string;
  machineKey?: string;
  projectId?: string;
  sidebarSectionId?: CollapsibleSidebarSectionId;
}

type ToggleCollapsedId = (id: string) => void;
type ToggleCollapsedSidebarSectionId = (
  id: CollapsibleSidebarSectionId,
) => void;
type OpenSidebarMenu =
  | "threadsDisplayOptions"
  | `displayOptions:${string}`
  | null;

function removeCollapsedIds<T extends string>(
  current: T[],
  idsToRemove: ReadonlySet<string>,
): T[] {
  if (idsToRemove.size === 0) {
    return current;
  }
  let removed = false;
  const next = current.filter((id) => {
    if (!idsToRemove.has(id)) {
      return true;
    }
    removed = true;
    return false;
  });
  return removed ? next : current;
}

export function getSelectedThreadSidebarExpansion({
  organizationMode,
  isPinned,
  selectedThread,
  sidebarProjectId,
}: SelectedThreadSidebarExpansionArgs): SelectedThreadSidebarExpansion {
  if (isPinned) {
    return { sidebarSectionId: "pinned" };
  }

  if (organizationMode === "machine") {
    return {
      machineKey: selectedThread.environmentHostId ?? NO_MACHINE_GROUP_KEY,
    };
  }

  if (organizationMode === "chronological") {
    const sectionKey = sectionKeyForThreadSection(
      CHRONOLOGICAL_CONTAINER_ID,
      selectedThread.sectionId,
    );
    return sectionKey ? { sectionKey } : { sidebarSectionId: "threads" };
  }

  if (sidebarProjectId === PERSONAL_PROJECT_ID) {
    return { sidebarSectionId: "threads" };
  }

  return { projectId: sidebarProjectId };
}

function isCollapsibleSidebarSectionId(
  value: string,
): value is CollapsibleSidebarSectionId {
  return value === "pinned" || value === "threads";
}

const EMPTY_PROJECT_THREAD_LIST_STATE: ProjectThreadListState = {
  status: "loading",
};

const EMPTY_PROJECTS: readonly ProjectResponse[] = [];
const EMPTY_SECTION_DEFINITIONS: readonly ThreadSectionResponse[] = [];

function getProjectThreadListState({
  status,
  threads,
}: ProjectThreadListStateArgs): ProjectThreadListState {
  switch (status) {
    case "ready":
      return {
        status: "ready",
        threads: threads ?? [],
      };
    case "unavailable":
      return { status: "unavailable" };
    case "loading":
    case undefined:
      return EMPTY_PROJECT_THREAD_LIST_STATE;
  }
}

function toggleCollapsedIdList({
  current,
  id,
}: ToggleCollapsedIdListArgs): string[] {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }

  return Array.from(next);
}

function normalizeCollapsedSidebarSectionIds(
  sectionIds: readonly CollapsibleSidebarSectionId[],
): CollapsibleSidebarSectionId[] {
  const seen = new Set<CollapsibleSidebarSectionId>();
  const normalized: CollapsibleSidebarSectionId[] = [];
  for (const sectionId of sectionIds) {
    if (!isCollapsibleSidebarSectionId(sectionId) || seen.has(sectionId)) {
      continue;
    }
    seen.add(sectionId);
    normalized.push(sectionId);
  }
  return normalized;
}

function compareByTitleAscending(
  left: ThreadListEntry,
  right: ThreadListEntry,
  resources?: ThreadTitleMentionResources,
): number {
  const leftTitle = getThreadDisplayTitle(left);
  const rightTitle = getThreadDisplayTitle(right);
  const titleDelta = (
    resources ? resolveThreadTitleDisplayText(leftTitle, resources) : leftTitle
  ).localeCompare(
    resources
      ? resolveThreadTitleDisplayText(rightTitle, resources)
      : rightTitle,
  );
  if (titleDelta !== 0) {
    return titleDelta;
  }

  return left.id.localeCompare(right.id);
}

function getProjectThreadItemAlphaLabel(
  item: ProjectThreadItem,
  resources?: ThreadTitleMentionResources,
): string {
  let label: string;
  switch (item.kind) {
    case "thread":
      label = getThreadDisplayTitle(item.node.thread);
      break;
    case "environment":
      label = getThreadDisplayTitle(item.group.nodes[0].thread);
      break;
    case "section":
      return item.group.name;
  }
  return resources ? resolveThreadTitleDisplayText(label, resources) : label;
}

function compareProjectThreadItemsByTitleAscending(
  left: ProjectThreadItem,
  right: ProjectThreadItem,
  resources?: ThreadTitleMentionResources,
): number {
  const labelDelta = getProjectThreadItemAlphaLabel(
    left,
    resources,
  ).localeCompare(getProjectThreadItemAlphaLabel(right, resources));
  if (labelDelta !== 0) {
    return labelDelta;
  }

  if (left.kind !== "section" && right.kind !== "section") {
    const leftThread =
      left.kind === "thread" ? left.node.thread : left.group.nodes[0].thread;
    const rightThread =
      right.kind === "thread" ? right.node.thread : right.group.nodes[0].thread;
    const threadIdDelta = leftThread.id.localeCompare(rightThread.id);
    if (threadIdDelta !== 0) {
      return threadIdDelta;
    }
  }

  const kindDelta = left.kind.localeCompare(right.kind);
  if (kindDelta !== 0) {
    return kindDelta;
  }

  return left.kind === "section" && right.kind === "section"
    ? left.group.key.localeCompare(right.group.key)
    : 0;
}

export function getSidebarThreadComparator(
  sort: SidebarChronologicalSort,
  resources?: ThreadTitleMentionResources,
): ThreadComparator {
  const normalizedSort = sort === "none" ? "updated" : sort;

  if (normalizedSort === "alpha") {
    const comparator: ThreadComparator = (left, right) =>
      compareByTitleAscending(left, right, resources);
    comparator.compareItems = (left, right) =>
      compareProjectThreadItemsByTitleAscending(left, right, resources);
    return comparator;
  }

  return normalizedSort === "created"
    ? compareByCreatedAtDescending
    : compareStandardThreads;
}

function getSectionMutationErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  if (error instanceof BbHttpError && error.code === "section_name_conflict") {
    return "Section name already exists.";
  }
  return getMutationErrorMessage({ error, fallbackMessage });
}

export function ProjectListSectionIconButton({
  ariaLabel,
  disabled = false,
  icon,
  onClick,
  title,
}: ProjectListSectionIconButtonProps) {
  const handleClick = useCallback<MouseEventHandler<HTMLButtonElement>>(
    (event) => {
      event.stopPropagation();
      if (event.detail > 0) {
        event.currentTarget.blur();
      }
      onClick();
    },
    [onClick],
  );

  const button = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={ariaLabel}
      disabled={disabled}
      className={PROJECT_LIST_SECTION_ACTION_BUTTON_CLASS}
      onClick={handleClick}
    >
      {icon}
    </Button>
  );

  return (
    <Tooltip
      delayDuration={PROJECT_LIST_SECTION_ACTION_TOOLTIP_DELAY_MS}
      disableHoverableContent
    >
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
    </Tooltip>
  );
}

function ProjectListProjectsSectionActions({
  isCreatingProject,
  onNewProject,
}: ProjectListProjectsSectionActionsProps) {
  return (
    <ProjectListSectionIconButton
      ariaLabel="New project"
      title="New project"
      disabled={isCreatingProject}
      icon={
        <Icon name="FolderPlus" className={COARSE_POINTER_ICON_SIZE_CLASS} />
      }
      onClick={onNewProject}
    />
  );
}

function ProjectListThreadsSectionActions({
  isCreatingSection,
  onNewSection,
  onNewThread,
}: ProjectListThreadsSectionActionsProps) {
  return (
    <>
      {onNewSection ? (
        <ProjectListSectionIconButton
          ariaLabel="New section"
          title="New section"
          disabled={isCreatingSection}
          icon={
            <Icon
              name="SectionAdd"
              className={COARSE_POINTER_ICON_SIZE_CLASS}
            />
          }
          onClick={onNewSection}
        />
      ) : null}
      <ProjectListSectionIconButton
        ariaLabel="New thread"
        title="New thread"
        icon={
          <Icon
            name="MessageSquarePlus"
            className={COARSE_POINTER_ICON_SIZE_CLASS}
          />
        }
        onClick={onNewThread}
      />
    </>
  );
}

const SIDEBAR_ORGANIZE_OPTIONS = [
  { label: "By project", mode: "project" },
  { label: "By machine", mode: "machine" },
  { label: "Manually", mode: "chronological" },
] as const satisfies readonly {
  label: string;
  mode: SidebarOrganizationMode;
}[];

const SIDEBAR_SORT_OPTIONS = [
  { label: "Updated at", sort: "updated" },
  { label: "Created at", sort: "created" },
  { label: "Alphabetical", sort: "alpha" },
] as const satisfies readonly {
  label: string;
  sort: SidebarChronologicalSort;
}[];

function SidebarDisplayMenuTrigger({
  ariaLabel,
  iconName,
  tooltip,
}: {
  ariaLabel: string;
  iconName: IconName;
  tooltip: string;
}) {
  return (
    <Tooltip
      delayDuration={PROJECT_LIST_SECTION_ACTION_TOOLTIP_DELAY_MS}
      disableHoverableContent
    >
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={ariaLabel}
            className={cn(
              "rounded-md p-0 text-muted-foreground",
              "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground",
              LIST_HOVER_TRANSITION,
              COARSE_POINTER_ROW_ACTION_SIZE_CLASS,
            )}
          >
            <Icon name={iconName} className={COARSE_POINTER_ICON_SIZE_CLASS} />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="px-2 py-1">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarDisplayOptionsMenu({
  open,
  onOpenChange,
}: SidebarDisplayOptionsMenuProps) {
  const [organizationMode, setOrganizationMode] = useAtom(
    sidebarOrganizationModeAtom,
  );
  const [chronologicalSort, setChronologicalSort] = useAtom(
    sidebarChronologicalSortAtom,
  );
  const selectedSort: SidebarChronologicalSort =
    chronologicalSort === "none" ? "updated" : chronologicalSort;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <SidebarDisplayMenuTrigger
        ariaLabel="Sidebar display options"
        iconName="SlidersHorizontal"
        tooltip="Display options"
      />
      <DropdownMenuContent align="end" mobileTitle="Display options">
        <DropdownMenuLabel className={CHROME_SECTION_LABEL_CLASS}>
          Organize
        </DropdownMenuLabel>
        <DropdownMenuGroup aria-label="Organize">
          {SIDEBAR_ORGANIZE_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.mode}
              checked={organizationMode === option.mode}
              onCheckedChange={() => {
                onOpenChange?.(false);
                setOrganizationMode(option.mode);
              }}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className={CHROME_SECTION_LABEL_CLASS}>
          Sort by
        </DropdownMenuLabel>
        <DropdownMenuGroup aria-label="Sort by">
          {SIDEBAR_SORT_OPTIONS.map((option) => (
            <DropdownMenuCheckboxItem
              key={option.sort}
              checked={selectedSort === option.sort}
              onCheckedChange={() => setChronologicalSort(option.sort)}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SidebarThreadsSectionActionsProps {
  displayOptionsOpen: boolean;
  onDisplayOptionsOpenChange: (open: boolean) => void;
  isCreatingSection: boolean;
  onNewSection?: () => void;
  isCreatingProject: boolean;
  onNewProject?: () => void;
  onNewThread: () => void;
}

function SidebarThreadsSectionActions({
  displayOptionsOpen,
  onDisplayOptionsOpenChange,
  isCreatingSection,
  onNewSection,
  isCreatingProject,
  onNewProject,
  onNewThread,
}: SidebarThreadsSectionActionsProps) {
  return (
    <>
      <SidebarDisplayOptionsMenu
        open={displayOptionsOpen}
        onOpenChange={onDisplayOptionsOpenChange}
      />
      {onNewProject ? (
        <ProjectListProjectsSectionActions
          isCreatingProject={isCreatingProject}
          onNewProject={onNewProject}
        />
      ) : null}
      <ProjectListThreadsSectionActions
        isCreatingSection={isCreatingSection}
        onNewSection={onNewSection}
        onNewThread={onNewThread}
      />
    </>
  );
}

export function ProjectListNavigationLoadingState() {
  return (
    <div
      aria-label="Loading sidebar navigation"
      className="space-y-1.5 px-2 pt-1 group-data-[collapsible=icon]:hidden"
    >
      <ProjectListNavigationLoadingRow textWidthClassName="w-2/3" />
      <ProjectListNavigationLoadingRow textWidthClassName="w-1/2" />
    </div>
  );
}

function ProjectListNavigationLoadingRow({
  textWidthClassName,
}: ProjectListNavigationLoadingRowProps) {
  return (
    <div
      data-sidebar="navigation-loading-row"
      className="flex h-7 items-center gap-2 rounded-md"
    >
      <Skeleton className="size-4 shrink-0 rounded-md bg-sidebar-border/60" />
      <Skeleton
        className={cn(
          "h-3 rounded-sm bg-sidebar-border/50",
          textWidthClassName,
        )}
      />
    </div>
  );
}

export function ProjectListNewThreadAction({
  splitEnabled = false,
  newThreadSplit,
  onNewChat,
}: ProjectListNewThreadActionProps) {
  const isNewChatDisabled = !onNewChat;
  const newThreadShortcut = useAppCommandShortcut("thread.new");
  const newThreadSplitIndicator = usePaneContentSplitIndicator(
    { kind: "new-thread" },
    splitEnabled,
  );

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(PROJECT_LIST_ACTION_BUTTON_CLASS, "w-full")}
      onPointerDown={newThreadSplit?.onPointerDown}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) {
          newThreadSplit?.openInSplit();
          return;
        }
        onNewChat?.();
      }}
      disabled={isNewChatDisabled}
      aria-label={
        newThreadShortcut
          ? `New thread (${newThreadShortcut.label})`
          : "New thread"
      }
      aria-keyshortcuts={newThreadShortcut?.ariaKeyshortcuts}
    >
      <Icon name="MessageSquarePlus" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-left">New thread</span>
        {newThreadSplitIndicator.miniMap ? (
          <SplitPaneMiniMap
            slots={newThreadSplitIndicator.miniMap}
            label="New thread — open in split"
          />
        ) : null}
        <AppCommandShortcutHint shortcut={newThreadShortcut} />
      </span>
    </Button>
  );
}

export function ProjectListSearchThreadsAction({
  onSearchThreads,
}: ProjectListSearchThreadsActionProps) {
  const commandRunner = useAppCommandRunner();
  const threadSearchShortcut = useAppCommandShortcut("thread.search");

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        PROJECT_LIST_ACTION_BUTTON_CLASS,
        "group/search-threads w-full pr-1",
      )}
      onClick={(event) => {
        onSearchThreads?.();
        commandRunner.dispatch("thread.search", event.currentTarget);
      }}
      aria-label={
        threadSearchShortcut
          ? `Search threads (${threadSearchShortcut.label})`
          : "Search threads"
      }
      aria-keyshortcuts={threadSearchShortcut?.ariaKeyshortcuts}
    >
      <Icon name="Search" />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-left">
          Search threads
        </span>
        {threadSearchShortcut ? (
          <span className="inline-flex shrink-0 opacity-0 transition-opacity group-hover/search-threads:opacity-100 group-focus-visible/search-threads:opacity-100 max-md:pointer-coarse:hidden">
            <AppCommandShortcutPill shortcut={threadSearchShortcut} />
          </span>
        ) : null}
      </span>
    </Button>
  );
}

export function ProjectListActionButtons({
  splitEnabled = false,
  newThreadSplit,
  onNewChat,
  onSearchThreads,
}: ProjectListActionButtonsProps) {
  return (
    <div className="space-y-1">
      <ProjectListNewThreadAction
        splitEnabled={splitEnabled}
        newThreadSplit={newThreadSplit}
        onNewChat={onNewChat}
      />
      <ProjectListSearchThreadsAction onSearchThreads={onSearchThreads} />
    </div>
  );
}

export function ProjectListShell({ children }: ProjectListShellProps) {
  return (
    <SidebarStickyStack data-sidebar-sticky-density="compact-actions">
      <SidebarGroupContent>{children}</SidebarGroupContent>
    </SidebarStickyStack>
  );
}

interface BuiltInSectionRenderState {
  collapsedSectionIds: ReadonlySet<CollapsibleSidebarSectionId>;
  onToggleCollapsed: (id: CollapsibleSidebarSectionId) => void;
  showPinnedSection: boolean;
}

interface ActiveSidebarModeSectionsProps {
  mode: SidebarOrganizationMode;
  renderChronological: () => ReactNode;
  renderMachine: () => ReactNode;
  renderProject: () => ReactNode;
}

export function ActiveSidebarModeSections({
  mode,
  renderChronological,
  renderMachine,
  renderProject,
}: ActiveSidebarModeSectionsProps) {
  if (mode === "machine") return renderMachine();
  if (mode === "chronological") return renderChronological();
  return renderProject();
}

function useSidebarProgressiveDisclosureEnabled(): boolean {
  return (
    useSystemConfig().data?.experiments.sidebarProgressiveDisclosure ?? false
  );
}

interface ProjectModeSectionsProps extends BuiltInSectionRenderState {
  collapsedEnvironmentIds: Set<string>;
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  draftThreadIds: ReadonlySet<string>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  isReady: boolean;
  onCreateProjectThread: (projectId: string) => void;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: ToggleCollapsedId;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  projects: readonly ProjectResponse[];
  renderSectionDisplayOptions: (sectionId: SidebarSectionId) => ReactNode;
  isSectionDisplayOptionsOpen: (sectionId: SidebarSectionId) => boolean;
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
}

function ProjectModeSections({
  collapsedEnvironmentIds,
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreads,
  draftThreadIds,
  effectivePinnedThreadIds,
  isReady,
  isSectionDisplayOptionsOpen,
  onCreateProjectThread,
  onProjectSelect,
  onToggleCollapsed,
  onToggleEnvironmentCollapsed,
  onToggleThreadCollapsed,
  pinnedSection,
  projects,
  renderSectionDisplayOptions,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: ProjectModeSectionsProps) {
  const progressiveDisclosureEnabled =
    useSidebarProgressiveDisclosureEnabled();
  const [collapsedProjectIdList, setCollapsedProjectIdList] = useAtom(
    collapsedProjectIdsAtom,
  );
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdList),
    [collapsedProjectIdList],
  );
  const toggleProjectCollapsed = useCallback<ToggleCollapsedId>(
    (projectId) => {
      setCollapsedProjectIdList((current) =>
        toggleCollapsedIdList({ current, id: projectId }),
      );
    },
    [setCollapsedProjectIdList],
  );
  const primaryHost = usePrimaryHost();
  const workHostId =
    primaryHost?.status === "connected" ? primaryHost.id : null;
  const localSourceTargets = useMemo(() => {
    if (!workHostId) return [];
    const targets: LocalSourcePathTarget[] = [];
    for (const project of projects) {
      const source = findLocalPathProjectSourceForHost(
        project.sources,
        workHostId,
      );
      if (source) {
        targets.push({ path: source.path, projectId: project.id });
      }
    }
    return targets;
  }, [projects, workHostId]);
  const localSourcePathsByProjectId = useMemo(
    () =>
      new Map(
        localSourceTargets.map((target) => [target.projectId, target.path]),
      ),
    [localSourceTargets],
  );
  const localPaths = useMemo(
    () => localSourceTargets.map((target) => target.path),
    [localSourceTargets],
  );
  const pathExistence = useHostPathExistence(workHostId, localPaths);
  const threadsByProject = useMemo(() => {
    const grouped = new Map<string, ThreadListEntry[]>();
    const resolveSidebarProjectId = createSidebarProjectIdResolver(
      new Map(threads.map((thread) => [thread.id, thread])),
    );
    for (const thread of threads) {
      if (effectivePinnedThreadIds.has(thread.id)) continue;
      const sidebarProjectId = resolveSidebarProjectId(thread);
      const existing = grouped.get(sidebarProjectId);
      if (existing) {
        existing.push(thread);
      } else {
        grouped.set(sidebarProjectId, [thread]);
      }
    }
    return grouped;
  }, [effectivePinnedThreadIds, threads]);
  const projectRows = useMemo<ProjectListRowModel[]>(
    () =>
      projects.map((project) => ({
        project,
        threadListState: getProjectThreadListState({
          status,
          threads: threadsByProject.get(project.id),
        }),
        isActive: false,
        isLocalPathInvalid: isHostPathMissing(
          pathExistence,
          localSourcePathsByProjectId.get(project.id),
        ),
      })),
    [
      localSourcePathsByProjectId,
      pathExistence,
      projects,
      status,
      threadsByProject,
    ],
  );
  const projectSectionIds = useMemo(
    () =>
      projectRows.map((row) =>
        buildSidebarEntitySectionId("project", row.project.id),
      ),
    [projectRows],
  );
  const projectRowsBySectionId = useMemo(() => {
    const rows = new Map<SidebarSectionId, ProjectListRowModel>();
    for (const row of projectRows) {
      rows.set(buildSidebarEntitySectionId("project", row.project.id), row);
    }
    return rows;
  }, [projectRows]);
  const personalThreads =
    threadsByProject.get(PERSONAL_PROJECT_ID)?.filter(isSidebarProjectThread) ??
    [];
  const { onOrderChange, order, persistedOrder } = useSidebarModeSectionOrder({
    mode: "project",
    entitySectionIds: projectSectionIds,
    hasThreadsSection: personalThreads.length > 0 || projectRows.length === 0,
    showPinnedSection,
    isReady,
  });
  const reorderDisabled = order.length < 2;
  const builtInSections: BuiltInSidebarSectionOptionsById = {
    pinned: pinnedSection,
    threads: {
      ...threadsSection,
      activity: getCollapsedChildActivity(personalThreads, draftThreadIds),
      collapsedThreads: personalThreads,
      content: (
        <ProjectThreadTree
          projectId={PERSONAL_PROJECT_ID}
          threadListState={getProjectThreadListState({
            status,
            threads: personalThreads,
          })}
          progressiveDisclosureEnabled={progressiveDisclosureEnabled}
          selectedThreadId={selectedThreadId}
          collapsedThreadIds={collapsedThreadIds}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          compareThreads={compareThreads}
          variant="section"
          onProjectSelect={onProjectSelect}
          onToggleThreadCollapsed={onToggleThreadCollapsed}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
        />
      ),
    },
  };

  return (
    <ReorderableSidebarSectionOrderList
      order={order}
      reorderOrder={persistedOrder}
      onOrderChange={onOrderChange}
    >
      {(sectionId, consumeClickSuppression) => {
        const builtInSection = renderBuiltInSidebarSection({
          sectionId,
          sections: builtInSections,
          disabled: reorderDisabled,
          collapsedSectionIds,
          onToggleCollapsed,
          consumeClickSuppression,
          showPinnedSection,
        });
        if (builtInSection !== undefined) return builtInSection;
        const row = projectRowsBySectionId.get(sectionId);
        if (!row) return null;
        return (
          <SortableProjectRow
            key={sectionId}
            sortableId={sectionId}
            project={row.project}
            threadListState={row.threadListState}
            progressiveDisclosureEnabled={progressiveDisclosureEnabled}
            selectedThreadId={selectedThreadId}
            isActive={row.isActive}
            isCollapsed={collapsedProjectIds.has(row.project.id)}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            compareThreads={compareThreads}
            isLocalPathInvalid={row.isLocalPathInvalid}
            headerActions={renderSectionDisplayOptions(sectionId)}
            headerActionsOpen={isSectionDisplayOptionsOpen(sectionId)}
            onProjectSelect={onProjectSelect}
            onCreateProjectThread={onCreateProjectThread}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
            reorderDisabled={reorderDisabled}
            consumeProjectClickSuppression={consumeClickSuppression}
          />
        );
      }}
    </ReorderableSidebarSectionOrderList>
  );
}

interface SectionModeSectionsProps extends BuiltInSectionRenderState {
  collapsedEnvironmentIds: Set<string>;
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  sections: readonly SidebarSectionDefinition[];
  isReady: boolean;
  onCreateThreadInSection: (sectionId: string) => void;
  onProjectSelect?: () => void;
  onRemoveSection: (section: SidebarSectionDefinition) => void;
  onRenameSection: (section: SidebarSectionDefinition) => void;
  onToggleEnvironmentCollapsed: ToggleCollapsedId;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  pinnedReorderPending: boolean;
  pinnedThreads: readonly ThreadListEntry[];
  onReorderPinnedThread: NonNullable<
    PinnedThreadTreeProps["onReorderPinnedRoot"]
  >;
  renderTopLevelSectionHeaderActions: (section: SidebarSectionDefinition) => {
    actions: ReactNode;
    actionsOpen: boolean;
  };
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
  effectivePinnedThreadIds: ReadonlySet<string>;
}

function SectionModeSections({
  collapsedEnvironmentIds,
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreads,
  effectivePinnedThreadIds,
  sections,
  isReady,
  onCreateThreadInSection,
  onProjectSelect,
  onRemoveSection,
  onRenameSection,
  onToggleCollapsed,
  onToggleEnvironmentCollapsed,
  onToggleThreadCollapsed,
  pinnedSection,
  pinnedReorderPending,
  pinnedThreads,
  onReorderPinnedThread,
  renderTopLevelSectionHeaderActions,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: SectionModeSectionsProps) {
  const nonPinnedThreads = useMemo(
    () => threads.filter((thread) => !effectivePinnedThreadIds.has(thread.id)),
    [effectivePinnedThreadIds, threads],
  );
  const threadListState = getProjectThreadListState({
    status,
    threads: nonPinnedThreads,
  });
  const threadSectionIds = useMemo(
    () =>
      sections.map((section) =>
        buildSidebarEntitySectionId("section", section.id),
      ),
    [sections],
  );
  const { onOrderChange, order } = useSidebarModeSectionOrder({
    mode: "chronological",
    entitySectionIds: threadSectionIds,
    showPinnedSection,
    isReady,
  });

  return (
    <ChronologicalSectionThreadSections
      threadListState={threadListState}
      compareThreads={compareThreads}
      sections={sections}
      selectedThreadId={selectedThreadId}
      collapsedThreadIds={collapsedThreadIds}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      onProjectSelect={onProjectSelect}
      onCreateThreadInSection={onCreateThreadInSection}
      onRenameSection={onRenameSection}
      onRemoveSection={onRemoveSection}
      renderTopLevelSectionHeaderActions={renderTopLevelSectionHeaderActions}
      onToggleThreadCollapsed={onToggleThreadCollapsed}
      onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
      topLevelSectionOrder={order}
      onTopLevelSectionOrderChange={onOrderChange}
      pinnedReorderPending={pinnedReorderPending}
      pinnedThreads={pinnedThreads}
      onReorderPinnedThread={onReorderPinnedThread}
      builtInSections={{
        pinned: pinnedSection,
        threads: threadsSection,
        collapsedSectionIds,
        onToggleCollapsed,
      }}
    />
  );
}

interface MachineModeSectionsProps extends BuiltInSectionRenderState {
  collapsedEnvironmentIds: Set<string>;
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  draftThreadIds: ReadonlySet<string>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  isReady: boolean;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: ToggleCollapsedId;
  onToggleThreadCollapsed: ToggleCollapsedId;
  pinnedSection: BuiltInSidebarSectionOptions;
  renderSectionDisplayOptions: (sectionId: SidebarSectionId) => ReactNode;
  isSectionDisplayOptionsOpen: (sectionId: SidebarSectionId) => boolean;
  selectedThreadId?: string;
  status: ConnectionAwareQueryStatus;
  threads: ThreadListEntry[];
  threadsSection: Omit<BuiltInSidebarSectionOptions, "content">;
}

export function MachineModeSections({
  collapsedEnvironmentIds,
  collapsedSectionIds,
  collapsedThreadIds,
  compareThreads,
  draftThreadIds,
  effectivePinnedThreadIds,
  isReady,
  isSectionDisplayOptionsOpen,
  onProjectSelect,
  onToggleCollapsed,
  onToggleEnvironmentCollapsed,
  onToggleThreadCollapsed,
  pinnedSection,
  renderSectionDisplayOptions,
  selectedThreadId,
  showPinnedSection,
  status,
  threads,
  threadsSection,
}: MachineModeSectionsProps) {
  const progressiveDisclosureEnabled =
    useSidebarProgressiveDisclosureEnabled();
  const { data: hosts } = useHosts();
  const [collapsedMachineKeyList, setCollapsedMachineKeyList] = useAtom(
    sidebarCollapsedMachinesAtom,
  );
  const collapsedMachineKeys = useMemo(
    () => new Set(collapsedMachineKeyList),
    [collapsedMachineKeyList],
  );
  const toggleMachineCollapsed = useCallback<ToggleCollapsedId>(
    (machineKey) => {
      setCollapsedMachineKeyList((current) =>
        toggleCollapsedIdList({ current, id: machineKey }),
      );
    },
    [setCollapsedMachineKeyList],
  );
  const nonPinnedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          !effectivePinnedThreadIds.has(thread.id) &&
          isSidebarProjectThread(thread),
      ),
    [effectivePinnedThreadIds, threads],
  );
  const allThreadsListState = getProjectThreadListState({
    status,
    threads: nonPinnedThreads,
  });
  const machineSections = useMemo(
    () =>
      buildMachineThreadGroups(nonPinnedThreads, hosts ?? []).map((group) => ({
        activity: getCollapsedChildActivity(group.threads, draftThreadIds),
        key: group.key,
        label: group.label,
        threadListState: {
          status: "ready",
          threads: group.threads,
        } satisfies ProjectThreadListState,
      })),
    [draftThreadIds, hosts, nonPinnedThreads],
  );
  const machineSectionIds = useMemo(
    () =>
      machineSections.map((section) =>
        buildSidebarEntitySectionId("machine", section.key),
      ),
    [machineSections],
  );
  const machineSectionsById = useMemo(
    () =>
      new Map(
        machineSections.map((section) => [
          buildSidebarEntitySectionId("machine", section.key),
          section,
        ]),
      ),
    [machineSections],
  );
  const { onOrderChange, order, persistedOrder } = useSidebarModeSectionOrder({
    mode: "machine",
    entitySectionIds: machineSectionIds,
    hasThreadsSection: machineSections.length === 0,
    showPinnedSection,
    isReady,
  });
  const reorderDisabled = order.length < 2;
  const builtInSections: BuiltInSidebarSectionOptionsById = {
    pinned: pinnedSection,
    threads: {
      ...threadsSection,
      activity: getCollapsedChildActivity(nonPinnedThreads, draftThreadIds),
      collapsedThreads: nonPinnedThreads,
      content: (
        <ProjectThreadTree
          threadListState={allThreadsListState}
          progressiveDisclosureEnabled={progressiveDisclosureEnabled}
          compareThreads={compareThreads}
          variant="section"
          selectedThreadId={selectedThreadId}
          collapsedThreadIds={collapsedThreadIds}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          onProjectSelect={onProjectSelect}
          onToggleThreadCollapsed={onToggleThreadCollapsed}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
        />
      ),
    },
  };

  return (
    <ReorderableSidebarSectionOrderList
      order={order}
      reorderOrder={persistedOrder}
      onOrderChange={onOrderChange}
    >
      {(sectionId, consumeClickSuppression) => {
        const builtInSection = renderBuiltInSidebarSection({
          sectionId,
          sections: builtInSections,
          disabled: reorderDisabled,
          collapsedSectionIds,
          onToggleCollapsed,
          consumeClickSuppression,
          showPinnedSection,
        });
        if (builtInSection !== undefined) return builtInSection;
        const section = machineSectionsById.get(sectionId);
        if (!section) return null;
        return (
          <SortableSidebarSection
            key={sectionId}
            id={sectionId}
            label={section.label}
            disabled={reorderDisabled}
            actions={renderSectionDisplayOptions(sectionId)}
            actionsOpen={isSectionDisplayOptionsOpen(sectionId)}
            actionsMobileAlways
            collapsedActivity={section.activity}
            collapsedThreads={section.threadListState.threads}
            collapseControl={{
              isCollapsed: collapsedMachineKeys.has(section.key),
              onToggleCollapsed: () => toggleMachineCollapsed(section.key),
            }}
            consumeClickSuppression={consumeClickSuppression}
          >
            <ProjectThreadTree
              threadListState={section.threadListState}
              progressiveDisclosureEnabled={progressiveDisclosureEnabled}
              compareThreads={compareThreads}
              variant="section"
              selectedThreadId={selectedThreadId}
              collapsedThreadIds={collapsedThreadIds}
              collapsedEnvironmentIds={collapsedEnvironmentIds}
              onProjectSelect={onProjectSelect}
              onToggleThreadCollapsed={onToggleThreadCollapsed}
              onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
            />
          </SortableSidebarSection>
        );
      }}
    </ReorderableSidebarSectionOrderList>
  );
}

function ProjectListComponent({
  onNewProject,
  onProjectSelect,
  isCreatingProject = false,
}: ProjectListProps) {
  const navigate = useNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const sidebarNavigationQuery = useSidebarNavigation();
  const sidebarNavigation = sidebarNavigationQuery.data;
  const sections = sidebarNavigation?.sections ?? EMPTY_SECTION_DEFINITIONS;
  const projects = useMemo(
    () => sidebarNavigation?.projects.map(stripProjectThreads),
    [sidebarNavigation],
  );
  const threads = useMemo(() => {
    if (!sidebarNavigation) {
      return [];
    }
    const sidebarThreads: ThreadListEntry[] = [];
    for (const project of sidebarNavigation.projects) {
      sidebarThreads.push(...project.threads);
    }
    sidebarThreads.push(...sidebarNavigation.personalProject.threads);
    return sidebarThreads;
  }, [sidebarNavigation]);
  const draftThreadIds = usePromptDraftInputThreadIds(threads);
  const titleMentionResources = useThreadTitleMentionResources();
  const threadById = useMemo(() => {
    const map = new Map<string, ThreadListEntry>();
    for (const thread of threads) {
      map.set(thread.id, thread);
    }
    return map;
  }, [threads]);
  const projectsState = useConnectionAwareQueryState({
    hasResolvedData: projects !== undefined,
    isFetching: sidebarNavigationQuery.isFetching,
    isLoadingError: sidebarNavigationQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(
      sidebarNavigationQuery.error,
    ),
  });
  const { threadId: selectedThreadId } = useRouteState();
  const {
    isPending: isPinnedReorderPending,
    mutate: reorderPinnedThreadMutate,
  } = useReorderPinnedThread();
  const {
    isPending: isCreateThreadSectionPending,
    mutate: createThreadSectionMutate,
  } = useCreateThreadSection();
  const {
    isPending: isUpdateThreadSectionPending,
    mutate: updateThreadSectionMutate,
  } = useUpdateThreadSection();
  const {
    isPending: isDeleteThreadSectionPending,
    mutate: deleteThreadSectionMutate,
  } = useDeleteThreadSection();
  const handleReorderPinnedRoot = useCallback<
    NonNullable<PinnedThreadTreeProps["onReorderPinnedRoot"]>
  >(
    (request, callbacks) => {
      reorderPinnedThreadMutate(
        {
          id: request.itemId,
          previousThreadId: request.previousItemId,
          nextThreadId: request.nextItemId,
        },
        {
          onSettled: callbacks.onSettled,
        },
      );
    },
    [reorderPinnedThreadMutate],
  );
  const openRootComposeForProject = useCallback(
    (projectId: string, sectionId?: string) => {
      setRootComposeProjectId(projectId);
      onProjectSelect?.();
      navigate(getRootComposeRoutePath(), {
        state: {
          focusPrompt: true,
          ...(sectionId ? { sectionId } : {}),
        },
      });
    },
    [navigate, onProjectSelect, setRootComposeProjectId],
  );
  const handleCreateProjectThread = useCallback(
    (projectId: string) => {
      openRootComposeForProject(projectId);
    },
    [openRootComposeForProject],
  );
  const handleCreateProjectlessThread = useCallback(() => {
    openRootComposeForProject(PERSONAL_PROJECT_ID);
  }, [openRootComposeForProject]);
  const handleCreateThreadInSection = useCallback(
    (sectionId: string) => {
      openRootComposeForProject(PERSONAL_PROJECT_ID, sectionId);
    },
    [openRootComposeForProject],
  );
  const [isSectionCreateDialogOpen, setIsSectionCreateDialogOpen] =
    useState(false);
  const [sectionCreateErrorMessage, setSectionCreateErrorMessage] = useState<
    string | null
  >(null);
  const [sectionRenameErrorMessage, setSectionRenameErrorMessage] = useState<
    string | null
  >(null);
  const sectionRenameDialog = useDialogState<ThreadSectionRenameDialogTarget>();
  const sectionDeleteDialog = useDialogState<SidebarSectionDefinition>();
  const handleOpenCreateSectionDialog = useCallback(() => {
    setSectionCreateErrorMessage(null);
    setIsSectionCreateDialogOpen(true);
  }, []);
  const handleCreateSectionDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setSectionCreateErrorMessage(null);
      setIsSectionCreateDialogOpen(false);
    }
  }, []);
  const handleCreateThreadSection = useCallback(
    (name: string) => {
      setSectionCreateErrorMessage(null);
      createThreadSectionMutate(
        { name },
        {
          onSuccess: () => setIsSectionCreateDialogOpen(false),
          onError: (error) =>
            setSectionCreateErrorMessage(
              getSectionMutationErrorMessage(
                error,
                "Failed to create section.",
              ),
            ),
        },
      );
    },
    [createThreadSectionMutate],
  );
  const handleOpenRenameThreadSection = useCallback(
    (section: SidebarSectionDefinition) => {
      setSectionRenameErrorMessage(null);
      sectionRenameDialog.onOpen({ id: section.id, name: section.name });
    },
    [sectionRenameDialog],
  );
  const handleRenameThreadSection = useCallback(
    (id: string, name: string) => {
      setSectionRenameErrorMessage(null);
      updateThreadSectionMutate(
        { id, name },
        {
          onSuccess: () => sectionRenameDialog.onClose(),
          onError: (error) =>
            setSectionRenameErrorMessage(
              getSectionMutationErrorMessage(
                error,
                "Failed to rename section.",
              ),
            ),
        },
      );
    },
    [sectionRenameDialog, updateThreadSectionMutate],
  );
  const handleRemoveThreadSection = useCallback(
    (section: SidebarSectionDefinition) => {
      sectionDeleteDialog.onOpen(section);
    },
    [sectionDeleteDialog],
  );
  const handleConfirmRemoveThreadSection = useCallback(() => {
    const section = sectionDeleteDialog.target;
    if (!section) {
      return;
    }
    deleteThreadSectionMutate(
      { id: section.id },
      { onSuccess: () => sectionDeleteDialog.onClose() },
    );
  }, [deleteThreadSectionMutate, sectionDeleteDialog]);
  const handleSectionDeleteDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }
      sectionDeleteDialog.onClose();
    },
    [sectionDeleteDialog],
  );
  const handleRenameThreadSectionOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setSectionRenameErrorMessage(null);
      }
      sectionRenameDialog.onOpenChange(open);
    },
    [sectionRenameDialog],
  );
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const [collapsedThreadIdList, setCollapsedThreadIdList] = useAtom(
    collapsedThreadIdsAtom,
  );
  const [collapsedEnvironmentIdList, setCollapsedEnvironmentIdList] = useAtom(
    collapsedEnvironmentIdsAtom,
  );
  const setCollapsedMachineKeyList = useSetAtom(sidebarCollapsedMachinesAtom);
  const [collapsedSidebarSectionIdList, setCollapsedSidebarSectionIdList] =
    useAtom(collapsedSidebarSectionIdsAtom);
  const [openSidebarMenu, setOpenSidebarMenu] = useState<OpenSidebarMenu>(null);
  const setSidebarMenuOpen = useCallback(
    (menu: Exclude<OpenSidebarMenu, null>, open: boolean) => {
      setOpenSidebarMenu((current) =>
        open ? menu : current === menu ? null : current,
      );
    },
    [],
  );
  const handleThreadsDisplayOptionsMenuOpenChange = useCallback(
    (open: boolean) => setSidebarMenuOpen("threadsDisplayOptions", open),
    [setSidebarMenuOpen],
  );
  const threadsDisplayOptionsMenuOpen =
    openSidebarMenu === "threadsDisplayOptions";
  const renderSectionDisplayOptions = (sectionId: SidebarSectionId) => {
    const menuId = `displayOptions:${sectionId}` as const;
    return (
      <SidebarDisplayOptionsMenu
        open={openSidebarMenu === menuId}
        onOpenChange={(open) => setSidebarMenuOpen(menuId, open)}
      />
    );
  };
  const isSectionDisplayOptionsOpen = (sectionId: SidebarSectionId) =>
    openSidebarMenu === `displayOptions:${sectionId}`;
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const [chronologicalSort, setChronologicalSort] = useAtom(
    sidebarChronologicalSortAtom,
  );
  const isSectionOrganizationMode = organizationMode === "chronological";
  const setCollapsedSectionList = useSetAtom(
    sidebarCollapsedThreadSectionsAtom,
  );
  const sidebarThreadComparator = useMemo<ThreadComparator>(
    () => getSidebarThreadComparator(chronologicalSort, titleMentionResources),
    [chronologicalSort, titleMentionResources],
  );
  const collapsedThreadIds = useMemo(
    () => new Set(collapsedThreadIdList),
    [collapsedThreadIdList],
  );
  const collapsedEnvironmentIds = useMemo(
    () => new Set(collapsedEnvironmentIdList),
    [collapsedEnvironmentIdList],
  );
  const normalizedCollapsedSidebarSectionIds = useMemo(
    () => normalizeCollapsedSidebarSectionIds(collapsedSidebarSectionIdList),
    [collapsedSidebarSectionIdList],
  );
  const collapsedSidebarSectionIds = useMemo(
    () => new Set(normalizedCollapsedSidebarSectionIds),
    [normalizedCollapsedSidebarSectionIds],
  );
  useEffect(() => {
    if (
      haveSameOrder(
        collapsedSidebarSectionIdList,
        normalizedCollapsedSidebarSectionIds,
      )
    ) {
      return;
    }
    setCollapsedSidebarSectionIdList(normalizedCollapsedSidebarSectionIds);
  }, [
    collapsedSidebarSectionIdList,
    normalizedCollapsedSidebarSectionIds,
    setCollapsedSidebarSectionIdList,
  ]);
  useEffect(() => {
    if (chronologicalSort === "none") {
      setChronologicalSort("updated");
    }
  }, [chronologicalSort, setChronologicalSort]);
  const pinnedSidebarState = useMemo(
    () => buildPinnedSidebarState({ draftThreadIds, threads }),
    [draftThreadIds, threads],
  );
  const pinnedRootThreads = useMemo(
    () => pinnedSidebarState.rootNodes.map((node) => node.thread),
    [pinnedSidebarState.rootNodes],
  );
  const hasPinnedSection = pinnedSidebarState.rootNodes.length > 0;
  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    const selectedThread = threadById.get(selectedThreadId);
    if (!selectedThread) {
      return;
    }
    if (selectedThread.visibility === "hidden") {
      return;
    }

    const threadIdsToExpand = new Set<string>();
    const environmentIdsToExpand = new Set<string>();
    let currentThread: ThreadListEntry | undefined = selectedThread;
    let remainingHops = threadById.size;
    while (currentThread && remainingHops > 0) {
      if (currentThread.environmentId !== null) {
        environmentIdsToExpand.add(currentThread.environmentId);
      }
      const parentThreadId = currentThread.parentThreadId;
      if (parentThreadId === null) {
        break;
      }
      const parentThread = threadById.get(parentThreadId);
      if (!parentThread) {
        break;
      }
      threadIdsToExpand.add(parentThread.id);
      currentThread = parentThread;
      remainingHops -= 1;
    }

    setCollapsedThreadIdList((current) =>
      removeCollapsedIds(current, threadIdsToExpand),
    );
    setCollapsedEnvironmentIdList((current) =>
      removeCollapsedIds(current, environmentIdsToExpand),
    );

    const isPinned =
      pinnedSidebarState.effectivePinnedThreadIds.has(selectedThreadId);
    const expansion = getSelectedThreadSidebarExpansion({
      organizationMode,
      isPinned,
      selectedThread,
      sidebarProjectId: resolveSidebarProjectId(selectedThread, threadById),
    });
    if (expansion.machineKey) {
      const machineKey = expansion.machineKey;
      setCollapsedMachineKeyList((current) =>
        removeCollapsedIds(current, new Set([machineKey])),
      );
    }
    if (expansion.sectionKey) {
      const sectionKey = expansion.sectionKey;
      setCollapsedSectionList((current) =>
        removeCollapsedIds(current, new Set([sectionKey])),
      );
    }
    if (expansion.projectId) {
      const projectId = expansion.projectId;
      setCollapsedProjectIdList((current) =>
        removeCollapsedIds(current, new Set([projectId])),
      );
    }
    if (expansion.sidebarSectionId) {
      const sidebarSectionId = expansion.sidebarSectionId;
      setCollapsedSidebarSectionIdList((current) =>
        removeCollapsedIds(current, new Set([sidebarSectionId])),
      );
    }
  }, [
    organizationMode,
    pinnedSidebarState.effectivePinnedThreadIds,
    selectedThreadId,
    setCollapsedEnvironmentIdList,
    setCollapsedSectionList,
    setCollapsedMachineKeyList,
    setCollapsedProjectIdList,
    setCollapsedSidebarSectionIdList,
    setCollapsedThreadIdList,
    threadById,
  ]);
  const toggleThreadCollapsed = useCallback<ToggleCollapsedId>(
    (threadId) => {
      setCollapsedThreadIdList((current) => {
        return toggleCollapsedIdList({ current, id: threadId });
      });
    },
    [setCollapsedThreadIdList],
  );

  const toggleEnvironmentCollapsed = useCallback<ToggleCollapsedId>(
    (environmentId) => {
      setCollapsedEnvironmentIdList((current) => {
        return toggleCollapsedIdList({ current, id: environmentId });
      });
    },
    [setCollapsedEnvironmentIdList],
  );

  const toggleSidebarSectionCollapsed =
    useCallback<ToggleCollapsedSidebarSectionId>(
      (sectionId) => {
        setCollapsedSidebarSectionIdList((current) => {
          return toggleCollapsedIdList({ current, id: sectionId }).filter(
            isCollapsibleSidebarSectionId,
          );
        });
      },
      [setCollapsedSidebarSectionIdList],
    );

  const pinnedSectionContent = (
    <PinnedThreadTree
      rootNodes={pinnedSidebarState.rootNodes}
      selectedThreadId={selectedThreadId}
      collapsedThreadIds={collapsedThreadIds}
      collapsedEnvironmentIds={collapsedEnvironmentIds}
      onProjectSelect={onProjectSelect}
      onToggleThreadCollapsed={toggleThreadCollapsed}
      onToggleEnvironmentCollapsed={toggleEnvironmentCollapsed}
      isPinnedReorderPending={isPinnedReorderPending}
      onReorderPinnedRoot={handleReorderPinnedRoot}
    />
  );
  const pinnedSectionThreads = threads.filter(
    (thread) =>
      pinnedSidebarState.effectivePinnedThreadIds.has(thread.id) &&
      isSidebarProjectThread(thread),
  );
  const threadsSectionActions = (
    <SidebarThreadsSectionActions
      displayOptionsOpen={threadsDisplayOptionsMenuOpen}
      onDisplayOptionsOpenChange={handleThreadsDisplayOptionsMenuOpenChange}
      isCreatingSection={isCreateThreadSectionPending}
      onNewSection={
        isSectionOrganizationMode ? handleOpenCreateSectionDialog : undefined
      }
      isCreatingProject={isCreatingProject}
      onNewProject={onNewProject}
      onNewThread={handleCreateProjectlessThread}
    />
  );
  const pinnedSection: BuiltInSidebarSectionOptions = {
    activity: getCollapsedChildActivity(pinnedSectionThreads, draftThreadIds),
    collapsedThreads: pinnedSectionThreads,
    label: "Pinned",
    content: pinnedSectionContent,
    actions: renderSectionDisplayOptions("pinned"),
    actionsOpen: isSectionDisplayOptionsOpen("pinned"),
  };
  const threadsSection = {
    label: "Threads",
    actions: threadsSectionActions,
    actionsOpen: threadsDisplayOptionsMenuOpen,
  } satisfies Omit<BuiltInSidebarSectionOptions, "content">;
  const sectionCreateDialog = (
    <ThreadSectionCreateDialog
      errorMessage={sectionCreateErrorMessage}
      open={isSectionCreateDialogOpen}
      pending={isCreateThreadSectionPending}
      onOpenChange={handleCreateSectionDialogOpenChange}
      onCreate={handleCreateThreadSection}
    />
  );
  const sectionRenameDialogContent = (
    <ThreadSectionRenameDialog
      errorMessage={sectionRenameErrorMessage}
      target={sectionRenameDialog.target}
      pending={isUpdateThreadSectionPending}
      onOpenChange={handleRenameThreadSectionOpenChange}
      onRename={handleRenameThreadSection}
    />
  );
  const sectionDeleteDialogContent = (
    <ConfirmDeleteDialog
      open={sectionDeleteDialog.target !== null}
      onOpenChange={handleSectionDeleteDialogOpenChange}
    >
      {sectionDeleteDialog.target ? (
        <ConfirmDeleteDialogContent
          title="Remove section?"
          description="Threads in this section will move back to Threads."
          confirmLabel="Remove section"
          pending={isDeleteThreadSectionPending}
          onConfirm={handleConfirmRemoveThreadSection}
          onCancel={sectionDeleteDialog.onClose}
        />
      ) : null}
    </ConfirmDeleteDialog>
  );

  if (projectsState.status === "loading") {
    return (
      <ProjectListShell>
        <ProjectListNavigationLoadingState />
      </ProjectListShell>
    );
  }

  return (
    <ProjectListShell>
      <ActiveSidebarModeSections
        mode={organizationMode}
        renderMachine={() => (
          <MachineModeSections
            threads={threads}
            draftThreadIds={draftThreadIds}
            effectivePinnedThreadIds={
              pinnedSidebarState.effectivePinnedThreadIds
            }
            status={projectsState.status}
            isReady={Boolean(sidebarNavigation)}
            showPinnedSection={hasPinnedSection}
            pinnedSection={pinnedSection}
            threadsSection={threadsSection}
            selectedThreadId={selectedThreadId}
            collapsedSectionIds={collapsedSidebarSectionIds}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            compareThreads={sidebarThreadComparator}
            renderSectionDisplayOptions={renderSectionDisplayOptions}
            isSectionDisplayOptionsOpen={isSectionDisplayOptionsOpen}
            onProjectSelect={onProjectSelect}
            onToggleCollapsed={toggleSidebarSectionCollapsed}
            onToggleThreadCollapsed={toggleThreadCollapsed}
            onToggleEnvironmentCollapsed={toggleEnvironmentCollapsed}
          />
        )}
        renderChronological={() => (
          <>
            <SectionModeSections
              threads={threads}
              effectivePinnedThreadIds={
                pinnedSidebarState.effectivePinnedThreadIds
              }
              status={projectsState.status}
              isReady={Boolean(sidebarNavigation)}
              showPinnedSection={hasPinnedSection}
              sections={sections}
              pinnedSection={pinnedSection}
              pinnedReorderPending={isPinnedReorderPending}
              pinnedThreads={pinnedRootThreads}
              onReorderPinnedThread={handleReorderPinnedRoot}
              threadsSection={threadsSection}
              selectedThreadId={selectedThreadId}
              collapsedSectionIds={collapsedSidebarSectionIds}
              collapsedThreadIds={collapsedThreadIds}
              collapsedEnvironmentIds={collapsedEnvironmentIds}
              compareThreads={sidebarThreadComparator}
              onProjectSelect={onProjectSelect}
              onCreateThreadInSection={handleCreateThreadInSection}
              onRenameSection={handleOpenRenameThreadSection}
              onRemoveSection={handleRemoveThreadSection}
              renderTopLevelSectionHeaderActions={(section) => {
                const sectionId = buildSidebarEntitySectionId(
                  "section",
                  section.id,
                );
                return {
                  actions: renderSectionDisplayOptions(sectionId),
                  actionsOpen: isSectionDisplayOptionsOpen(sectionId),
                };
              }}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              onToggleThreadCollapsed={toggleThreadCollapsed}
              onToggleEnvironmentCollapsed={toggleEnvironmentCollapsed}
            />
            {sectionCreateDialog}
            {sectionRenameDialogContent}
            {sectionDeleteDialogContent}
          </>
        )}
        renderProject={() => (
          <>
            <ProjectModeSections
              projects={projects ?? EMPTY_PROJECTS}
              threads={threads}
              draftThreadIds={draftThreadIds}
              effectivePinnedThreadIds={
                pinnedSidebarState.effectivePinnedThreadIds
              }
              status={projectsState.status}
              isReady={Boolean(sidebarNavigation)}
              showPinnedSection={hasPinnedSection}
              pinnedSection={pinnedSection}
              threadsSection={threadsSection}
              selectedThreadId={selectedThreadId}
              collapsedSectionIds={collapsedSidebarSectionIds}
              collapsedThreadIds={collapsedThreadIds}
              collapsedEnvironmentIds={collapsedEnvironmentIds}
              compareThreads={sidebarThreadComparator}
              renderSectionDisplayOptions={renderSectionDisplayOptions}
              isSectionDisplayOptionsOpen={isSectionDisplayOptionsOpen}
              onProjectSelect={onProjectSelect}
              onCreateProjectThread={handleCreateProjectThread}
              onToggleCollapsed={toggleSidebarSectionCollapsed}
              onToggleThreadCollapsed={toggleThreadCollapsed}
              onToggleEnvironmentCollapsed={toggleEnvironmentCollapsed}
            />
            {sectionCreateDialog}
            {sectionRenameDialogContent}
            {sectionDeleteDialogContent}
          </>
        )}
      />
    </ProjectListShell>
  );
}

export const ProjectList = memo(ProjectListComponent);
