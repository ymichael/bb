import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type {
  EnvironmentStatus,
  GitBranchRefClassification,
  ThreadPullRequest,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type { PullRequestMergeMethod } from "@bb/server-contract";
import {
  BranchPicker,
  getMergeBaseBranchCandidateGroups,
} from "@/components/pickers/BranchPicker";
import {
  PromptStackCard,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PROMPT_STACK_INLAY_INSET_CLASS,
  PROMPT_STACK_INLAY_SEGMENT_CLASS,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
} from "@bb/shared-ui/activity-row-styles";
import { WorkspaceChangesList } from "@/components/thread/WorkspaceChangesList";
import {
  formatChangeSummary,
  renderChangeSummary,
  toChangeTally,
  type WorkspaceChangedFileSelection,
  type WorkspaceChangedFilesSection,
} from "@/components/workspace/workspace-change-summary";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import {
  getPullRequestAttentionDisplay,
  getPullRequestGithubCheckStatus,
  PULL_REQUEST_STATE_DISPLAY,
} from "@/lib/pull-request-display";
import { PullRequestStatusPill } from "@/components/pull-request/PullRequestStatusPill";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_BANNER_ACTION_FILL_CLASS,
  PROMPT_BANNER_ACTION_SEGMENT_CLASS,
  PromptBannerActionButton,
} from "@/components/promptbox/banner/prompt-banner-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { useUrlAnchorClickHandler } from "@/lib/url-open-routing";

export interface ContextBannerMergeBaseConfig {
  branch: string;
  branchRef?: GitBranchRefClassification | null;
  options?: readonly string[];
  remoteOptions?: readonly string[];
  optionsLoading?: boolean;
  onChange: (branch: string) => void;
  onPickerOpenChange?: (open: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
}

export interface ThreadPromptGitSection {
  changedFiles: WorkspaceChangedFilesSection;
  mergeBase: ContextBannerMergeBaseConfig | null;
  onPromptBannerFileClick: (selection: WorkspaceChangedFileSelection) => void;
}

export interface ThreadPromptParentThreadSection {
  parentThreadTitle: string;
  href: string;
  relationship: "parent" | "fork" | "side-chat";
}

interface ThreadPromptChildThreadItem {
  id: string;
  title: string;
  href: string;
  hasPendingInteraction: boolean;
}

export interface ThreadPromptChildThreadsSection {
  items: readonly ThreadPromptChildThreadItem[];
}

export interface ThreadPromptPullRequestSection {
  pullRequest: ThreadPullRequest;
  actions?: {
    isPending?: boolean;
    onMarkReady?: () => void;
    onMerge?: (method: PullRequestMergeMethod) => void;
    onConvertToDraft?: () => void;
    selectedMergeMethod?: PullRequestMergeMethod;
  };
}

export interface ThreadPromptArchivedSection {
  archivedAt: number;
  onUnarchive?: () => void;
  unarchivePending?: boolean;
}

export interface ThreadPromptEnvironmentGoneSection {
  status: Extract<EnvironmentStatus, "destroying" | "destroyed">;
}

const THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES: ReadonlySet<ThreadRuntimeDisplayStatus> =
  new Set([
    "active",
    "host-reconnecting",
    "provisioning",
    "starting",
    "waiting-for-host",
  ]);

export function isThreadDisplayStatusBannerActive(
  status: ThreadRuntimeDisplayStatus,
): boolean {
  return THREAD_BANNER_ACTIVE_CHILD_RUNTIME_STATUSES.has(status);
}

export type ThreadPromptContextBannerExpandedSection =
  | "git"
  | "parentThread"
  | "childThreads";

export const THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT =
  PROMPT_STACK_CARD_ROW_HEIGHT;

interface ThreadPromptContextBannerProps {
  gitSection: ThreadPromptGitSection | null;
  gitSectionPending: boolean;
  archivedSection: ThreadPromptArchivedSection | null;
  environmentGoneSection: ThreadPromptEnvironmentGoneSection | null;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  childThreadsSection: ThreadPromptChildThreadsSection | null;
  pullRequestSection: ThreadPromptPullRequestSection | null;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

const KIND_PREFIX: Record<WorkspaceChangedFilesSection["kind"], string> = {
  uncommitted: "Uncommitted",
  untracked: "Untracked",
  committed: "Committed",
};

const ARCHIVED_THREAD_STATUS_LABEL = "Thread is archived";
const ENVIRONMENT_GONE_STATUS_COPY: Record<
  ThreadPromptEnvironmentGoneSection["status"],
  { ariaLabel: string; label: string }
> = {
  destroying: {
    ariaLabel: "This environment is being archived.",
    label: "Archiving environment...",
  },
  destroyed: {
    ariaLabel: "This environment has been archived.",
    label: "Environment archived",
  },
};

const SECTION_IDS = {
  parentThread: {
    toggle: "thread-prompt-banner-parent-thread-toggle",
    body: "thread-prompt-banner-parent-thread-body",
  },
  childThreads: {
    toggle: "thread-prompt-banner-child-threads-toggle",
    body: "thread-prompt-banner-child-threads-body",
  },
  git: {
    toggle: "thread-prompt-banner-git-toggle",
    body: "thread-prompt-banner-git-body",
  },
} as const;

const SEGMENT_SHRINK_CLASS = "min-w-0 overflow-hidden";

function ChildThreadIcon({ className }: { className?: string }) {
  return (
    <Icon
      name="ChevronDown"
      className={cn("size-3.5 shrink-0 rotate-45", className)}
      aria-hidden="true"
    />
  );
}

interface SectionToggleButtonProps {
  id: string;
  controlsId: string;
  ariaLabel?: string;
  icon: ReactNode;
  label: ReactNode;
  compactLabel?: ReactNode;
  hideLabelInCompact?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

function SectionToggleButton({
  id,
  controlsId,
  ariaLabel,
  icon,
  label,
  compactLabel,
  hideLabelInCompact = true,
  isExpanded,
  onToggle,
}: SectionToggleButtonProps) {
  return (
    <button
      type="button"
      id={id}
      aria-expanded={isExpanded}
      aria-controls={controlsId}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={cn(
        "flex cursor-pointer items-center text-xs transition-colors",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        "hover:bg-state-hover",
        SEGMENT_SHRINK_CLASS,
        label !== null && label !== undefined ? "gap-1.5" : "gap-0",
        isExpanded ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {icon}
      {label !== null && label !== undefined ? (
        <span
          className="min-w-0 truncate"
          data-promptbox-hide-compact={hideLabelInCompact ? "" : undefined}
        >
          {label}
        </span>
      ) : null}
      {hideLabelInCompact &&
      compactLabel !== null &&
      compactLabel !== undefined ? (
        <span className="min-w-0 truncate" data-promptbox-compact-label="">
          {compactLabel}
        </span>
      ) : null}
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-200",
          isExpanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

const PARENT_SECTION_COPY: Record<
  ThreadPromptParentThreadSection["relationship"],
  { verb: string; bodyLead: string; ariaPrefix: string }
> = {
  parent: {
    verb: "Parent",
    bodyLead: "This thread is a child of ",
    ariaPrefix: "Parent thread",
  },
  fork: {
    verb: "Forked from",
    bodyLead: "This thread was forked from ",
    ariaPrefix: "Forked from",
  },
  "side-chat": {
    verb: "Side chat of",
    bodyLead: "This thread is a side chat of ",
    ariaPrefix: "Side chat of",
  },
};

const PARENT_SECTION_ICON: Record<
  ThreadPromptParentThreadSection["relationship"],
  IconName
> = {
  parent: "UserRound",
  fork: "Fork",
  "side-chat": "SideChat",
};

function parentSectionAriaLabel(
  section: ThreadPromptParentThreadSection,
): string {
  return `${PARENT_SECTION_COPY[section.relationship].ariaPrefix} ${section.parentThreadTitle}`;
}

function shouldShowPullRequestAttentionLabel(
  pullRequest: ThreadPullRequest,
): boolean {
  return (
    pullRequest.attention === "checks_failed" ||
    pullRequest.attention === "changes_requested" ||
    pullRequest.attention === "review_requested" ||
    pullRequest.attention === "conflicts" ||
    pullRequest.attention === "blocked"
  );
}

function ParentThreadBody({
  parentThreadTitle,
  href,
  relationship,
}: {
  parentThreadTitle: string;
  href: string;
  relationship: ThreadPromptParentThreadSection["relationship"];
}) {
  return (
    <div className="px-3 pb-2 pt-1.5 text-xs leading-relaxed text-muted-foreground">
      {PARENT_SECTION_COPY[relationship].bodyLead}
      <NavLink
        to={href}
        className="text-foreground/90 underline underline-offset-2"
      >
        {parentThreadTitle}
      </NavLink>
      .
    </div>
  );
}

function ChildThreadsBody({
  items,
}: {
  items: readonly ThreadPromptChildThreadItem[];
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
            {item.hasPendingInteraction ? (
              <Icon
                name="CircleQuestion"
                className="size-3.5 shrink-0 text-muted-foreground/75 no-underline"
                aria-hidden="true"
              />
            ) : (
              <ChildThreadIcon className="text-subtle-foreground no-underline" />
            )}
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.hasPendingInteraction ? (
              <span className="shrink-0 text-muted-foreground">
                Needs input
              </span>
            ) : null}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function BannerActionSlot({
  children,
  hideInCompact = false,
}: {
  children: ReactNode;
  hideInCompact?: boolean;
}) {
  return (
    <div
      className="ml-auto flex shrink-0 items-center gap-1.5 pr-2 text-xs text-muted-foreground"
      data-promptbox-hide-compact={hideInCompact ? "" : undefined}
      data-promptbox-hide-tiny=""
    >
      {children}
    </div>
  );
}

const PromptBannerActionGroup = ({ children }: { children: ReactNode }) => (
  <div
    className={cn(
      "inline-flex overflow-hidden rounded border border-border",
      PROMPT_BANNER_ACTION_FILL_CLASS,
    )}
  >
    {children}
  </div>
);

const PromptBannerActionSegmentButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PromptBannerActionSegmentButton(
  { className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "px-1.5 py-0.5",
        PROMPT_BANNER_ACTION_SEGMENT_CLASS,
        className,
      )}
      {...props}
    />
  );
});

function ThreadUnarchiveTextAction({
  isPending,
  onUnarchive,
}: {
  isPending?: boolean;
  onUnarchive: () => void;
}) {
  return (
    <PromptBannerActionButton
      onClick={onUnarchive}
      disabled={Boolean(isPending)}
    >
      {isPending ? "Unarchiving..." : "Unarchive"}
    </PromptBannerActionButton>
  );
}

function PullRequestReadyTextAction({
  disabled,
  onMarkReady,
}: {
  disabled?: boolean;
  onMarkReady: () => void;
}) {
  return (
    <PromptBannerActionButton
      onClick={onMarkReady}
      disabled={Boolean(disabled)}
    >
      {disabled ? "Marking..." : "Mark ready"}
    </PromptBannerActionButton>
  );
}

const PULL_REQUEST_MERGE_ACTIONS: readonly {
  method: PullRequestMergeMethod;
  label: string;
}[] = [
  { method: "merge", label: "Merge" },
  { method: "squash", label: "Squash merge" },
  { method: "rebase", label: "Rebase and merge" },
];

function PullRequestMergeSplitButton({
  disabled,
  onConvertToDraft,
  onMerge,
  selectedMethod,
}: {
  disabled?: boolean;
  onConvertToDraft?: () => void;
  onMerge: (method: PullRequestMergeMethod) => void;
  selectedMethod: PullRequestMergeMethod;
}) {
  const selectedAction =
    PULL_REQUEST_MERGE_ACTIONS.find(
      (action) => action.method === selectedMethod,
    ) ?? PULL_REQUEST_MERGE_ACTIONS[0];
  return (
    <PromptBannerActionGroup>
      <PromptBannerActionSegmentButton
        disabled={Boolean(disabled)}
        onClick={() => onMerge(selectedAction.method)}
      >
        {selectedAction.label}
      </PromptBannerActionSegmentButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PromptBannerActionSegmentButton
            disabled={Boolean(disabled)}
            className={cn(
              "inline-flex items-center border-l border-border px-1 data-[state=open]:bg-state-active data-[state=open]:text-foreground",
            )}
            aria-label="Choose pull request merge method"
          >
            <Icon name="ChevronDown" className="size-3" aria-hidden="true" />
          </PromptBannerActionSegmentButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={2}
          mobileTitle="Merge pull request"
        >
          {PULL_REQUEST_MERGE_ACTIONS.map((action) => (
            <DropdownMenuItem
              key={action.method}
              onSelect={() => onMerge(action.method)}
              textValue={action.label}
            >
              {action.label}
            </DropdownMenuItem>
          ))}
          {onConvertToDraft ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onConvertToDraft}
                textValue="Convert to draft"
              >
                Convert to draft
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </PromptBannerActionGroup>
  );
}

function PullRequestBannerLink({
  pullRequest,
  hideLabelInCompact,
  showLabel,
  showStateLabel,
}: {
  pullRequest: ThreadPullRequest;
  hideLabelInCompact: boolean;
  showLabel: boolean;
  showStateLabel: boolean;
}) {
  const attentionDisplay = getPullRequestAttentionDisplay(pullRequest);
  const stateDisplay = PULL_REQUEST_STATE_DISPLAY[pullRequest.state];
  const handlePullRequestClick = useUrlAnchorClickHandler(pullRequest.url);
  const showAttentionLabel =
    showLabel && shouldShowPullRequestAttentionLabel(pullRequest);
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handlePullRequestClick}
      aria-label={`Pull request ${pullRequest.number}: ${attentionDisplay.label}`}
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground no-underline transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        PROMPT_STACK_INLAY_SEGMENT_CLASS,
        getPullRequestGithubCheckStatus(pullRequest) !== null
          ? "min-w-13"
          : "min-w-8",
        "overflow-hidden",
      )}
    >
      <PullRequestStatusPill pullRequest={pullRequest} className="h-4" />
      {showLabel ? (
        <span
          className="min-w-0 truncate"
          data-promptbox-hide-compact={hideLabelInCompact ? "" : undefined}
        >
          PR #{pullRequest.number}
          {showStateLabel && pullRequest.state !== "open"
            ? ` · ${stateDisplay.label}`
            : ""}
        </span>
      ) : null}
      {showAttentionLabel ? (
        <span className={cn("min-w-0 truncate", attentionDisplay.className)}>
          · {attentionDisplay.label}
        </span>
      ) : null}
    </a>
  );
}

const CHILD_THREADS_HEADER_BUTTON_CLASS =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";

function childThreadsLabel(args: {
  count: number;
  pendingCount: number;
}): string {
  if (args.pendingCount > 0) {
    return `${args.pendingCount} child ${args.pendingCount === 1 ? "thread needs" : "threads need"} input`;
  }
  return `${args.count} active child ${args.count === 1 ? "thread" : "threads"}`;
}

function ActiveChildThreadsCard({
  childThreadsSection,
  isExpanded,
  onToggle,
}: {
  childThreadsSection: ThreadPromptChildThreadsSection;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const items = [...childThreadsSection.items].sort((left, right) =>
    left.hasPendingInteraction === right.hasPendingInteraction
      ? 0
      : left.hasPendingInteraction
        ? -1
        : 1,
  );
  const primary = items[0];
  if (!primary) {
    return null;
  }
  const pendingCount = items.filter(
    (item) => item.hasPendingInteraction,
  ).length;
  const otherCount = items.length - 1;
  const groupLabel = childThreadsLabel({
    count: items.length,
    pendingCount,
  });
  const needsApproval = pendingCount > 0;
  return (
    <PromptStackCard
      ariaLabel="Child threads"
      className="overflow-hidden"
      style={{ minHeight: THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={SECTION_IDS.childThreads.toggle}
          aria-expanded={isExpanded}
          aria-controls={SECTION_IDS.childThreads.body}
          aria-label={`${groupLabel}: ${primary.title}`}
          onClick={onToggle}
          className={
            needsApproval
              ? CHILD_THREADS_HEADER_BUTTON_CLASS
              : activityRowClass("active", CHILD_THREADS_HEADER_BUTTON_CLASS)
          }
        >
          <Icon
            name={needsApproval ? "CircleQuestion" : "UserRound"}
            className={
              needsApproval
                ? "size-3.5 shrink-0 text-muted-foreground/75"
                : activityIconClass("active", "size-3.5 shrink-0")
            }
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="text-muted-foreground">
              {needsApproval ? "Needs your input: " : "Active child thread: "}
            </span>
            <span className="font-medium text-foreground/80">
              {primary.title}
            </span>
          </span>
          {otherCount > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              +{otherCount} more
            </span>
          ) : null}
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              isExpanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <AnimatedBody
        collapsedBorder="reserve"
        id={SECTION_IDS.childThreads.body}
        labelledBy={SECTION_IDS.childThreads.toggle}
        isExpanded={isExpanded}
      >
        <ChildThreadsBody items={items} />
      </AnimatedBody>
    </PromptStackCard>
  );
}

interface ReadOnlyContextBannerProps {
  iconName: IconName;
  statusAriaLabel: string;
  statusLabel: string;
  parentThreadSection: ThreadPromptParentThreadSection | null;
  statusAction: ReactNode;
  expandedSection: ThreadPromptContextBannerExpandedSection | null;
  onToggleSection: (section: ThreadPromptContextBannerExpandedSection) => void;
}

function ReadOnlyContextBanner({
  iconName,
  statusAriaLabel,
  statusLabel,
  parentThreadSection,
  statusAction,
  expandedSection,
  onToggleSection,
}: ReadOnlyContextBannerProps) {
  const isParentThreadExpanded =
    expandedSection === "parentThread" && parentThreadSection !== null;
  const hasMultipleSegments = parentThreadSection !== null;
  const showStatusAction = statusAction !== null && !hasMultipleSegments;
  return (
    <PromptStackCard
      ariaLabel="Thread context before sending"
      className="overflow-hidden"
      style={{ minHeight: THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 text-xs text-muted-foreground",
          PROMPT_STACK_INLAY_INSET_CLASS,
        )}
      >
        {parentThreadSection ? (
          <SectionToggleButton
            id={SECTION_IDS.parentThread.toggle}
            controlsId={SECTION_IDS.parentThread.body}
            ariaLabel={parentSectionAriaLabel(parentThreadSection)}
            icon={
              <Icon
                name={PARENT_SECTION_ICON[parentThreadSection.relationship]}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
            }
            label={null}
            isExpanded={isParentThreadExpanded}
            onToggle={() => onToggleSection("parentThread")}
          />
        ) : null}
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-xs",
            PROMPT_STACK_INLAY_SEGMENT_CLASS,
          )}
          role="status"
          aria-label={statusAriaLabel}
        >
          <Icon
            name={iconName}
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate" aria-hidden="true">
            {statusLabel}
          </span>
        </div>
        {showStatusAction ? (
          <BannerActionSlot>{statusAction}</BannerActionSlot>
        ) : null}
      </div>
      {parentThreadSection ? (
        <AnimatedBody
          collapsedBorder="reserve"
          id={SECTION_IDS.parentThread.body}
          labelledBy={SECTION_IDS.parentThread.toggle}
          isExpanded={isParentThreadExpanded}
        >
          <ParentThreadBody
            parentThreadTitle={parentThreadSection.parentThreadTitle}
            href={parentThreadSection.href}
            relationship={parentThreadSection.relationship}
          />
        </AnimatedBody>
      ) : null}
    </PromptStackCard>
  );
}

export function ThreadPromptContextBanner({
  gitSection,
  gitSectionPending,
  archivedSection,
  environmentGoneSection,
  parentThreadSection,
  childThreadsSection,
  pullRequestSection,
  expandedSection,
  onToggleSection,
}: ThreadPromptContextBannerProps) {
  if (archivedSection || environmentGoneSection) {
    const environmentGone = environmentGoneSection !== null;
    const environmentGoneCopy = environmentGoneSection
      ? ENVIRONMENT_GONE_STATUS_COPY[environmentGoneSection.status]
      : null;
    return (
      <ReadOnlyContextBanner
        iconName={environmentGone ? "CircleX" : "Archive"}
        statusAriaLabel={
          environmentGoneCopy?.ariaLabel ?? ARCHIVED_THREAD_STATUS_LABEL
        }
        statusLabel={environmentGoneCopy?.label ?? ARCHIVED_THREAD_STATUS_LABEL}
        statusAction={
          archivedSection?.onUnarchive && !environmentGone ? (
            <ThreadUnarchiveTextAction
              isPending={archivedSection.unarchivePending}
              onUnarchive={archivedSection.onUnarchive}
            />
          ) : null
        }
        parentThreadSection={parentThreadSection}
        expandedSection={expandedSection}
        onToggleSection={onToggleSection}
      />
    );
  }
  if (gitSectionPending) {
    return null;
  }
  const showGit = gitSection !== null;
  const showParentThread = parentThreadSection !== null;
  const showChildThreads =
    childThreadsSection !== null && childThreadsSection.items.length > 0;
  const showPullRequest = pullRequestSection !== null;
  if (!showGit && !showParentThread && !showChildThreads && !showPullRequest) {
    return null;
  }
  const visibleSegmentCount =
    Number(showParentThread) + Number(showPullRequest) + Number(showGit);
  const hasSingleVisibleSegment = visibleSegmentCount === 1;
  const isPullRequestAndGitOnly =
    showPullRequest && showGit && visibleSegmentCount === 2;
  const isGitExpanded = expandedSection === "git" && showGit;
  const isParentThreadExpanded =
    expandedSection === "parentThread" && showParentThread;
  const isChildThreadsExpanded =
    expandedSection === "childThreads" && showChildThreads;
  const activeChildThreadsCard =
    showChildThreads && childThreadsSection ? (
      <ActiveChildThreadsCard
        childThreadsSection={childThreadsSection}
        isExpanded={isChildThreadsExpanded}
        onToggle={() => onToggleSection("childThreads")}
      />
    ) : null;
  const gitTally = showGit
    ? toChangeTally(gitSection.changedFiles.stats)
    : null;
  const gitSummaryText = gitTally ? formatChangeSummary(gitTally) : "";
  const gitSummaryPrefix = showGit
    ? KIND_PREFIX[gitSection.changedFiles.kind]
    : "";
  const gitSummary: ReactNode =
    showGit && gitTally ? (
      <>
        {gitSummaryPrefix} · {renderChangeSummary(gitTally)}
      </>
    ) : null;

  const mergeBaseCandidates =
    showGit && gitSection.mergeBase
      ? getMergeBaseBranchCandidateGroups({
          mergeBaseBranch: gitSection.mergeBase.branch,
          mergeBaseBranchRef: gitSection.mergeBase.branchRef,
          mergeBaseBranchOptions: gitSection.mergeBase.options,
          remoteMergeBaseBranchOptions: gitSection.mergeBase.remoteOptions,
        })
      : { options: [], remoteOptions: [] };
  const segmentAction =
    hasSingleVisibleSegment && showGit && gitSection.mergeBase ? (
      <BannerActionSlot hideInCompact>
        <Icon
          name="GitMerge"
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span className="shrink-0">Merge base</span>
        <BranchPicker
          value={gitSection.mergeBase.branch}
          options={mergeBaseCandidates.options}
          remoteOptions={mergeBaseCandidates.remoteOptions}
          variant="minimal"
          emphasizeTriggerValue={false}
          loading={gitSection.mergeBase.optionsLoading}
          onChange={gitSection.mergeBase.onChange}
          onOpenChange={gitSection.mergeBase.onPickerOpenChange}
          onSearchQueryChange={gitSection.mergeBase.onSearchQueryChange}
          className="max-w-[10rem]"
          muted
          popoverAlign="end"
        />
      </BannerActionSlot>
    ) : null;

  const isParentThreadOnly = showParentThread && !showGit && !showPullRequest;

  const pullRequest = pullRequestSection?.pullRequest ?? null;
  const showPullRequestLabel =
    hasSingleVisibleSegment || isPullRequestAndGitOnly;
  const pullRequestActions = pullRequestSection?.actions;
  const pullRequestAction =
    pullRequest && pullRequestActions ? (
      pullRequest.state === "draft" && pullRequestActions.onMarkReady ? (
        <BannerActionSlot>
          <PullRequestReadyTextAction
            disabled={pullRequestActions.isPending}
            onMarkReady={pullRequestActions.onMarkReady}
          />
        </BannerActionSlot>
      ) : pullRequest.state === "open" &&
        pullRequest.mergeability.state === "mergeable" &&
        pullRequestActions.onMerge ? (
        <BannerActionSlot>
          <PullRequestMergeSplitButton
            disabled={pullRequestActions.isPending}
            onConvertToDraft={pullRequestActions.onConvertToDraft}
            onMerge={pullRequestActions.onMerge}
            selectedMethod={pullRequestActions.selectedMergeMethod ?? "merge"}
          />
        </BannerActionSlot>
      ) : null
    ) : null;

  const compactContextBanner =
    visibleSegmentCount > 0 ? (
      <PromptStackCard
        ariaLabel="Thread context before sending"
        className="overflow-hidden"
        style={{ minHeight: THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT }}
      >
        <div
          className={cn(
            "flex items-center gap-0.5 text-xs text-muted-foreground",
            PROMPT_STACK_INLAY_INSET_CLASS,
          )}
        >
          {}
          {showParentThread && parentThreadSection && isParentThreadOnly ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 text-xs",
                PROMPT_STACK_INLAY_SEGMENT_CLASS,
              )}
              title={parentSectionAriaLabel(parentThreadSection)}
            >
              <Icon
                name={PARENT_SECTION_ICON[parentThreadSection.relationship]}
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0 truncate">
                {PARENT_SECTION_COPY[parentThreadSection.relationship].verb}{" "}
                <NavLink
                  to={parentThreadSection.href}
                  className="text-foreground/90 underline underline-offset-2"
                >
                  {parentThreadSection.parentThreadTitle}
                </NavLink>
              </span>
            </div>
          ) : null}
          {showParentThread && parentThreadSection && !isParentThreadOnly ? (
            <SectionToggleButton
              id={SECTION_IDS.parentThread.toggle}
              controlsId={SECTION_IDS.parentThread.body}
              ariaLabel={parentSectionAriaLabel(parentThreadSection)}
              icon={
                <Icon
                  name={PARENT_SECTION_ICON[parentThreadSection.relationship]}
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
              }
              label={null}
              isExpanded={isParentThreadExpanded}
              onToggle={() => onToggleSection("parentThread")}
            />
          ) : null}
          {showPullRequest && pullRequest ? (
            <PullRequestBannerLink
              pullRequest={pullRequest}
              hideLabelInCompact={!hasSingleVisibleSegment}
              showLabel={showPullRequestLabel}
              showStateLabel={hasSingleVisibleSegment}
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
              compactLabel={gitTally ? renderChangeSummary(gitTally) : null}
              hideLabelInCompact={visibleSegmentCount > 2}
              ariaLabel={`Changed files: ${gitSummaryPrefix}, ${gitSummaryText}`}
              isExpanded={isGitExpanded}
              onToggle={() => onToggleSection("git")}
            />
          ) : null}
          {pullRequestAction}
          {segmentAction}
        </div>
        {showParentThread && parentThreadSection && !isParentThreadOnly ? (
          <AnimatedBody
            collapsedBorder="reserve"
            id={SECTION_IDS.parentThread.body}
            labelledBy={SECTION_IDS.parentThread.toggle}
            isExpanded={isParentThreadExpanded}
          >
            <ParentThreadBody
              parentThreadTitle={parentThreadSection.parentThreadTitle}
              href={parentThreadSection.href}
              relationship={parentThreadSection.relationship}
            />
          </AnimatedBody>
        ) : null}
        {showGit ? (
          <AnimatedBody
            collapsedBorder="reserve"
            id={SECTION_IDS.git.body}
            labelledBy={SECTION_IDS.git.toggle}
            isExpanded={isGitExpanded}
          >
            <WorkspaceChangesList
              files={gitSection.changedFiles.files}
              className="max-h-32 px-3 pb-2 pt-1"
              onFileClick={(file) =>
                gitSection.onPromptBannerFileClick({
                  file,
                  section: gitSection.changedFiles,
                })
              }
            />
          </AnimatedBody>
        ) : null}
      </PromptStackCard>
    ) : null;

  if (activeChildThreadsCard && compactContextBanner) {
    return (
      <div className="min-w-0 space-y-2">
        {activeChildThreadsCard}
        {compactContextBanner}
      </div>
    );
  }

  return activeChildThreadsCard ?? compactContextBanner;
}
