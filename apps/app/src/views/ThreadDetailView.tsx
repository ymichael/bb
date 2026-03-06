import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Check,
  ChevronsDown,
  ChevronsUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  CornerDownRight,
  GripVertical,
  Loader2,
  Pencil,
  Rows2,
  Trash2,
} from "lucide-react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  useThread,
  useThreadWorkStatus,
  useThreadTimeline,
  useThreadGitDiff,
  useThreadToolGroupMessages,
  useTellThread,
  useEnqueueThreadMessage,
  useSendQueuedThreadMessage,
  useDeleteQueuedThreadMessage,
  useRequestThreadOperation,
  usePromoteThread,
  useDemotePrimaryCheckout,
  useStopThread,
  useMarkThreadRead,
  useUnarchiveThread,
  useThreadDefaultExecutionOptions,
  useUploadPromptAttachment,
} from "../hooks/useApi";
import {
  ConversationEntry,
} from "@/components/messages/ConversationEntry";
import {
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { ConversationWorkingIndicator } from "@/components/messages/ConversationWorkingIndicator";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useScrollToBottomIndicator } from "@/hooks/useScrollToBottomIndicator";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePreferredTheme } from "@/hooks/useTheme";
import { PageShell } from "@/components/layout/PageShell";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";
import { ScrollToBottomButton } from "@/components/shared/ScrollToBottomButton";
import {
  ConversationEmptyState,
  ConversationTimeline,
  ExpandablePanel,
  PromptComposerShell,
} from "@beanbag/ui-core";
import {
  toRecord,
  type PromptInput,
  type ThreadQueuedMessage,
  type UIMessage,
} from "@beanbag/agent-core";
import { type ThreadDetailToolGroupRow } from "./threadDetailRows";
import {
  findLatestActivityMessageId,
  findLatestActivityRowId,
  shouldHighlightLatestActivity,
} from "./threadDetailActivity";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import {
  promptDraftToInput,
  type PromptDraftState,
} from "@/lib/prompt-draft";
import { openThreadPathInEditor } from "@/lib/api";
import { getPathCommandForTarget } from "@/lib/open-path-preferences";
import { getAutoArchivePreferences } from "@/lib/auto-archive-preferences";
import { StatusPillCommitPopover } from "@/components/shared/StatusPillCommitPopover";
import { StatusPill, type StatusPillVariant } from "@/components/shared/StatusPill";
import { WorkspaceChangesList } from "@/components/shared/WorkspaceChangesList";
import { ArchiveTimestampAction } from "@/components/shared/ArchiveTimestampAction";
import { ThreadContextWindowIndicator } from "@/components/thread/ThreadContextWindowIndicator";
import {
  threadWorktreeCleanLabel,
  threadWorkStatusLabel,
  threadWorkStatusVariant,
} from "@/lib/thread-work-status";
import {
  formatChangeSummary,
  formatWorkspaceChangeSummary,
} from "@/lib/workspace-change-summary";
import {
  isThreadGitDiffPanelOpen,
  withThreadGitDiffPanelOpen,
} from "@/lib/thread-git-diff-panel";
import { cn } from "@/lib/utils";

const SCROLL_THRESHOLD = 40;
const QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS = 220;
const GIT_DIFF_PANEL_MIN_SIZE_PERCENT = 24;
const GIT_DIFF_PANEL_MAX_SIZE_PERCENT = 70;
const GIT_DIFF_PANEL_DEFAULT_SIZE_PERCENT = 50;
const TIMELINE_PANEL_DEFAULT_SIZE_PERCENT = 50;
const GIT_DIFF_FILE_RENDER_SPINNER_MS = 150;
const GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX = 760;
const GIT_DIFF_PARSE_BATCH_THRESHOLD = 24;
const GIT_DIFF_PARSE_INITIAL_BATCH_SIZE = 6;
const GIT_DIFF_PARSE_BATCH_SIZE = 18;
const GIT_DIFF_PARSE_BATCH_DELAY_MS = 24;
const GIT_DIFF_FILE_INITIAL_RENDER_COUNT = 4;
const GIT_DIFF_FILE_RENDER_BATCH_SIZE = 6;
const GIT_DIFF_FILE_INITIAL_DELAY_MS = 30;
const GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS = 70;
const GIT_DIFF_PANEL_SKELETON_FILE_COUNT = 3;
const GIT_DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
  disableFileHeader: false,
} as const;
const GIT_DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

function parseGitDiffFiles(diff: string): ReturnType<typeof parsePatchFiles>[number]["files"] {
  if (diff.trim().length === 0) return [];
  try {
    return parsePatchFiles(diff).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

type ParsedGitDiffFile = ReturnType<typeof parsePatchFiles>[number]["files"][number];

function splitGitDiffIntoPatchChunks(diff: string): string[] {
  const trimmedDiff = diff.trim();
  if (trimmedDiff.length === 0) return [];

  const lines = diff.split("\n");
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let hasGitPatchHeader = false;

  for (const line of lines) {
    const startsPatch = line.startsWith("diff --git ");
    if (startsPatch) {
      hasGitPatchHeader = true;
    }
    if (startsPatch && currentChunk.length > 0) {
      chunks.push(currentChunk.join("\n"));
      currentChunk = [line];
      continue;
    }
    currentChunk.push(line);
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n"));
  }

  if (!hasGitPatchHeader) {
    return [diff];
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function parseGitDiffPatchChunks(patchChunks: readonly string[]): ParsedGitDiffFile[] {
  const files: ParsedGitDiffFile[] = [];
  for (const chunk of patchChunks) {
    files.push(...parseGitDiffFiles(chunk));
  }
  return files;
}

function getGitDiffParseKey(diff: string): string {
  return `${diff.length}:${diff.slice(0, 120)}:${diff.slice(-120)}`;
}

interface GitDiffStats {
  files: number;
  additions: number;
  deletions: number;
}

function summarizeGitDiff(files: ParsedGitDiffFile[], diff: string): GitDiffStats {
  if (files.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      for (const hunk of file.hunks) {
        additions += hunk.additionCount;
        deletions += hunk.deletionCount;
      }
    }
    return { files: files.length, additions, deletions };
  }

  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      fileCount += 1;
      continue;
    }
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return {
    files: fileCount > 0 ? fileCount : additions > 0 || deletions > 0 ? 1 : 0,
    additions,
    deletions,
  };
}

function summarizeGitDiffFile(file: ParsedGitDiffFile): Pick<GitDiffStats, "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionCount;
    deletions += hunk.deletionCount;
  }
  return { additions, deletions };
}

function formatGitDiffFileLabel(file: ParsedGitDiffFile): string {
  if (file.prevName && file.prevName !== file.name) {
    return `${file.prevName} → ${file.name}`;
  }
  return file.name;
}

function getParsedGitDiffFileKey(file: ParsedGitDiffFile, index: number): string {
  return `${file.name}:${file.prevName ?? ""}:${index}`;
}

function getGitDiffPathAliases(path: string | undefined): string[] {
  if (!path || path === "/dev/null") return [];
  const normalizedPath = path.startsWith("./")
    ? path.slice(2)
    : path;
  if (normalizedPath.length === 0) return [];
  const aliases = [normalizedPath];
  if (normalizedPath.startsWith("a/") || normalizedPath.startsWith("b/")) {
    aliases.push(normalizedPath.slice(2));
  }
  return Array.from(new Set(aliases.filter((alias) => alias.length > 0)));
}

function doesGitDiffFileMatchPath(
  file: ParsedGitDiffFile,
  targetPath: string,
): boolean {
  const targetAliases = new Set(getGitDiffPathAliases(targetPath));
  if (targetAliases.size === 0) return false;

  for (const candidatePath of [file.name, file.prevName]) {
    for (const alias of getGitDiffPathAliases(candidatePath)) {
      if (targetAliases.has(alias)) {
        return true;
      }
    }
  }
  return false;
}

function getOpenableGitDiffPath(file: ParsedGitDiffFile): string | null {
  for (const candidatePath of [file.name, file.prevName]) {
    const aliases = getGitDiffPathAliases(candidatePath);
    if (aliases.length > 0) {
      return aliases[aliases.length - 1] ?? null;
    }
  }
  return null;
}

interface GitDiffSelectionOption {
  value: string;
  label: string;
}

function GitDiffPanelSkeleton({
  count = GIT_DIFF_PANEL_SKELETON_FILE_COUNT,
}: {
  count?: number;
}) {
  return (
    <div className="space-y-2 pt-2">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={`git-diff-skeleton-${index}`}
          className="rounded-md border border-border/70 bg-muted/35"
        >
          <div className="border-b border-border/60 bg-background px-2.5 py-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <Skeleton className="size-4 shrink-0 rounded-sm" />
                <Skeleton className="h-3 w-48 max-w-full rounded-sm" />
              </div>
              <Skeleton className="h-3 w-14 shrink-0 rounded-sm" />
            </div>
          </div>
          <div className="space-y-1.5 px-2.5 py-2">
            <Skeleton className="h-3 w-full rounded-sm" />
            <Skeleton className="h-3 w-[94%] rounded-sm" />
            <Skeleton className="h-3 w-[90%] rounded-sm" />
            <Skeleton className="h-3 w-[86%] rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}

function GitDiffSelector({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: readonly GitDiffSelectionOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-8 w-full min-w-0 justify-between gap-2 px-2 text-xs font-normal",
            disabled && "opacity-60",
          )}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] max-w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => onChange(option.value)}
            className="flex items-center justify-between gap-2"
          >
            <span className="truncate" title={option.label}>
              {option.label}
            </span>
            <Check className={cn("size-3.5", option.value === value ? "opacity-100" : "opacity-0")} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) return "Attachment";
  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

function countQueuedMessageAttachments(input: PromptInput[]): number {
  let count = 0;
  for (const chunk of input) {
    if (chunk.type === "localImage" || chunk.type === "localFile") {
      count += 1;
    }
  }
  return count;
}

function formatQueuedFollowUpPreview(input: PromptInput[]): string {
  const text = input
    .filter((chunk): chunk is Extract<PromptInput, { type: "text" }> => chunk.type === "text")
    .map((chunk) => chunk.text.trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    if (trimmedText.length <= QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS) {
      return trimmedText;
    }
    return `${trimmedText.slice(0, QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS - 1)}…`;
  }

  const attachmentCount = countQueuedMessageAttachments(input);
  if (attachmentCount === 1) {
    const firstAttachment = input.find(
      (chunk) => chunk.type === "localImage" || chunk.type === "localFile",
    );
    if (firstAttachment) {
      if (firstAttachment.type === "localFile" && firstAttachment.name) {
        return `Attachment only (${firstAttachment.name})`;
      }
      return `Attachment only (${getFileNameFromPath(firstAttachment.path)})`;
    }
    return "Attachment only (1 file)";
  }
  if (attachmentCount > 1) {
    return `Attachment only (${attachmentCount} files)`;
  }

  return "(empty message)";
}

function queuedInputToDraft(input: PromptInput[]): PromptDraftState {
  const textSegments: string[] = [];
  const attachments: PromptDraftState["attachments"] = [];

  for (const chunk of input) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        textSegments.push(chunk.text);
      }
      continue;
    }

    if (chunk.type === "localImage") {
      attachments.push({
        type: "localImage",
        path: chunk.path,
        name: getFileNameFromPath(chunk.path),
        sizeBytes: 0,
      });
      continue;
    }

    if (chunk.type === "localFile") {
      attachments.push({
        type: "localFile",
        path: chunk.path,
        name: chunk.name ?? getFileNameFromPath(chunk.path),
        sizeBytes: chunk.sizeBytes ?? 0,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      });
      continue;
    }

    // Open provider/runtime input variant: URL images are intentionally ignored
    // by the prompt draft editor because we cannot map them to local attachments.
  }

  return {
    text: textSegments.join("\n\n"),
    attachments,
  };
}

function isPromptInputChunk(value: unknown): value is PromptInput {
  const record = toRecord(value);
  if (!record) return false;

  const type = record.type;
  if (typeof type !== "string") return false;
  if (type === "text") {
    return typeof record.text === "string";
  }
  if (type === "image") {
    return typeof record.url === "string";
  }
  if (type === "localImage" || type === "localFile") {
    return typeof record.path === "string";
  }
  return false;
}

function isThreadQueuedMessage(value: unknown): value is ThreadQueuedMessage {
  const record = toRecord(value);
  if (!record || typeof record.id !== "string") return false;
  if (!Array.isArray(record.input)) return false;
  return record.input.every(isPromptInputChunk);
}

function extractThreadQueuedMessages(thread: unknown): ThreadQueuedMessage[] {
  const record = toRecord(thread);
  const queuedMessages = record?.queuedMessages;
  if (!Array.isArray(queuedMessages)) return [];
  return queuedMessages.filter(isThreadQueuedMessage);
}

function QueuedFollowUpList({
  queuedMessages,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  onSendImmediately,
  onEdit,
  onDelete,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  sendDisabled: boolean;
  actionDisabled: boolean;
  processingMessageId: string | null;
  onSendImmediately: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (queuedMessages.length === 0) return null;

  return (
    <section
      aria-label="Queued follow-up messages"
      className="mb-2 overflow-hidden rounded-md border border-border/60 bg-muted/25"
    >
      <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5">
        <p className="text-xs text-muted-foreground">Queued ({queuedMessages.length})</p>
      </div>
      <ul>
        {queuedMessages.map((queuedMessage, index) => {
          const preview = formatQueuedFollowUpPreview(queuedMessage.input);
          const attachmentCount = countQueuedMessageAttachments(queuedMessage.input);
          const isProcessing = processingMessageId === queuedMessage.id;
          return (
            <li
              key={queuedMessage.id}
              className="px-2.5 py-0.5"
            >
              <div className="flex items-center gap-1.5">
                <div className="p-0.5 text-muted-foreground">
                  <CornerDownRight className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1 text-xs leading-4">
                    <p className="min-w-0 truncate text-foreground" title={preview}>
                      {preview}
                    </p>
                    {attachmentCount > 0 ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">·</span>
                        <span className="shrink-0 text-muted-foreground">
                          {attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`}
                        </span>
                      </>
                    ) : null}
                    {isProcessing ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">·</span>
                        <span className="shrink-0 text-muted-foreground">Sending...</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="ml-1 flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    className="h-auto px-0 pr-1 text-xs text-muted-foreground underline"
                    disabled={sendDisabled || isProcessing}
                    onClick={() => onSendImmediately(queuedMessage.id)}
                  >
                    {isProcessing ? "Sending..." : "Send now"}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onEdit(queuedMessage.id)}
                    aria-label={`Edit queued message ${index + 1}`}
                    title="Edit queued message"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    disabled={actionDisabled || isProcessing}
                    onClick={() => onDelete(queuedMessage.id)}
                    aria-label={`Delete queued message ${index + 1}`}
                    title="Delete queued message"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useLatestInitialExpanded(initialExpanded: boolean): {
  isExpanded: boolean;
  onToggle: () => void;
} {
  const [state, dispatch] = useReducer(
    reduceLatestInitialExpandedState,
    initialExpanded,
    createLatestInitialExpandedState,
  );

  useEffect(() => {
    dispatch({ type: "sync", initialExpanded });
  }, [initialExpanded]);

  const onToggle = () => {
    dispatch({ type: "toggle" });
  };

  return { isExpanded: state.isExpanded, onToggle };
}

function ToolGroupEntry({
  projectId,
  entry,
  messages,
  isLoadingMessages,
  onLoadMessages,
  isLatestActivity,
}: {
  projectId?: string;
  entry: ThreadDetailToolGroupRow;
  messages: ThreadDetailToolGroupRow["messages"];
  isLoadingMessages: boolean;
  onLoadMessages: () => void;
  isLatestActivity: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(isLatestActivity);
  const latestActivityMessageId = useMemo(
    () => findLatestActivityMessageId(messages),
    [messages],
  );
  const count = entry.summaryCount;
  const summaryContent = `${count} tools and changes`;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const handleToggle = () => {
    if (!isExpanded) {
      onLoadMessages();
    }
    onToggle();
  };

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          onToggle={handleToggle}
          headerToneClass={headerToneClass}
          summaryContent={summaryContent}
          bodyClassName="duration-300"
          contentClassName="pb-1 duration-300"
        >
          <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
            {isLoadingMessages ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <span className="animate-shine">Loading details...</span>
              </div>
            ) : null}
            {messages.map((message) => {
              const isLatestMessage =
                isLatestActivity &&
                message.id === latestActivityMessageId;
              return (
                <ConversationEntry
                  key={message.id}
                  message={message}
                  projectId={projectId}
                  initialExpanded={isLatestMessage}
                  preferOngoingLabels={isLatestMessage}
                />
              );
            })}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}

export function ThreadDetailView() {
  const { projectId, threadId } = useParams<{
    projectId: string;
    threadId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const isGitDiffPanelOpen = useMemo(
    () => isThreadGitDiffPanelOpen(location.search),
    [location.search],
  );
  const [selectedMergeBaseBranch, setSelectedMergeBaseBranch] = useState<string | undefined>(
    undefined,
  );
  const [selectedGitDiffCommitSha, setSelectedGitDiffCommitSha] = useState<string | null>(
    null,
  );
  const { data: thread, isLoading, error } = useThread(threadId ?? "", {
    refetchOnMount: "always",
  });
  const { data: threadWorkStatus } = useThreadWorkStatus(
    threadId ?? "",
    selectedMergeBaseBranch,
  );
  const { data: parentThread } = useThread(thread?.parentThreadId ?? "");
  const { data: timeline, isLoading: timelineLoading } = useThreadTimeline(
    threadId ?? "",
    { refetchOnMount: "always" },
  );
  const threadToolGroupMessages = useThreadToolGroupMessages();
  const { data: defaultExecutionOptions } = useThreadDefaultExecutionOptions(
    threadId ?? "",
  );
  const tellThread = useTellThread();
  const enqueueThreadMessage = useEnqueueThreadMessage();
  const sendQueuedThreadMessage = useSendQueuedThreadMessage();
  const deleteQueuedThreadMessage = useDeleteQueuedThreadMessage();
  const requestThreadCommitOperation = useRequestThreadOperation();
  const requestThreadSquashOperation = useRequestThreadOperation();
  const promoteThread = usePromoteThread();
  const demotePrimaryCheckout = useDemotePrimaryCheckout();
  const stopThread = useStopThread();
  const unarchiveThread = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const uploadPromptAttachment = useUploadPromptAttachment();
  const promptDraft = usePromptDraftStorage({ projectId, threadId });
  const fileMentions = usePromptFileMentions(projectId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [loadingToolGroupIds, setLoadingToolGroupIds] = useState<Set<string>>(new Set());
  const [toolGroupMessagesById, setToolGroupMessagesById] = useState<
    Record<string, UIMessage[]>
  >({});
  const [isChangeListExpanded, setIsChangeListExpanded] = useState(false);
  const [processingQueuedMessageId, setProcessingQueuedMessageId] = useState<string | null>(
    null,
  );
  const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"unified" | "split">(
    "unified",
  );
  const [hasExplicitGitDiffDisplayMode, setHasExplicitGitDiffDisplayMode] = useState(false);
  const [isGitDiffPanelResizing, setIsGitDiffPanelResizing] = useState(false);
  const [gitDiffPanelWidth, setGitDiffPanelWidth] = useState<number | null>(null);
  const [collapsedGitDiffFileKeys, setCollapsedGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [loadingGitDiffFileKeys, setLoadingGitDiffFileKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [parsedGitDiffFiles, setParsedGitDiffFiles] = useState<ParsedGitDiffFile[]>([]);
  const [isParsingGitDiffFiles, setIsParsingGitDiffFiles] = useState(false);
  const [lastParsedGitDiffKey, setLastParsedGitDiffKey] = useState("");
  const [pendingGitDiffScrollPath, setPendingGitDiffScrollPath] = useState<string | null>(
    null,
  );
  const gitDiffPanelRef = useRef<HTMLElement | null>(null);
  const lastGitDiffWideEnoughRef = useRef<boolean | null>(null);
  const gitDiffFileRenderTimersRef = useRef<Map<string, number>>(new Map());
  const queuedGitDiffFileRenderKeysRef = useRef<Set<string>>(new Set());
  const gitDiffFileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const markedReadKeysRef = useRef<Set<string>>(new Set());
  const message = promptDraft.text;
  const promptInput = useMemo(
    () =>
      promptDraftToInput({
        text: promptDraft.text,
        attachments: promptDraft.attachments,
      }),
    [promptDraft.attachments, promptDraft.text],
  );
  const {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
    supportsModelList,
    supportsReasoningLevels,
  } = usePromptModelReasoning({
    scope: "thread",
    initialModel: defaultExecutionOptions?.model,
    initialReasoningLevel: defaultExecutionOptions?.reasoningLevel,
    initialSandboxMode: defaultExecutionOptions?.sandboxMode,
    initialEnvironmentId: thread?.environmentId,
  });
  const preferredTheme = usePreferredTheme();
  const gitDiffViewOptions = useMemo(
    () => ({
      ...GIT_DIFF_VIEW_BASE_OPTIONS,
      diffStyle: gitDiffDisplayMode,
      themeType: preferredTheme,
    }),
    [gitDiffDisplayMode, preferredTheme],
  );

  const threadDetailRows = useMemo(() => timeline?.rows ?? [], [timeline?.rows]);
  const contextWindowUsage = timeline?.contextWindowUsage ?? null;
  const latestActivityRowId = useMemo(
    () => findLatestActivityRowId(threadDetailRows),
    [threadDetailRows],
  );
  const shouldHighlightLatest = useMemo(
    () => shouldHighlightLatestActivity(threadDetailRows, latestActivityRowId),
    [latestActivityRowId, threadDetailRows],
  );

  const isReasoningBlockActive = false;
  const isTimelineLoading = timelineLoading;
  const isThreadPrimaryCheckoutActive = thread?.primaryCheckout?.isActive === true;
  const gitDiffSelection = useMemo(
    () =>
      selectedGitDiffCommitSha
        ? { type: "commit" as const, sha: selectedGitDiffCommitSha }
        : { type: "combined" as const },
    [selectedGitDiffCommitSha],
  );
  const {
    data: threadGitDiff,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
  } = useThreadGitDiff(threadId ?? "", {
    enabled: Boolean(threadId) && isGitDiffPanelOpen,
    selection: gitDiffSelection,
    mergeBaseBranch: selectedMergeBaseBranch,
  });
  const parsedGitDiffFileEntries = useMemo(
    () =>
      parsedGitDiffFiles.map((fileDiff, index) => ({
        key: getParsedGitDiffFileKey(fileDiff, index),
        fileDiff,
      })),
    [parsedGitDiffFiles],
  );
  const isGitDiffPanelWideEnough =
    gitDiffPanelWidth !== null && gitDiffPanelWidth >= GIT_DIFF_SPLIT_VIEW_MIN_WIDTH_PX;

  useLayoutEffect(() => {
    if (!isGitDiffPanelOpen) {
      return;
    }

    const panelElement = gitDiffPanelRef.current;
    if (!panelElement) {
      return;
    }

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.round(nextWidth);
      setGitDiffPanelWidth((currentWidth) =>
        currentWidth === roundedWidth ? currentWidth : roundedWidth,
      );
    };

    updateWidth(panelElement.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? panelElement.getBoundingClientRect().width;
      updateWidth(width);
    });
    observer.observe(panelElement);
    return () => {
      observer.disconnect();
    };
  }, [isGitDiffPanelOpen]);

  useEffect(() => {
    if (!isGitDiffPanelOpen) {
      setHasExplicitGitDiffDisplayMode(false);
      setGitDiffPanelWidth(null);
      lastGitDiffWideEnoughRef.current = null;
      return;
    }
    if (gitDiffPanelWidth === null) {
      return;
    }

    const previousWideEnough = lastGitDiffWideEnoughRef.current;
    const crossedBreakpoint =
      previousWideEnough !== null &&
      previousWideEnough !== isGitDiffPanelWideEnough;
    if (crossedBreakpoint && hasExplicitGitDiffDisplayMode) {
      setHasExplicitGitDiffDisplayMode(false);
    }

    if (!hasExplicitGitDiffDisplayMode || crossedBreakpoint) {
      const nextMode = isGitDiffPanelWideEnough ? "split" : "unified";
      setGitDiffDisplayMode((currentMode) =>
        currentMode === nextMode ? currentMode : nextMode,
      );
    }

    lastGitDiffWideEnoughRef.current = isGitDiffPanelWideEnough;
  }, [
    gitDiffPanelWidth,
    hasExplicitGitDiffDisplayMode,
    isGitDiffPanelOpen,
    isGitDiffPanelWideEnough,
  ]);

  useEffect(() => {
    const gitDiff = threadGitDiff?.diff ?? "";
    const gitDiffKey = getGitDiffParseKey(gitDiff);
    if (!isGitDiffPanelOpen || gitDiff.trim().length === 0) {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey("");
      return;
    }

    setParsedGitDiffFiles([]);
    const patchChunks = splitGitDiffIntoPatchChunks(gitDiff);
    if (patchChunks.length === 0) {
      setParsedGitDiffFiles([]);
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(gitDiffKey);
      return;
    }

    if (patchChunks.length <= GIT_DIFF_PARSE_BATCH_THRESHOLD) {
      setParsedGitDiffFiles(parseGitDiffFiles(gitDiff));
      setIsParsingGitDiffFiles(false);
      setLastParsedGitDiffKey(gitDiffKey);
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let nextPatchIndex = 0;
    let appliedFirstBatch = false;

    const parseNextBatch = () => {
      if (cancelled) {
        return;
      }

      const batchSize =
        nextPatchIndex === 0
          ? GIT_DIFF_PARSE_INITIAL_BATCH_SIZE
          : GIT_DIFF_PARSE_BATCH_SIZE;
      const batchChunks = patchChunks.slice(nextPatchIndex, nextPatchIndex + batchSize);
      if (batchChunks.length === 0) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(gitDiffKey);
        return;
      }

      const parsedBatchFiles = parseGitDiffPatchChunks(batchChunks);
      if (cancelled) {
        return;
      }

      nextPatchIndex += batchChunks.length;
      setParsedGitDiffFiles((currentFiles) =>
        appliedFirstBatch ? [...currentFiles, ...parsedBatchFiles] : parsedBatchFiles,
      );
      appliedFirstBatch = true;

      if (nextPatchIndex >= patchChunks.length || cancelled) {
        setIsParsingGitDiffFiles(false);
        setLastParsedGitDiffKey(gitDiffKey);
        return;
      }

      timerId = window.setTimeout(parseNextBatch, GIT_DIFF_PARSE_BATCH_DELAY_MS);
    };

    setIsParsingGitDiffFiles(true);
    parseNextBatch();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [isGitDiffPanelOpen, threadGitDiff?.diff]);

  useEffect(() => {
    setLoadingToolGroupIds(new Set());
    setToolGroupMessagesById({});
    setProcessingQueuedMessageId(null);
  }, [threadId]);

  useEffect(() => {
    setSelectedMergeBaseBranch(undefined);
  }, [threadId]);

  useEffect(() => {
    setSelectedGitDiffCommitSha(null);
  }, [threadId]);

  useEffect(() => {
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set());
    setLoadingGitDiffFileKeys(new Set());
  }, [threadId, threadGitDiff?.diff]);

  useEffect(() => {
    queuedGitDiffFileRenderKeysRef.current.clear();
  }, [threadId, threadGitDiff?.diff]);

  useEffect(() => {
    setPendingGitDiffScrollPath(null);
  }, [threadId]);

  useEffect(() => {
    if (!threadWorkStatus) return;
    const mergeBaseBranches = threadWorkStatus.mergeBaseBranches ?? [];
    const fallbackBranch = threadWorkStatus.mergeBaseBranch ?? mergeBaseBranches[0];
    if (!fallbackBranch) return;
    if (
      selectedMergeBaseBranch &&
      (
        selectedMergeBaseBranch === threadWorkStatus.mergeBaseBranch ||
        mergeBaseBranches.includes(selectedMergeBaseBranch)
      )
    ) {
      return;
    }
    setSelectedMergeBaseBranch(fallbackBranch);
  }, [selectedMergeBaseBranch, threadWorkStatus]);

  useEffect(() => {
    if (!threadGitDiff) return;
    if (threadGitDiff.mode !== "worktree_commits") {
      if (selectedGitDiffCommitSha !== null) {
        setSelectedGitDiffCommitSha(null);
      }
      return;
    }
    if (
      selectedGitDiffCommitSha &&
      !threadGitDiff.commits.some((commit) => commit.sha === selectedGitDiffCommitSha)
    ) {
      setSelectedGitDiffCommitSha(null);
    }
  }, [selectedGitDiffCommitSha, threadGitDiff]);

  useEffect(
    () => () => {
      for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      gitDiffFileRenderTimersRef.current.clear();
      queuedGitDiffFileRenderKeysRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!thread) return;
    if ((thread.lastReadAt ?? 0) >= thread.updatedAt) return;

    const marker = `${thread.id}:${thread.updatedAt}`;
    if (markedReadKeysRef.current.has(marker)) return;

    markedReadKeysRef.current.add(marker);
    markThreadRead.mutate(thread.id, {
      onError: () => {
        markedReadKeysRef.current.delete(marker);
      },
    });
  }, [markThreadRead, thread]);

  const handleGitDiffDisplayModeChange = useCallback((nextMode: "unified" | "split") => {
    setHasExplicitGitDiffDisplayMode(true);
    setGitDiffDisplayMode(nextMode);
  }, []);

  const handleGitDiffPanelDragging = useCallback((isDragging: boolean) => {
    setIsGitDiffPanelResizing(isDragging);
    if (isDragging) {
      // Treat panel resizing as opting back into responsive split/stacked mode.
      setHasExplicitGitDiffDisplayMode(false);
    }
  }, []);

  const handleLoadToolGroupMessages = useCallback(
    (entry: ThreadDetailToolGroupRow) => {
      if (!threadId) return;
      if (entry.messages.length > 0 || toolGroupMessagesById[entry.id]) return;
      if (loadingToolGroupIds.has(entry.id)) return;
      setLoadingToolGroupIds((prev) => new Set(prev).add(entry.id));
      void threadToolGroupMessages
        .mutateAsync({
          id: threadId,
          turnId: entry.turnId,
          sourceSeqStart: entry.sourceSeqStart,
          sourceSeqEnd: entry.sourceSeqEnd,
        })
        .then((response) => {
          setToolGroupMessagesById((prev) => ({
            ...prev,
            [entry.id]: response.messages,
          }));
        })
        .finally(() => {
          setLoadingToolGroupIds((prev) => {
            const next = new Set(prev);
            next.delete(entry.id);
            return next;
          });
        });
    },
    [
      loadingToolGroupIds,
      threadId,
      threadToolGroupMessages,
      toolGroupMessagesById,
    ],
  );

  const scheduleGitDiffFileRender = useCallback(
    (
      fileKeys: readonly string[],
      options?: {
        initialBatchSize?: number;
        initialDelayMs?: number;
        batchSize?: number;
        batchDelayMs?: number;
      },
    ) => {
      if (fileKeys.length === 0) return;

      const initialBatchSize = Math.max(
        1,
        Math.min(options?.initialBatchSize ?? fileKeys.length, fileKeys.length),
      );
      const batchSize = Math.max(1, options?.batchSize ?? fileKeys.length);
      const initialDelayMs = Math.max(0, options?.initialDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);
      const batchDelayMs = Math.max(0, options?.batchDelayMs ?? GIT_DIFF_FILE_RENDER_SPINNER_MS);

      setLoadingGitDiffFileKeys((currentKeys) => {
        const nextKeys = new Set(currentKeys);
        for (const key of fileKeys) {
          nextKeys.add(key);
        }
        return nextKeys;
      });

      for (let index = 0; index < fileKeys.length; index += 1) {
        const key = fileKeys[index]!;
        const existingTimer = gitDiffFileRenderTimersRef.current.get(key);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }
        const delay =
          index < initialBatchSize
            ? initialDelayMs
            : initialDelayMs + (Math.floor((index - initialBatchSize) / batchSize) + 1) * batchDelayMs;
        const timerId = window.setTimeout(() => {
          setLoadingGitDiffFileKeys((currentKeys) => {
            if (!currentKeys.has(key)) return currentKeys;
            const nextKeys = new Set(currentKeys);
            nextKeys.delete(key);
            return nextKeys;
          });
          gitDiffFileRenderTimersRef.current.delete(key);
        }, delay);
        gitDiffFileRenderTimersRef.current.set(key, timerId);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isGitDiffPanelOpen || parsedGitDiffFileEntries.length === 0) {
      return;
    }

    const newKeysToRender: string[] = [];
    for (const { key } of parsedGitDiffFileEntries) {
      if (queuedGitDiffFileRenderKeysRef.current.has(key)) {
        continue;
      }
      queuedGitDiffFileRenderKeysRef.current.add(key);
      if (!collapsedGitDiffFileKeys.has(key)) {
        newKeysToRender.push(key);
      }
    }

    if (newKeysToRender.length === 0) {
      return;
    }

    const shouldBatchRender =
      parsedGitDiffFileEntries.length > GIT_DIFF_PARSE_BATCH_THRESHOLD ||
      isParsingGitDiffFiles ||
      newKeysToRender.length > GIT_DIFF_FILE_INITIAL_RENDER_COUNT;
    scheduleGitDiffFileRender(
      newKeysToRender,
      shouldBatchRender
        ? {
            initialBatchSize: GIT_DIFF_FILE_INITIAL_RENDER_COUNT,
            initialDelayMs: GIT_DIFF_FILE_INITIAL_DELAY_MS,
            batchSize: GIT_DIFF_FILE_RENDER_BATCH_SIZE,
            batchDelayMs: GIT_DIFF_FILE_RENDER_BATCH_DELAY_MS,
          }
        : undefined,
    );
  }, [
    collapsedGitDiffFileKeys,
    isGitDiffPanelOpen,
    isParsingGitDiffFiles,
    parsedGitDiffFileEntries,
    scheduleGitDiffFileRender,
  ]);

  const toggleGitDiffFileCollapsed = useCallback((fileKey: string) => {
    const isExpandingFile = collapsedGitDiffFileKeys.has(fileKey);
    setCollapsedGitDiffFileKeys((currentKeys) => {
      const nextKeys = new Set(currentKeys);
      if (isExpandingFile) {
        nextKeys.delete(fileKey);
      } else {
        nextKeys.add(fileKey);
      }
      return nextKeys;
    });
    if (isExpandingFile) {
      scheduleGitDiffFileRender([fileKey]);
      return;
    }
    const existingTimer = gitDiffFileRenderTimersRef.current.get(fileKey);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      gitDiffFileRenderTimersRef.current.delete(fileKey);
    }
    setLoadingGitDiffFileKeys((currentKeys) => {
      if (!currentKeys.has(fileKey)) return currentKeys;
      const nextKeys = new Set(currentKeys);
      nextKeys.delete(fileKey);
      return nextKeys;
    });
  }, [collapsedGitDiffFileKeys, scheduleGitDiffFileRender]);

  const toggleAllGitDiffFilesCollapsed = useCallback(() => {
    if (parsedGitDiffFileEntries.length === 0) return;
    const allFileKeys = parsedGitDiffFileEntries.map(({ key }) => key);
    const areAllCollapsed = allFileKeys.every((key) => collapsedGitDiffFileKeys.has(key));
    if (areAllCollapsed) {
      setCollapsedGitDiffFileKeys(new Set());
      scheduleGitDiffFileRender(allFileKeys);
      return;
    }
    for (const timerId of gitDiffFileRenderTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    gitDiffFileRenderTimersRef.current.clear();
    setCollapsedGitDiffFileKeys(new Set(allFileKeys));
    setLoadingGitDiffFileKeys(new Set());
  }, [collapsedGitDiffFileKeys, parsedGitDiffFileEntries, scheduleGitDiffFileRender]);
  const setGitDiffFileRef = useCallback((fileKey: string, element: HTMLDivElement | null) => {
    if (element) {
      gitDiffFileRefs.current.set(fileKey, element);
      return;
    }
    gitDiffFileRefs.current.delete(fileKey);
  }, []);
  const openThreadGitDiffPanel = useCallback(() => {
    if (isGitDiffPanelOpen) {
      return;
    }
    const nextSearch = withThreadGitDiffPanelOpen(location.search, true);
    navigate(
      {
        pathname: location.pathname,
        search: nextSearch.length > 0 ? `?${nextSearch}` : "",
      },
      { replace: true },
    );
  }, [isGitDiffPanelOpen, location.pathname, location.search, navigate]);
  const handlePromptGitStatsBannerClick = useCallback(() => {
    openThreadGitDiffPanel();
  }, [openThreadGitDiffPanel]);
  const handlePromptBannerFileClick = useCallback(
    (file: { path: string }) => {
      setSelectedGitDiffCommitSha(null);
      setPendingGitDiffScrollPath(file.path);
      openThreadGitDiffPanel();
    },
    [openThreadGitDiffPanel],
  );

  useEffect(() => {
    if (!pendingGitDiffScrollPath || !isGitDiffPanelOpen) {
      return;
    }

    const targetEntry = parsedGitDiffFileEntries.find(({ fileDiff }) => (
      doesGitDiffFileMatchPath(fileDiff, pendingGitDiffScrollPath)
    ));
    if (!targetEntry) {
      if (!isGitDiffLoading && !isParsingGitDiffFiles) {
        setPendingGitDiffScrollPath(null);
      }
      return;
    }

    if (collapsedGitDiffFileKeys.has(targetEntry.key)) {
      setCollapsedGitDiffFileKeys((currentKeys) => {
        if (!currentKeys.has(targetEntry.key)) {
          return currentKeys;
        }
        const nextKeys = new Set(currentKeys);
        nextKeys.delete(targetEntry.key);
        return nextKeys;
      });
      scheduleGitDiffFileRender([targetEntry.key]);
    }

    const scrollTarget = gitDiffFileRefs.current.get(targetEntry.key);
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      setPendingGitDiffScrollPath(null);
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const deferredTarget = gitDiffFileRefs.current.get(targetEntry.key);
      if (deferredTarget) {
        deferredTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      setPendingGitDiffScrollPath(null);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    collapsedGitDiffFileKeys,
    isGitDiffLoading,
    isParsingGitDiffFiles,
    isGitDiffPanelOpen,
    parsedGitDiffFileEntries,
    pendingGitDiffScrollPath,
    scheduleGitDiffFileRender,
  ]);

  const {
    containerRef,
    containerElement,
    setContainerRef,
    handleScroll: baseHandleScroll,
  } = useAutoScroll(
    threadDetailRows,
    threadId,
  );
  const promptComposerRef = useRef<HTMLDivElement>(null);
  const promptComposerHeightRef = useRef<number | null>(null);
  const { showScrollToBottom, handleScroll, scrollToBottom } =
    useScrollToBottomIndicator({
      containerRef,
      containerElement,
      onBaseScroll: baseHandleScroll,
      resetDep: threadId,
    });

  useLayoutEffect(() => {
    const scrollContainer = containerElement;
    const promptComposer = promptComposerRef.current;
    if (!scrollContainer || !promptComposer || typeof ResizeObserver === "undefined") {
      return;
    }

    promptComposerHeightRef.current = promptComposer.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const nextHeight =
        entries[0]?.contentRect.height ?? promptComposer.getBoundingClientRect().height;
      const previousHeight = promptComposerHeightRef.current;
      promptComposerHeightRef.current = nextHeight;
      if (previousHeight === null) return;
      const heightDelta = nextHeight - previousHeight;
      if (Math.abs(heightDelta) < 0.5) return;
      const maxScrollOffset = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const distanceFromBottom = maxScrollOffset - scrollContainer.scrollTop;
      if (distanceFromBottom <= SCROLL_THRESHOLD) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        return;
      }
      scrollContainer.scrollTop += heightDelta;
    });

    observer.observe(promptComposer);
    return () => {
      observer.disconnect();
      promptComposerHeightRef.current = null;
    };
  }, [containerElement, threadId]);

  const sendFollowUpInput = useCallback(
    async ({
      input,
      mode,
      model,
      reasoningLevel: executionReasoningLevel,
      sandboxMode: executionSandboxMode,
    }: {
      input: PromptInput[];
      mode?: "auto" | "steer";
      model?: string;
      reasoningLevel?: "low" | "medium" | "high" | "xhigh";
      sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    }) => {
      if (!threadId || input.length === 0) return;
      const shouldDemotePrimaryIfNeeded =
        mode !== "steer" && isThreadPrimaryCheckoutActive;
      scrollToBottom();
      await tellThread.mutateAsync({
        id: threadId,
        input,
        ...(mode ? { mode } : {}),
        ...(shouldDemotePrimaryIfNeeded
          ? { demotePrimaryIfNeeded: true }
          : {}),
        ...(mode === "steer"
          ? {}
          : {
              ...(model ? { model } : {}),
              ...(executionReasoningLevel ? { reasoningLevel: executionReasoningLevel } : {}),
              ...(executionSandboxMode ? { sandboxMode: executionSandboxMode } : {}),
            }),
      });
    },
    [
      isThreadPrimaryCheckoutActive,
      scrollToBottom,
      tellThread,
      threadId,
    ],
  );

  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (!projectId || files.length === 0) return;

    setAttachmentError(null);
    for (const file of files) {
      try {
        const uploaded = await uploadPromptAttachment.mutateAsync({
          projectId,
          file,
        });
        promptDraft.addAttachment(uploaded);
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : "Attachment upload failed");
        break;
      }
    }
  }, [projectId, promptDraft, uploadPromptAttachment]);

  if (!projectId || !threadId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }
  if (isLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">Loading...</p>
      </PageShell>
    );
  }
  if (
    error ||
    !thread ||
    thread.projectId !== projectId
  ) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Not found"}
        </p>
      </PageShell>
    );
  }

  const isCreated = thread.status === "created";
  const isProvisioning = thread.status === "provisioning";
  const isProvisioningFailed = thread.status === "provisioning_failed";
  const queuedMessages = extractThreadQueuedMessages(thread);
  const isQueueMutationPending =
    enqueueThreadMessage.isPending ||
    sendQueuedThreadMessage.isPending ||
    deleteQueuedThreadMessage.isPending;
  const isFollowUpSubmitting =
    tellThread.isPending ||
    demotePrimaryCheckout.isPending ||
    enqueueThreadMessage.isPending;
  const canSendFollowUp = !isCreated && !isProvisioning;
  const promptPlaceholder =
    isCreated
      ? "Thread is being created..."
      : isProvisioning
      ? "Thread is provisioning..."
      : isProvisioningFailed
      ? "Retry provisioning by sending a message"
      : thread.status === "idle"
      ? "Ask for follow-up changes"
      : "Send a message to this thread...";
  const parentThreadId = thread.parentThreadId;
  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;
  const isPrimaryCheckoutActive = thread.primaryCheckout?.isActive === true;
  const primaryCheckoutStatusLabel = isPrimaryCheckoutActive ? "Active" : "Not active";
  const primaryCheckoutStatusVariant: StatusPillVariant = isPrimaryCheckoutActive
    ? "emphasis"
    : "outline";
  const isPrimaryCheckoutMutationPending = promoteThread.isPending || demotePrimaryCheckout.isPending;
  const primaryCheckoutActionLabel = isPrimaryCheckoutActive
    ? demotePrimaryCheckout.isPending
      ? "Demoting..."
      : "Demote"
    : promoteThread.isPending
    ? "Promoting..."
    : "Promote";
  const isArchivedThread = thread.archivedAt !== undefined;
  const showWorkspaceStatus =
    Boolean(threadWorkStatus) &&
    !(thread.archivedAt !== undefined && thread.environmentId === "local");
  const showThreadMetadata = Boolean(
    parentThreadId ||
      thread.archivedAt !== undefined ||
      thread.environmentId ||
      isPrimaryCheckoutActive ||
      showWorkspaceStatus,
  );
  const provisioningStatusLabel =
    isCreated
      ? "Created..."
      : isProvisioning
      ? "Provisioning..."
      : undefined;
  const showBranchComparisonUi = Boolean(
    threadWorkStatus?.mergeBaseBranch ||
      threadWorkStatus?.defaultBranch ||
      (threadWorkStatus?.mergeBaseBranches?.length ?? 0) > 0,
  );
  const promptBannerSummary = threadWorkStatus
    ? showBranchComparisonUi
      ? formatChangeSummary({
          changedFiles: threadWorkStatus.changedFiles,
          insertions: threadWorkStatus.insertions,
          deletions: threadWorkStatus.deletions,
        })
      : formatWorkspaceChangeSummary(threadWorkStatus)
    : "";
  const showPromptGitStatsBanner = Boolean(
    threadWorkStatus &&
    (
      showBranchComparisonUi
        ? threadWorkStatus.changedFiles > 0
        : threadWorkStatus.workspaceChangedFiles > 0
    ),
  );
  const canExpandPromptChangeList = Boolean(
    threadWorkStatus &&
    (threadWorkStatus.files?.length ?? 0) > 0,
  );
  const promptBannerMergeBaseBranch =
    selectedMergeBaseBranch ??
    threadWorkStatus?.mergeBaseBranch ??
    threadWorkStatus?.defaultBranch;

  const handleSend = async () => {
    if (promptInput.length === 0) return;

    if (thread.status === "active") {
      try {
        await enqueueThreadMessage.mutateAsync({
          id: thread.id,
          input: promptInput,
          model: activeModel?.model ?? selectedModel,
          reasoningLevel,
          sandboxMode,
        });
        promptDraft.clear();
        setAttachmentError(null);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Failed to queue follow-up");
      }
      return;
    }

    try {
      await sendFollowUpInput({
        input: promptInput,
        model: activeModel?.model ?? selectedModel,
        reasoningLevel,
        sandboxMode,
      });
      promptDraft.clear();
      setAttachmentError(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to send follow-up");
    }
  };

  const handleSendQueuedImmediately = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

    setProcessingQueuedMessageId(messageId);
    void sendQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
        mode: "steer-if-active",
      })
      .then(() => {
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to send queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const handleEditQueuedMessage = (messageId: string) => {
    const queuedMessage = queuedMessages.find((candidate) => candidate.id === messageId);
    if (!queuedMessage) return;

    setProcessingQueuedMessageId(messageId);
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .then(() => {
        const restoredDraft = queuedInputToDraft(queuedMessage.input);
        promptDraft.setText(restoredDraft.text);
        promptDraft.setAttachments(restoredDraft.attachments);
        setAttachmentError(null);
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to edit queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const handleDeleteQueuedMessage = (messageId: string) => {
    setProcessingQueuedMessageId(messageId);
    void deleteQueuedThreadMessage
      .mutateAsync({
        id: thread.id,
        queuedMessageId: messageId,
      })
      .catch((err) => {
        window.alert(
          err instanceof Error ? err.message : "Failed to delete queued follow-up",
        );
      })
      .finally(() => {
        setProcessingQueuedMessageId((currentMessageId) =>
          currentMessageId === messageId ? null : currentMessageId,
        );
      });
  };

  const conversationMain = (
    <>
      {showThreadMetadata ? (
        <section className="sticky top-0 z-10 shrink-0 bg-background pt-2">
          <DetailCard layout="columns">
            {parentThreadId ? (
              <DetailRow
                label="Parent thread"
                valueClassName="min-w-0 truncate"
              >
                <Link
                  to={`/projects/${projectId}/threads/${parentThreadId}`}
                  className="underline underline-offset-2"
                >
                  {parentThreadDisplayName}
                </Link>
              </DetailRow>
            ) : null}
            {thread.environmentId ? (
              <DetailRow
                label="Environment"
                valueClassName="min-w-0 truncate"
              >
                <span>{thread.environmentId}</span>
              </DetailRow>
            ) : null}
            {thread.environmentId === "worktree" && !isArchivedThread ? (
              <DetailRow
                label="Primary checkout"
                valueClassName="min-w-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusPill
                    variant={primaryCheckoutStatusVariant}
                  >
                    {primaryCheckoutStatusLabel}
                  </StatusPill>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0 py-0 ui-text-xs underline"
                    disabled={
                      thread.archivedAt !== undefined ||
                      isPrimaryCheckoutMutationPending
                    }
                    onClick={() => {
                      const action = isPrimaryCheckoutActive
                        ? demotePrimaryCheckout.mutateAsync({ id: thread.id })
                        : promoteThread.mutateAsync({ id: thread.id });
                      void action.catch((err) => {
                        window.alert(
                          err instanceof Error
                            ? err.message
                            : "Failed to update primary checkout state",
                        );
                      });
                    }}
                  >
                    {primaryCheckoutActionLabel}
                  </Button>
                </div>
              </DetailRow>
            ) : null}
            {showWorkspaceStatus && threadWorkStatus ? (
              <DetailRow
                label="Workspace status"
                valueClassName="min-w-0"
              >
                <StatusPillCommitPopover
                  threadId={thread.id}
                  status={threadWorkStatus}
                  label={threadWorkStatusLabel(threadWorkStatus, {
                    cleanLabel:
                      showBranchComparisonUi
                        ? threadWorktreeCleanLabel(threadWorkStatus)
                        : undefined,
                  })}
                  variant={threadWorkStatusVariant(threadWorkStatus, {
                    isArchivedThread: thread.archivedAt !== undefined,
                  })}
                  cleanTitle={
                    showBranchComparisonUi
                      ? threadWorktreeCleanLabel(threadWorkStatus)
                      : undefined
                  }
                  showMergeBaseDetails={showBranchComparisonUi}
                  mergeBaseBranch={selectedMergeBaseBranch ?? threadWorkStatus.mergeBaseBranch}
                  mergeBaseBranchOptions={threadWorkStatus.mergeBaseBranches}
                  onMergeBaseBranchChange={
                    showBranchComparisonUi
                      ? setSelectedMergeBaseBranch
                      : undefined
                  }
                  canCommit={threadWorkStatus.hasUncommittedChanges}
                  canSquashMerge={
                    thread.environmentId === "worktree" &&
                    (
                      threadWorkStatus.hasCommittedUnmergedChanges ||
                      threadWorkStatus.hasUncommittedChanges
                    )
                  }
                  isCommitting={requestThreadCommitOperation.isPending}
                  isSquashMerging={requestThreadSquashOperation.isPending}
                  onCommit={async ({ includeUnstaged, message }) => {
                    if (!threadId) return;
                    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
                    await requestThreadCommitOperation.mutateAsync({
                      id: threadId,
                      operation: "commit",
                      options: {
                        includeUnstaged,
                        ...(message ? { message } : {}),
                        autoArchiveOnSuccess,
                      },
                    });
                  }}
                  onSquashMerge={async ({
                    commitIfNeeded,
                    includeUnstaged,
                    commitMessage,
                    mergeBaseBranch,
                  }) => {
                    if (!threadId) return;
                    const autoArchiveOnSuccess = getAutoArchivePreferences().autoArchiveThreadOnCommit;
                    await requestThreadSquashOperation.mutateAsync({
                      id: threadId,
                      operation: "squash_merge",
                      options: {
                        commitIfNeeded,
                        includeUnstaged,
                        ...(commitMessage ? { commitMessage } : {}),
                        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
                        autoArchiveOnSuccess,
                      },
                    });
                  }}
                />
              </DetailRow>
            ) : null}
            {thread.archivedAt !== undefined ? (
              <DetailRow
                label="Archived"
                valueClassName="min-w-0 truncate"
              >
                <ArchiveTimestampAction
                  isPending={
                    unarchiveThread.isPending &&
                    unarchiveThread.variables?.id === thread.id
                  }
                  onUnarchive={() => {
                    unarchiveThread.mutate({ id: thread.id });
                  }}
                />
              </DetailRow>
            ) : null}
          </DetailCard>
        </section>
      ) : null}
      <ConversationTimeline>
        {isTimelineLoading && threadDetailRows.length === 0 ? (
          <ConversationEmptyState
            message="Loading thread..."
            className="w-full rounded-md px-2 py-1 text-left"
          />
        ) : threadDetailRows.length === 0 ? (
          <ConversationEmptyState message="No events yet" />
        ) : (
          threadDetailRows.map((entry) => {
            const isLatestActivity =
              shouldHighlightLatest && entry.id === latestActivityRowId;
            return entry.kind === "tool-group" ? (
              <ToolGroupEntry
                key={`${threadId}:${entry.id}`}
                projectId={projectId}
                entry={entry}
                messages={toolGroupMessagesById[entry.id] ?? entry.messages}
                isLoadingMessages={loadingToolGroupIds.has(entry.id)}
                onLoadMessages={() => handleLoadToolGroupMessages(entry)}
                isLatestActivity={isLatestActivity}
              />
            ) : (
              <ConversationEntry
                key={`${threadId}:${entry.id}`}
                message={entry.message}
                projectId={projectId}
                initialExpanded={isLatestActivity}
                preferOngoingLabels={isLatestActivity}
              />
            );
          })
        )}
      </ConversationTimeline>
      {thread.status === "active" ? (
        <ConversationWorkingIndicator isThinking={isReasoningBlockActive} />
      ) : null}
    </>
  );

  const conversationShell = (
    <PageShell
      scrollRef={setContainerRef}
      onScroll={handleScroll}
      shellClassName={isGitDiffPanelOpen ? "!mx-0 !mt-0 md:!mx-0 md:!mt-0" : undefined}
      contentClassName="gap-2 pt-0"
      footerUsesPromptPadding
      footer={
        <div ref={promptComposerRef}>
          <PromptComposerShell statusLabel={provisioningStatusLabel}>
            <ScrollToBottomButton
              visible={showScrollToBottom}
              onClick={scrollToBottom}
            />
            {showPromptGitStatsBanner ? (
              <div
                className={cn(
                  "mb-2 rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground",
                  !isGitDiffPanelOpen && "cursor-pointer transition-colors hover:bg-muted/55",
                )}
                onClick={handlePromptGitStatsBannerClick}
              >
                <div className="flex items-center justify-between gap-3">
                  {canExpandPromptChangeList ? (
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 truncate text-left"
                      onClick={(event) => {
                        event.stopPropagation();
                        setIsChangeListExpanded((prev) => !prev);
                      }}
                    >
                      <span className="truncate">{promptBannerSummary}</span>
                      <ChevronDown
                        className={`size-3.5 shrink-0 transition-transform duration-200 ${
                          isChangeListExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                  ) : (
                    <span className="truncate">{promptBannerSummary}</span>
                  )}
                  {showBranchComparisonUi ? (
                    <span className="shrink-0 text-xs text-muted-foreground/90">
                      {promptBannerMergeBaseBranch
                        ? `Merge base: ${promptBannerMergeBaseBranch}`
                        : "Merge base comparison"}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground/90">
                      Includes all threads in this working directory
                    </span>
                  )}
                </div>
                {canExpandPromptChangeList && threadWorkStatus ? (
                  <div
                    className={`grid overflow-hidden transition-[grid-template-rows,opacity,margin,padding,border-color] duration-200 ease-out ${
                      isChangeListExpanded
                        ? "mt-2 grid-rows-[1fr] border-t border-border/50 pt-1 opacity-100"
                        : "grid-rows-[0fr] border-t border-transparent pt-0 opacity-0"
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <div className="overflow-hidden">
                      <WorkspaceChangesList
                        files={threadWorkStatus.files}
                        threadId={thread.id}
                        onFileClick={handlePromptBannerFileClick}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <QueuedFollowUpList
              queuedMessages={queuedMessages}
              sendDisabled={!canSendFollowUp || isFollowUpSubmitting || isQueueMutationPending}
              actionDisabled={isFollowUpSubmitting || isQueueMutationPending}
              processingMessageId={processingQueuedMessageId}
              onSendImmediately={handleSendQueuedImmediately}
              onEdit={handleEditQueuedMessage}
              onDelete={handleDeleteQueuedMessage}
            />
            <PromptBox
              value={message}
              onChange={promptDraft.setText}
              onSubmit={handleSend}
              zenModeLayout="thread"
              zenModeStorageKey={null}
              zenModeResetKey={threadId}
              resetZenModeOnSubmit
              onStop={
                thread.status === "active"
                  ? () => stopThread.mutate(thread.id)
                  : undefined
              }
              isSubmitting={isFollowUpSubmitting}
              submitDisabled={!canSendFollowUp || isFollowUpSubmitting}
              submitTitle={
                thread.status === "active"
                  ? "Queue follow-up (Enter)"
                  : "Submit (Enter)"
              }
              isRunning={thread.status === "active"}
              placeholder={promptPlaceholder}
              submitMode="enter"
              autoFocus
              mentionSuggestions={fileMentions.suggestions}
              mentionLoading={fileMentions.isLoading}
              mentionError={fileMentions.isError}
              onMentionQueryChange={fileMentions.setQuery}
              attachments={promptDraft.attachments}
              attachmentProjectId={projectId}
              onAttachFiles={handleAttachFiles}
              onRemoveAttachment={promptDraft.removeAttachment}
              isAttaching={uploadPromptAttachment.isPending}
              attachmentError={attachmentError}
              footerStart={
                <>
                  {supportsModelList ? (
                    <PromptOptionPicker
                      label="Model"
                      value={activeModel?.model ?? selectedModel}
                      options={modelOptions}
                      onChange={setSelectedModel}
                    />
                  ) : null}
                  {supportsReasoningLevels ? (
                    <PromptOptionPicker
                      label="Reasoning"
                      value={reasoningLevel}
                      options={reasoningOptions}
                      onChange={setReasoningLevel}
                    />
                  ) : null}
                  <PromptOptionPicker
                    label="Sandbox"
                    value={sandboxMode}
                    options={sandboxOptions}
                    onChange={setSandboxMode}
                  />
                </>
              }
            />
            {contextWindowUsage ? (
              <div className="mt-1 flex justify-end pr-0.5">
                <ThreadContextWindowIndicator usage={contextWindowUsage} />
              </div>
            ) : null}
          </PromptComposerShell>
        </div>
      }
    >
      {conversationMain}
    </PageShell>
  );

  if (!isGitDiffPanelOpen) {
    return conversationShell;
  }

  const selectedDiffCommitSha =
    threadGitDiff?.selection.type === "commit"
      ? threadGitDiff.selection.sha
      : null;
  const gitDiffSelectValue = selectedDiffCommitSha ?? "combined";
  const gitDiffSelectOptions: GitDiffSelectionOption[] =
    threadGitDiff?.mode === "worktree_commits"
      ? [
          { value: "combined", label: "All changes combined" },
          ...threadGitDiff.commits.map((commit) => ({
            value: commit.sha,
            label: `${commit.shortSha} · ${commit.subject}`,
          })),
        ]
      : [{
          value: "combined",
          label: "Uncommitted changes",
        }];
  const currentGitDiff = threadGitDiff?.diff ?? "";
  const hasCurrentGitDiff = currentGitDiff.trim().length > 0;
  const currentGitDiffKey = getGitDiffParseKey(currentGitDiff);
  const gitDiffStats = summarizeGitDiff(
    isParsingGitDiffFiles ? [] : parsedGitDiffFiles,
    currentGitDiff,
  );
  const gitDiffStatsLabel =
    gitDiffStats.files === 0 && gitDiffStats.additions === 0 && gitDiffStats.deletions === 0
      ? "No changes"
      : `${gitDiffStats.files} ${gitDiffStats.files === 1 ? "file" : "files"} · +${gitDiffStats.additions} -${gitDiffStats.deletions}`;
  const hasParsedGitDiffFiles = parsedGitDiffFileEntries.length > 0;
  const isAwaitingCurrentGitDiffParse =
    hasCurrentGitDiff && lastParsedGitDiffKey !== currentGitDiffKey;
  const isPreparingGitDiff =
    !hasParsedGitDiffFiles &&
    (isGitDiffLoading || isParsingGitDiffFiles || isAwaitingCurrentGitDiffParse);
  const areAllGitDiffFilesCollapsed =
    hasParsedGitDiffFiles &&
    parsedGitDiffFileEntries.every(({ key }) => collapsedGitDiffFileKeys.has(key));

  return (
    <div className="-mx-4 -mb-4 -mt-4 flex h-full min-h-0 min-w-0 flex-1 overflow-hidden md:-mx-5 md:-mb-5 md:-mt-5">
      <PanelGroup direction="horizontal" className="h-full w-full min-w-0">
        <Panel
          defaultSize={TIMELINE_PANEL_DEFAULT_SIZE_PERCENT}
          minSize={100 - GIT_DIFF_PANEL_MAX_SIZE_PERCENT}
          className="min-w-0 overflow-hidden"
        >
          {conversationShell}
        </Panel>
        <PanelResizeHandle
          onDragging={handleGitDiffPanelDragging}
          className={cn(
            "group relative w-3 shrink-0 cursor-col-resize bg-transparent transition-colors",
            isGitDiffPanelResizing && "bg-accent/25",
          )}
          aria-label="Resize thread and git diff panels"
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 transition-colors",
              isGitDiffPanelResizing ? "bg-accent-foreground/55" : "group-hover:bg-accent-foreground/40",
            )}
          />
          <span
            className={cn(
              "pointer-events-none absolute left-1/2 top-1/2 flex h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-background/95 opacity-0 shadow-sm transition-opacity",
              isGitDiffPanelResizing ? "opacity-100" : "group-hover:opacity-100",
            )}
          >
            <GripVertical className="size-3 text-muted-foreground" />
          </span>
        </PanelResizeHandle>
        <Panel
          defaultSize={GIT_DIFF_PANEL_DEFAULT_SIZE_PERCENT}
          minSize={GIT_DIFF_PANEL_MIN_SIZE_PERCENT}
          maxSize={GIT_DIFF_PANEL_MAX_SIZE_PERCENT}
          className="min-w-0 bg-background"
        >
          <aside ref={gitDiffPanelRef} className="flex min-h-0 h-full min-w-0 flex-1 flex-col">
            <div className="px-3 py-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="min-w-0 max-w-[48%] flex-1">
                  <GitDiffSelector
                    value={gitDiffSelectValue}
                    options={gitDiffSelectOptions}
                    onChange={(value) => {
                      setSelectedGitDiffCommitSha(value === "combined" ? null : value);
                    }}
                    disabled={isGitDiffLoading || threadGitDiff === undefined}
                  />
                </div>
                <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1">
                  {isParsingGitDiffFiles ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Parsing…
                    </span>
                  ) : null}
                  <span
                    className="max-w-[110px] truncate whitespace-nowrap text-xs text-muted-foreground"
                    title={gitDiffStatsLabel}
                  >
                    {gitDiffStatsLabel}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground"
                    onClick={toggleAllGitDiffFilesCollapsed}
                    disabled={!hasParsedGitDiffFiles || isGitDiffLoading}
                    aria-label={areAllGitDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                    title={areAllGitDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  >
                    {areAllGitDiffFilesCollapsed ? (
                      <ChevronsDown className="size-3.5" />
                    ) : (
                      <ChevronsUp className="size-3.5" />
                    )}
                  </Button>
                  <div className="inline-flex items-center rounded-md border border-border/70 p-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-6 w-6 p-0",
                        gitDiffDisplayMode === "unified" ? "bg-accent text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => handleGitDiffDisplayModeChange("unified")}
                      aria-label="Stacked diff view"
                      title="Stacked diff view"
                    >
                      <Rows2 className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-6 w-6 p-0",
                        gitDiffDisplayMode === "split" ? "bg-accent text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => handleGitDiffDisplayModeChange("split")}
                      aria-label="Split diff view"
                      title="Split diff view"
                    >
                      <Columns2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-2 pt-0">
              {isPreparingGitDiff ? (
                <GitDiffPanelSkeleton />
              ) : gitDiffError ? (
                <p className="py-2 text-xs text-destructive">
                  {gitDiffError instanceof Error
                    ? gitDiffError.message
                    : "Failed to load git diff"}
                </p>
              ) : threadGitDiff && hasCurrentGitDiff ? (
                <>
                  {parsedGitDiffFileEntries.length > 0 ? (
                    <div className="space-y-2 pt-2">
                      {parsedGitDiffFileEntries.map(({ key, fileDiff }) => {
                        const isCollapsed = collapsedGitDiffFileKeys.has(key);
                        const hasQueuedFileRender = queuedGitDiffFileRenderKeysRef.current.has(key);
                        const isRendering = !hasQueuedFileRender || loadingGitDiffFileKeys.has(key);
                        const fileDiffStats = summarizeGitDiffFile(fileDiff);
                        const fileDiffLabel = formatGitDiffFileLabel(fileDiff);
                        const openablePath = getOpenableGitDiffPath(fileDiff);
                        const canOpenFile = Boolean(openablePath);
                        return (
                          <div
                            key={key}
                            ref={(element) => setGitDiffFileRef(key, element)}
                            className="rounded-md border border-border/70 bg-muted/35"
                          >
                            <div className="sticky top-0 z-20 border-b border-border/60 bg-background px-2.5 py-1 text-xs font-medium text-foreground">
                              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <button
                                    type="button"
                                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                                    onClick={() => toggleGitDiffFileCollapsed(key)}
                                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${fileDiffLabel}`}
                                    aria-expanded={!isCollapsed}
                                  >
                                    <ChevronRight
                                      className={cn(
                                        "size-3.5 shrink-0 transition-transform duration-150",
                                        !isCollapsed && "rotate-90",
                                      )}
                                    />
                                  </button>
                                  {canOpenFile && openablePath ? (
                                    <button
                                      type="button"
                                      className="block min-w-0 truncate text-left underline-offset-2 hover:underline"
                                      title={fileDiffLabel}
                                      onClick={() => {
                                        void openThreadPathInEditor(thread.id, {
                                          relativePath: openablePath,
                                          target: "file",
                                          command: getPathCommandForTarget("file"),
                                        });
                                      }}
                                    >
                                      {fileDiffLabel}
                                    </button>
                                  ) : (
                                    <span className="block min-w-0 truncate" title={fileDiffLabel}>
                                      {fileDiffLabel}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                                  +{fileDiffStats.additions} -{fileDiffStats.deletions}
                                </span>
                              </div>
                            </div>
                            {!isCollapsed ? (
                              isRendering ? (
                                <div className="space-y-1.5 px-2.5 py-2">
                                  <Skeleton className="h-3 w-full rounded-sm" />
                                  <Skeleton className="h-3 w-[96%] rounded-sm" />
                                  <Skeleton className="h-3 w-[93%] rounded-sm" />
                                  <Skeleton className="h-3 w-[90%] rounded-sm" />
                                  <Skeleton className="h-3 w-[87%] rounded-sm" />
                                  <Skeleton className="h-3 w-[84%] rounded-sm" />
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <div className="w-full max-w-full" style={GIT_DIFF_VIEW_STYLE}>
                                    <FileDiff
                                      fileDiff={fileDiff}
                                      options={{ ...gitDiffViewOptions, disableFileHeader: true }}
                                    />
                                  </div>
                                </div>
                              )
                            ) : null}
                          </div>
                        );
                      })}
                      {isParsingGitDiffFiles ? (
                        <div className="rounded-md border border-border/70 bg-muted/35 px-2.5 py-2">
                          <div className="space-y-1.5">
                            <Skeleton className="h-3 w-52 max-w-full rounded-sm" />
                            <Skeleton className="h-3 w-5/6 rounded-sm" />
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <pre className="overflow-auto whitespace-pre rounded-md border border-border/70 bg-muted/35 p-2 font-mono text-xs text-foreground">
                      {threadGitDiff.diff}
                    </pre>
                  )}
                  {threadGitDiff.truncated ? (
                    <p className="pt-2 text-xs text-muted-foreground">
                      Diff output was truncated for display.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="py-2 text-xs text-muted-foreground">
                  No diff to display.
                </p>
              )}
            </div>
          </aside>
        </Panel>
      </PanelGroup>
    </div>
  );
}
