import {
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  UIMessage,
  UIDebugRawEventMessage,
  UIErrorMessage,
  UIFileEditMessage,
  UIOperationMessage,
  UIToolCallMessage,
  UIToolExploringMessage,
  UIToolParsedIntent,
  UIUserMessage,
  UIAssistantReasoningMessage,
  UIAssistantTextMessage,
  UIWebSearchMessage,
} from "@beanbag/agent-core";
import { assertNever } from "@beanbag/agent-core";
import { PatchDiff } from "@pierre/diffs/react";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";
import { OpenPathButton } from "@/components/shared/OpenPathButton";
import { StatusPill, type StatusPillVariant } from "@/components/shared/StatusPill";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  CollapsibleHeader,
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  COLLAPSIBLE_HEADER_TEXT_CLASS,
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { usePreferredTheme } from "@/hooks/useTheme";
import { ansiToHtml } from "@/lib/ansi";
import { resolveWorkspaceAbsolutePath } from "@/lib/workspace-path";
import { ConversationMarkdown } from "./ConversationMarkdown";

interface ConversationEntryProps {
  message: UIMessage;
  projectId?: string;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

const DEBUG_EVENT_EXPANDED_MAX_LENGTH = 4000;
const SCROLL_STICK_THRESHOLD_PX = 40;

function formatDebugEventData(
  data: unknown,
  {
    maxLength,
    pretty = false,
  }: {
    maxLength: number;
    pretty?: boolean;
  },
): string {
  if (data === undefined) return "(no data)";
  try {
    const serialized = JSON.stringify(data, null, pretty ? 2 : 0);
    if (!serialized) return "(no data)";
    if (serialized.length > maxLength) {
      return `${serialized.slice(0, maxLength)}...`;
    }
    return serialized;
  } catch {
    return "(unserializable data)";
  }
}

function getReasoningTitle(reasoning: string): string {
  const match = reasoning.match(/^\*\*(.*?)\*\*/);
  if (match?.[1]) {
    return match[1].trim() || "Thinking";
  }
  return "Thinking";
}

function normalizeReasoningText(value: string): string {
  return value
    .replaceAll("**", "")
    .replaceAll("__", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isReasoningExpandable(reasoning: string, title: string): boolean {
  const normalizedReasoning = normalizeReasoningText(reasoning);
  const normalizedTitle = normalizeReasoningText(title);
  if (!normalizedReasoning || !normalizedTitle) return true;
  return normalizedReasoning !== normalizedTitle;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

function fileChangeIdentity(change: UIFileEditMessage["changes"][number]): string {
  return (change.movePath ?? change.path).replaceAll("\\", "/");
}

function uniqueChangedFileCount(changes: UIFileEditMessage["changes"]): number {
  const files = new Set<string>();
  for (const change of changes) {
    files.add(fileChangeIdentity(change));
  }
  return files.size;
}

type FileChangeAction = "created" | "deleted" | "renamed" | "edited";

function normalizeToken(value: string | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function fileChangeAction(change: UIFileEditMessage["changes"][number]): FileChangeAction {
  if (change.movePath) return "renamed";
  const token = normalizeToken(change.kind);
  if (token.includes("add") || token.includes("create")) return "created";
  if (token.includes("delete") || token.includes("remove")) return "deleted";
  return "edited";
}

function fileChangeActionLabel(action: FileChangeAction): string {
  if (action === "created") return "Created";
  if (action === "deleted") return "Deleted";
  if (action === "renamed") return "Renamed";
  return "Edited";
}

function diffStats(
  change: UIFileEditMessage["changes"][number],
): { added: number; removed: number } {
  const diff = change.diff;
  if (!diff) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  let sawUnifiedDiffLine = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      sawUnifiedDiffLine = true;
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      sawUnifiedDiffLine = true;
      removed += 1;
    }
  }

  if (sawUnifiedDiffLine) {
    return { added, removed };
  }

  const action = fileChangeAction(change);
  if (action === "created" || action === "deleted") {
    const plainContentLines = diff
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        return !(
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("new file mode ") ||
          line.startsWith("deleted file mode ") ||
          line.startsWith("similarity index ") ||
          line.startsWith("rename from ") ||
          line.startsWith("rename to ")
        );
      }).length;
    if (action === "created") {
      return { added: plainContentLines, removed: 0 };
    }
    return { added: 0, removed: plainContentLines };
  }

  return { added, removed };
}

const DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
  disableFileHeader: true,
} as const;

const DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

function toSyntheticPatch(
  change: UIFileEditMessage["changes"][number],
  action: FileChangeAction,
): string | undefined {
  if (action !== "created" && action !== "deleted") return undefined;
  const diff = change.diff?.replaceAll("\r\n", "\n") ?? "";
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return undefined;
  const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
  const fromPath = action === "created" ? "/dev/null" : `a/${normalizedPath}`;
  const toPath = action === "created" ? `b/${normalizedPath}` : "/dev/null";
  const prefix = action === "created" ? "+" : "-";
  const oldCount = action === "created" ? 0 : lines.length;
  const newCount = action === "created" ? lines.length : 0;
  const body = lines.map((line) => `${prefix}${line}`).join("\n");

  return `--- ${fromPath}\n+++ ${toPath}\n@@ -1,${oldCount} +1,${newCount} @@\n${body}\n`;
}

function getRenderablePatch(change: UIFileEditMessage["changes"][number]): string | undefined {
  const patch = change.diff;
  if (patch && patch.trim().length > 0) {
    const trimmedPatch = patch.trimEnd();
    if (
      trimmedPatch.startsWith("diff --git") ||
      (trimmedPatch.includes("--- ") &&
        trimmedPatch.includes("+++ ") &&
        trimmedPatch.includes("@@"))
    ) {
      return patch;
    }
    if (patch.includes("@@")) {
      const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
      return `--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${patch.trimEnd()}\n`;
    }
  }
  return toSyntheticPatch(change, fileChangeAction(change));
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

function isScrolledNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">,
): boolean {
  const maxScrollOffset = element.scrollHeight - element.clientHeight;
  if (maxScrollOffset <= SCROLL_STICK_THRESHOLD_PX) {
    return true;
  }
  const distanceFromBottom = maxScrollOffset - element.scrollTop;
  return distanceFromBottom <= SCROLL_STICK_THRESHOLD_PX;
}

function useStickyBottomAutoScroll<ElementType extends HTMLElement>({
  isExpanded,
  scrollDep,
}: {
  isExpanded: boolean;
  scrollDep: unknown;
}) {
  const elementRef = useRef<ElementType | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) return;
    shouldStickToBottomRef.current = true;
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded || !shouldStickToBottomRef.current) return;
    const element = elementRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [isExpanded, scrollDep]);

  const handleScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    shouldStickToBottomRef.current = isScrolledNearBottom(element);
  };

  return { elementRef, handleScroll };
}

function ExpandableEntryContainer({
  isExpanded,
  summaryContent,
  headerToneClass,
  onToggle,
  headerButtonClassName,
  summaryContentClassName,
  children,
}: {
  isExpanded: boolean;
  summaryContent: ReactNode;
  headerToneClass: string;
  onToggle: () => void;
  headerButtonClassName?: string;
  summaryContentClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md text-muted-foreground">
      <div className="px-2 py-1">
        <CollapsibleHeader
          isExpanded={isExpanded}
          onToggle={onToggle}
          toneClassName={headerToneClass}
          className={headerButtonClassName}
          summaryClassName={summaryContentClassName ?? COLLAPSIBLE_HEADER_TEXT_CLASS}
          summaryContent={summaryContent}
        />
      </div>
      {isExpanded ? (
        <div className="px-2 pb-1">
          <div>{children}</div>
        </div>
      ) : null}
    </div>
  );
}

function UserMessageRow({ message, projectId }: { message: UIUserMessage; projectId?: string }) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(null);
  const attachments: string[] = [];
  if (message.attachments?.localFiles) {
    const count = message.attachments.localFiles;
    attachments.push(`${count} local file${count === 1 ? "" : "s"}`);
  }

  const imageSources = [
    ...(message.attachments?.imageUrls ?? []),
    ...(message.attachments?.localImagePaths ?? []),
  ];

  const hasMultipleImages = imageSources.length > 1;
  const currentImageSrc =
    expandedImageIndex !== null && imageSources[expandedImageIndex]
      ? toUserAttachmentImageSrc(imageSources[expandedImageIndex], projectId)
      : null;

  return (
    <>
      <div className="group w-full py-2" style={{ overflowAnchor: "none" }}>
        <div className="ml-auto w-fit max-w-[80%]">
          <div className="rounded-md bg-primary/10 p-2 text-sm leading-relaxed text-foreground">
            {message.text ? (
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            ) : (
              <p className="text-muted-foreground">Sent attachments</p>
            )}

            {imageSources.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap justify-end gap-2">
                {imageSources.map((source, index) => (
                  <button
                    key={`${source}-${index}`}
                    type="button"
                    className="cursor-zoom-in overflow-hidden rounded-md border border-primary/30 bg-background/70"
                    onClick={() => setExpandedImageIndex(index)}
                  >
                    <img
                      src={toUserAttachmentImageSrc(source, projectId)}
                      alt={`Attached image ${index + 1}`}
                      className="h-20 max-w-36 object-cover"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            ) : null}

            {attachments.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                {attachments.map((attachment) => (
                  <Badge
                    key={attachment}
                    variant="outline"
                    className="rounded-full border-primary/30 bg-background/70 px-2 py-0 ui-text-2xs text-muted-foreground"
                  >
                    {attachment}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {currentImageSrc ? (
        <Dialog open={true} onOpenChange={(open) => !open && setExpandedImageIndex(null)}>
          <DialogContent className="flex h-[90vh] w-[90vw] max-w-[90vw] items-center justify-center border-none bg-transparent p-0 shadow-none [&>button]:hidden">
            <DialogTitle className="sr-only">Attached image preview</DialogTitle>
            <img
              src={currentImageSrc}
              alt="Attached image"
              className="max-h-[82vh] max-w-[90vw] rounded bg-background/95 object-contain"
            />

            {hasMultipleImages ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute left-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
                  onClick={() => {
                    setExpandedImageIndex((index) => {
                      if (index === null) return index;
                      return index === 0 ? imageSources.length - 1 : index - 1;
                    });
                  }}
                >
                  <ChevronLeft className="size-5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
                  onClick={() => {
                    setExpandedImageIndex((index) => {
                      if (index === null) return index;
                      return index === imageSources.length - 1 ? 0 : index + 1;
                    });
                  }}
                >
                  <ChevronRight className="size-5" />
                </Button>
              </>
            ) : null}

            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 size-9 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              >
                <X className="size-5" />
              </Button>
            </DialogClose>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function AssistantMessageRow({
  message,
}: {
  message: UIAssistantTextMessage;
}) {
  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1">
          <ConversationMarkdown content={message.text} />
        </div>
      </div>
    </div>
  );
}

function ReasoningRow({ message }: { message: UIAssistantReasoningMessage }) {
  const isStreaming = message.status === "streaming";
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const title = useMemo(() => getReasoningTitle(message.text), [message.text]);
  const expandable = useMemo(
    () => isStreaming || isReasoningExpandable(message.text, title),
    [isStreaming, message.text, title],
  );
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  useEffect(() => {
    if (isStreaming) setIsExpanded(true);
    if (!isStreaming && !expandable) setIsExpanded(false);
  }, [expandable, isStreaming]);

  if (!expandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-muted-foreground">
            <div className={`py-0.5 text-sm italic ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
              <span className="truncate">{title}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={isExpanded ? "Thinking..." : title}
          headerToneClass={headerToneClass}
          headerButtonClassName="italic"
          onToggle={() => setIsExpanded((prev) => !prev)}
        >
          <ConversationMarkdown
            content={message.text}
            className="italic text-muted-foreground"
          />
        </ExpandableEntryContainer>
      </div>
    </div>
  );
}

function isReadOnlyIntent(intent: UIToolParsedIntent): boolean {
  return intent.type === "read";
}

function isReadOnlyCall(call: UIToolExploringMessage["calls"][number]): boolean {
  return call.parsedCmd.length > 0 && call.parsedCmd.every((intent) => isReadOnlyIntent(intent));
}

function formatSearchDetail(intent: Extract<UIToolParsedIntent, { type: "search" }>): string {
  if (intent.query && intent.path) return `${intent.query} in ${intent.path}`;
  if (intent.query) return intent.query;
  return intent.cmd;
}

function formatExploringIntentLine(intent: UIToolParsedIntent): string {
  switch (intent.type) {
    case "read":
      return `Read ${intent.name}`;
    case "list_files":
      return `List ${intent.path && intent.path.length > 0 ? intent.path : intent.cmd}`;
    case "search":
      return `Search ${formatSearchDetail(intent)}`;
    case "unknown":
      return `Run ${intent.cmd}`;
    default:
      return assertNever(intent);
  }
}

function buildExploringDetailLines(
  calls: UIToolExploringMessage["calls"],
): string[] {
  const detailLines: string[] = [];
  let index = 0;

  while (index < calls.length) {
    const call = calls[index];
    if (!call) break;

    if (isReadOnlyCall(call)) {
      const readNames: string[] = [];
      const seen = new Set<string>();
      while (index < calls.length && calls[index] && isReadOnlyCall(calls[index])) {
        const current = calls[index];
        if (!current) break;
        for (const intent of current.parsedCmd) {
          if (intent.type !== "read") continue;
          if (seen.has(intent.name)) continue;
          seen.add(intent.name);
          readNames.push(intent.name);
        }
        index += 1;
      }

      if (readNames.length > 0) {
        detailLines.push(`Read ${readNames.join(", ")}`);
      }
      continue;
    }

    if (call.parsedCmd.length === 0) {
      if (call.command) detailLines.push(call.command);
      index += 1;
      continue;
    }

    for (const intent of call.parsedCmd) {
      detailLines.push(formatExploringIntentLine(intent));
    }
    index += 1;
  }

  return detailLines;
}

function summarizeExploringCounts(calls: UIToolExploringMessage["calls"]): {
  filesRead: number;
  searches: number;
  lists: number;
} {
  const readNames = new Set<string>();
  let searches = 0;
  let lists = 0;

  for (const call of calls) {
    for (const intent of call.parsedCmd) {
      switch (intent.type) {
        case "read":
          readNames.add(intent.name);
          break;
        case "search":
          searches += 1;
          break;
        case "list_files":
          lists += 1;
          break;
        case "unknown":
          break;
        default:
          assertNever(intent);
      }
    }
  }

  return {
    filesRead: readNames.size,
    searches,
    lists,
  };
}

function formatExploredSummary(counts: { filesRead: number; searches: number; lists: number }): string {
  const parts: string[] = [];
  if (counts.filesRead > 0) {
    parts.push(`${counts.filesRead} file${counts.filesRead === 1 ? "" : "s"}`);
  }
  if (counts.searches > 0) {
    parts.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`);
  }
  if (counts.lists > 0) {
    parts.push(`${counts.lists} list${counts.lists === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "Explored";
  return `Explored ${parts.join(", ")}`;
}

function formatExploringSummary(counts: { filesRead: number; searches: number; lists: number }): string {
  const exploredSummary = formatExploredSummary(counts);
  if (!exploredSummary.startsWith("Explored ")) return "Exploring...";
  return `Exploring ${exploredSummary.slice("Explored ".length)}...`;
}

function formatExploredDetail(counts: { filesRead: number; searches: number; lists: number }): string {
  const summary = formatExploredSummary(counts);
  if (!summary.startsWith("Explored ")) return "";
  return summary.slice("Explored ".length);
}

function renderShimmeringSummary(text: string, shouldShimmer: boolean): ReactNode {
  if (!shouldShimmer) return text;
  return <span className="animate-shine">{text}</span>;
}

function ToolExploringRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: {
  message: UIToolExploringMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const detailLines = useMemo(
    () => buildExploringDetailLines(message.calls),
    [message.calls],
  );
  const { elementRef: detailRef, handleScroll: handleDetailScroll } =
    useStickyBottomAutoScroll<HTMLDivElement>({
      isExpanded,
      scrollDep: detailLines,
    });
  const counts = useMemo(() => summarizeExploringCounts(message.calls), [message.calls]);
  const hasDetails = detailLines.length > 0;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const actionLabel =
    message.status === "pending" || preferOngoingLabels ? "Exploring" : "Explored";
  const isExploring = actionLabel === "Exploring";
  const exploringSummary = formatExploringSummary(counts);
  const exploringSummaryContent = renderShimmeringSummary(exploringSummary, isExploring);
  const exploredDetail = formatExploredDetail(counts);
  const collapsedSummaryContent =
    isExploring || !exploredDetail ? (
      isExploring ? exploringSummaryContent : actionLabel
    ) : (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground/90">Explored</span>
        <span className="truncate font-semibold text-foreground/95">
          {exploredDetail}
        </span>
      </span>
    );

  if (!hasDetails) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
            <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
              {collapsedSummaryContent}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={
            isExpanded ? (isExploring ? exploringSummaryContent : actionLabel) : collapsedSummaryContent
          }
          summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div
            ref={detailRef}
            onScroll={handleDetailScroll}
            className="mt-0.5 max-h-[220px] space-y-0.5 overflow-auto"
          >
            {detailLines.map((line, index) => (
              <div
                key={`${message.id}:${index}`}
                className="min-w-0 truncate font-mono ui-text-sm text-foreground/80"
                title={line}
              >
                {line}
              </div>
            ))}
          </div>
        </ExpandableEntryContainer>
      </div>
    </div>
  );
}

function ToolCallRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: {
  message: UIToolCallMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const command = message.command ?? message.toolName;
  const outputText = message.output && message.output.length > 0 ? message.output : "(no output)";
  const { elementRef: outputRef, handleScroll: handleOutputScroll } =
    useStickyBottomAutoScroll<HTMLPreElement>({
      isExpanded,
      scrollDep: outputText,
    });
  const renderedOutput = useMemo(() => ansiToHtml(outputText), [outputText]);
  const actionLabel =
    message.status === "error"
      ? "Failed"
      : message.status === "interrupted"
        ? "Declined"
        : message.status === "pending" || preferOngoingLabels
          ? "Running"
          : "Ran";
  const isRunning = actionLabel === "Running";
  const summaryText = isExpanded ? `${actionLabel} command` : `${actionLabel} ${command}`;
  const summaryContent = renderShimmeringSummary(summaryText, isRunning);
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div className="max-h-[320px] overflow-hidden rounded-lg border border-border bg-card">
            <div className="px-4 py-3 font-mono ui-text-sm leading-tight text-foreground">
              <div className="whitespace-pre-wrap break-words leading-tight">$ {command}</div>
              <pre
                ref={outputRef}
                onScroll={handleOutputScroll}
                className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words leading-tight text-muted-foreground"
                // ANSI conversion escapes XML/HTML and only emits style tags for terminal formatting.
                dangerouslySetInnerHTML={{ __html: renderedOutput }}
              >
              </pre>
            </div>
          </div>
        </ExpandableEntryContainer>
      </div>
    </div>
  );
}

function WebSearchRow({
  message,
  preferOngoingLabels = false,
}: {
  message: UIWebSearchMessage;
  preferOngoingLabels?: boolean;
}) {
  const summary =
    message.status === "pending" || preferOngoingLabels
      ? "Searching the web"
      : message.query
        ? `Searched ${message.query}`
        : "Searched the web";

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>{summary}</div>
        </div>
      </div>
    </div>
  );
}

function FileEditRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: {
  message: UIFileEditMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const preferredTheme = usePreferredTheme();
  const diffViewOptions = useMemo(
    () => ({
      ...DIFF_VIEW_BASE_OPTIONS,
      themeType: preferredTheme,
    }),
    [preferredTheme],
  );
  const firstChange = message.changes[0];
  const firstPath = firstChange?.path;
  const firstFileName = firstPath ? fileNameFromPath(firstPath) : "file";
  const firstMoveFileName = firstChange?.movePath
    ? fileNameFromPath(firstChange.movePath)
    : undefined;
  const uniqueFileCount = useMemo(
    () => uniqueChangedFileCount(message.changes),
    [message.changes],
  );
  const extraCount = Math.max(0, uniqueFileCount - 1);
  const collapsedFileLabel =
    firstMoveFileName && extraCount === 0
      ? `${firstFileName} → ${firstMoveFileName}`
      : extraCount > 0
        ? `${firstFileName} +${extraCount} more`
        : firstFileName;
  const collapsedStats = useMemo(
    () =>
      message.changes.reduce(
        (totals, change) => {
          const stats = diffStats(change);
          return {
            added: totals.added + stats.added,
            removed: totals.removed + stats.removed,
          };
        },
        { added: 0, removed: 0 },
      ),
    [message.changes],
  );
  const actionLabel = useMemo(() => {
    if (message.status === "error") return "Failed";
    if (message.status === "interrupted") return "Declined";
    if (message.status === "pending" || preferOngoingLabels) return "Applying";
    if (message.changes.length === 0) return "Edited";
    const actions = message.changes.map((change) => fileChangeAction(change));
    const first = actions[0];
    const hasMixed = actions.some((action) => action !== first);
    if (hasMixed || !first) return "Changed";
    return fileChangeActionLabel(first);
  }, [message.changes, message.status, preferOngoingLabels]);
  const title = isExpanded
    ? message.status === "pending" || preferOngoingLabels
      ? "Applying file changes"
      : message.status === "error"
        ? "Failed to apply file changes"
        : message.status === "interrupted"
          ? "Declined file changes"
          : `${actionLabel} ${uniqueFileCount === 1 ? "file" : "files"}`
    : `${actionLabel} ${collapsedFileLabel}`;
  const collapsedSummaryContent = isExpanded ? (
    title
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground/90">{actionLabel}</span>
      <span className="truncate font-semibold text-foreground/95">
        {collapsedFileLabel}
      </span>
      <span className="shrink-0 text-emerald-600">+{collapsedStats.added}</span>
      <span className="shrink-0 text-destructive/80">-{collapsedStats.removed}</span>
    </span>
  );
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={collapsedSummaryContent}
          summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div className="font-mono ui-text-sm text-foreground/90">
              {message.changes.map((change, index) => {
                const action = fileChangeAction(change);
                const stats = diffStats(change);
                const fileName = fileNameFromPath(change.path);
                const pathDetail = change.movePath
                  ? `${change.path} → ${change.movePath}`
                  : change.path;
                const patch = getRenderablePatch(change);
                return (
                  <div
                    key={`${change.path}:${change.movePath ?? ""}:${index}`}
                    className={index === 0 ? "" : "mt-1.5"}
                  >
                    <div className="overflow-hidden rounded-lg border border-border/60 bg-background/70">
                      <div className="flex items-center gap-2 px-3 pb-0.5 pt-2">
                        <span
                          className="min-w-0 flex-1 truncate font-mono ui-text-sm text-foreground/90"
                          title={change.path}
                        >
                          {fileName}
                        </span>
                        <span className="shrink-0 font-mono ui-text-sm">
                          <span className="text-emerald-600">+{stats.added}</span>{" "}
                          <span className="text-destructive/80">-{stats.removed}</span>
                        </span>
                      </div>
                      <div className="break-all px-3 pb-1 pt-0.5 font-mono ui-text-2xs text-muted-foreground/75">
                        {pathDetail}
                      </div>
                      <div className="max-h-[240px] overflow-auto border-t border-border/60 pb-1">
                        <div className="min-w-fit">
                          {patch ? (
                            <div style={DIFF_VIEW_STYLE}>
                              <PatchDiff patch={patch} options={diffViewOptions} />
                            </div>
                          ) : (
                            <div className="px-3 py-2 font-mono ui-text-xs text-muted-foreground/80">
                              (No diff provided)
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </ExpandableEntryContainer>
      </div>
    </div>
  );
}

interface ProvisioningSetupAttempt {
  scriptPath?: string;
  workspaceRoot?: string;
  timeout?: string;
  durationMs?: number;
  outputLines: string[];
}

interface ParsedProvisioningDetails {
  environment?: string;
  workspaceRoot?: string;
  setupAttempt?: ProvisioningSetupAttempt;
  additionalLines: string[];
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseProvisioningDurationMs(part: string): number | undefined {
  const match = part.match(/^Duration\s+(\d+)ms$/i);
  if (!match?.[1]) return undefined;
  const durationMs = Number.parseInt(match[1], 10);
  return Number.isNaN(durationMs) ? undefined : durationMs;
}

function parseProvisioningTimeout(part: string): string | undefined {
  const match = part.match(/^Timeout\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function isWorkspaceRootToken(part: string): boolean {
  return part.startsWith("/") || part.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(part);
}

function parseProvisioningSetupLine(line: string): ProvisioningSetupAttempt | null {
  const parts = line
    .split("•")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || !parts.some((part) => part.includes(".bb-env-setup"))) {
    return null;
  }

  let scriptPath: string | undefined;
  let workspaceRoot: string | undefined;
  let timeout: string | undefined;
  let durationMs: number | undefined;
  const outputLines: string[] = [];

  for (const part of parts) {
    if (!scriptPath && part.includes(".bb-env-setup")) {
      scriptPath = part;
      continue;
    }

    if (!workspaceRoot && isWorkspaceRootToken(part)) {
      workspaceRoot = part;
      continue;
    }

    if (!timeout) {
      const parsedTimeout = parseProvisioningTimeout(part);
      if (parsedTimeout) {
        timeout = parsedTimeout;
        continue;
      }
    }

    if (durationMs === undefined) {
      const parsedDurationMs = parseProvisioningDurationMs(part);
      if (parsedDurationMs !== undefined) {
        durationMs = parsedDurationMs;
        continue;
      }
    }

    outputLines.push(part);
  }

  return {
    scriptPath,
    workspaceRoot,
    timeout,
    durationMs,
    outputLines,
  };
}

function isLikelyProvisioningEnvironmentToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "worktree" || normalized === "local" || normalized.includes("workspace");
}

function parseProvisioningSummaryLine(
  line: string,
): { environment?: string; workspaceRoot?: string; remainingLine?: string } | null {
  const parts = line
    .split("•")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  let environment: string | undefined;
  let workspaceRoot: string | undefined;
  const remainingParts: string[] = [];

  for (const [index, part] of parts.entries()) {
    if (!workspaceRoot && isWorkspaceRootToken(part)) {
      workspaceRoot = part;
      continue;
    }
    if (!environment && index === 0 && isLikelyProvisioningEnvironmentToken(part)) {
      environment = part;
      continue;
    }
    remainingParts.push(part);
  }

  if (!environment && !workspaceRoot) {
    return null;
  }

  return {
    environment,
    workspaceRoot,
    remainingLine: remainingParts.length > 0 ? remainingParts.join(" • ") : undefined,
  };
}

function pickBestProvisioningSetupAttempt(
  attempts: ProvisioningSetupAttempt[],
): ProvisioningSetupAttempt | undefined {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    if (attempt.durationMs !== undefined || attempt.outputLines.length > 0) {
      return attempt;
    }
  }
  return attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
}

function parseProvisioningDetails(detail: string | undefined): ParsedProvisioningDetails | null {
  const lines = splitNonEmptyLines(detail);
  if (lines.length === 0) return null;

  let environment: string | undefined;
  let workspaceRoot: string | undefined;
  const attempts: ProvisioningSetupAttempt[] = [];
  let currentAttempt: ProvisioningSetupAttempt | undefined;
  const additionalLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("Environment:")) {
      const nextEnvironment = line.slice("Environment:".length).trim();
      if (nextEnvironment.length > 0) {
        environment = nextEnvironment;
      }
      continue;
    }

    const parsedAttempt = parseProvisioningSetupLine(line);
    if (parsedAttempt) {
      attempts.push(parsedAttempt);
      currentAttempt = parsedAttempt;
      continue;
    }

    if (!currentAttempt) {
      const parsedSummary = parseProvisioningSummaryLine(line);
      if (parsedSummary) {
        if (!environment && parsedSummary.environment) {
          environment = parsedSummary.environment;
        }
        if (!workspaceRoot && parsedSummary.workspaceRoot) {
          workspaceRoot = parsedSummary.workspaceRoot;
        }
        if (parsedSummary.remainingLine) {
          additionalLines.push(parsedSummary.remainingLine);
        }
        continue;
      }
    }

    if (currentAttempt) {
      const parsedSummary = parseProvisioningSummaryLine(line);
      if (parsedSummary) {
        if (!environment && parsedSummary.environment) {
          environment = parsedSummary.environment;
        }
        if (!workspaceRoot && parsedSummary.workspaceRoot) {
          workspaceRoot = parsedSummary.workspaceRoot;
        }
        if (parsedSummary.remainingLine) {
          additionalLines.push(parsedSummary.remainingLine);
        }
        continue;
      }

      if (line.includes("•") && !line.includes(".bb-env-setup")) {
        additionalLines.push(line);
        continue;
      }
      currentAttempt.outputLines.push(line);
      continue;
    }

    additionalLines.push(line);
  }

  const setupAttempt = pickBestProvisioningSetupAttempt(attempts);
  if (!environment && !setupAttempt && additionalLines.length === 0) {
    return null;
  }

  return {
    environment,
    workspaceRoot,
    setupAttempt,
    additionalLines,
  };
}

function normalizeProvisioningEnvironmentLabel(environment: string | undefined): string | undefined {
  const value = environment?.trim();
  if (!value) return undefined;

  const normalized = value.toLowerCase();
  if (normalized.includes("worktree")) return "worktree";
  if (normalized.includes("local")) return "local";

  // Environment labels in provisioning events are open_external; keep unknown values as-is.
  return value;
}

function provisioningSetupTimedOut(setupAttempt: ProvisioningSetupAttempt | undefined): boolean {
  if (!setupAttempt?.timeout) return false;
  return setupAttempt.outputLines.some((line) => /\btimed out\b/i.test(line));
}

function resolveProvisioningSetupScriptPath(
  setupAttempt: ProvisioningSetupAttempt | undefined,
): string | undefined {
  const scriptPath = setupAttempt?.scriptPath?.trim();
  if (!scriptPath) return undefined;
  if (isWorkspaceRootToken(scriptPath)) return scriptPath;
  const workspaceRoot = setupAttempt?.workspaceRoot?.trim();
  if (!workspaceRoot) return undefined;
  return resolveWorkspaceAbsolutePath(workspaceRoot, scriptPath);
}

function formatDurationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = durationMs / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function getProvisioningSetupStatus(
  setupAttempt: ProvisioningSetupAttempt | undefined,
  isProvisioningCompleted: boolean,
): "Failed" | "Completed" | "Running" | undefined {
  if (!setupAttempt) return undefined;
  if (setupAttempt.outputLines.length > 0) return "Failed";
  if (setupAttempt.durationMs !== undefined || isProvisioningCompleted) return "Completed";
  return "Running";
}

function OperationRow({
  message,
  initialExpanded = false,
}: {
  message: UIOperationMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  if (message.opType === "plan-updated") {
    const detailLines = (message.detail ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hasDetails = detailLines.length > 0;
    const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

    if (!hasDetails) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
                {message.title}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={message.title}
            summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"}
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            <div className="mt-0.5 space-y-0.5">
              {detailLines.map((line, index) => (
                <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">
                  {line}
                </div>
              ))}
            </div>
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  if (message.opType === "provisioning") {
    const parsedDetails = parseProvisioningDetails(message.detail);
    const fallbackDetailLines = splitNonEmptyLines(message.detail);
    const hasParsedDetails = Boolean(parsedDetails);
    const hasDetails = hasParsedDetails || fallbackDetailLines.length > 0;
    const isCompleted = message.title.startsWith("Provisioned ");
    const environmentLabel = isCompleted
      ? message.title.slice("Provisioned ".length).trim()
      : message.title.startsWith("Provisioning ")
        ? message.title.slice("Provisioning ".length).replace(/\.\.\.$/, "").trim()
        : "";
    const actionLabel = isCompleted ? "Provisioned" : "Provisioning";
    const setupAttempt = parsedDetails?.setupAttempt;
    const setupStatus = getProvisioningSetupStatus(setupAttempt, isCompleted);
    const setupTimedOut = provisioningSetupTimedOut(setupAttempt);
    const outputText = setupAttempt?.outputLines.join("\n").trim();
    const additionalDetailsText = parsedDetails?.additionalLines.join("\n").trim();
    const setupScriptPath = resolveProvisioningSetupScriptPath(setupAttempt);
    const setupScriptLabel = setupScriptPath ?? setupAttempt?.scriptPath;
    const workspacePath = setupAttempt?.workspaceRoot ?? parsedDetails?.workspaceRoot;
    const setupTimeLabel = setupAttempt
      ? setupAttempt.durationMs !== undefined
        ? `${formatDurationLabel(setupAttempt.durationMs)}${
          setupTimedOut && setupAttempt.timeout ? ` / timeout ${setupAttempt.timeout}` : ""
        }`
        : setupTimedOut && setupAttempt.timeout
          ? `timeout ${setupAttempt.timeout}`
          : undefined
      : undefined;
    const environmentValue = normalizeProvisioningEnvironmentLabel(
      parsedDetails?.environment || environmentLabel || undefined,
    );
    const setupStatusVariant: StatusPillVariant =
      setupStatus === "Failed"
        ? "destructive"
        : "outline";
    const setupStatusClassName = setupStatus === "Completed"
      ? "border-transparent bg-foreground text-background"
      : undefined;
    const collapsedSummaryContent =
      actionLabel === "Provisioned" && environmentLabel ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground/90">Provisioned</span>
          <span className="truncate font-semibold text-foreground/95">{environmentLabel}</span>
        </span>
      ) : (
        message.title
      );

    if (!hasDetails) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
                {collapsedSummaryContent}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={isExpanded ? actionLabel : collapsedSummaryContent}
            summaryContentClassName={isExpanded ? COLLAPSIBLE_HEADER_TEXT_CLASS : "min-w-0"}
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            {hasParsedDetails ? (
              <DetailCard className="mt-0.5 border-border/60 bg-background/50">
                {environmentValue ? (
                  <DetailRow label="Environment">
                    <span>{environmentValue}</span>
                  </DetailRow>
                ) : null}
                {setupScriptLabel ? (
                  <DetailRow label="Setup script">
                    {setupScriptPath ? (
                      <OpenPathButton
                        path={setupScriptPath}
                        target="file"
                        title={setupScriptLabel}
                      >
                        {setupScriptLabel}
                      </OpenPathButton>
                    ) : (
                      <span
                        className="block truncate text-xs text-muted-foreground/90"
                        title={setupScriptLabel}
                      >
                        {setupScriptLabel}
                      </span>
                    )}
                  </DetailRow>
                ) : null}
                {setupStatus ? (
                  <DetailRow label="Setup status">
                    <StatusPill variant={setupStatusVariant} className={setupStatusClassName}>
                      {setupStatus}
                    </StatusPill>
                  </DetailRow>
                ) : null}
                {setupTimeLabel ? (
                  <DetailRow label="Setup time">
                    <span className="font-mono ui-text-sm text-foreground/85">{setupTimeLabel}</span>
                  </DetailRow>
                ) : null}
                {workspacePath ? (
                  <DetailRow label="Workspace">
                    <OpenPathButton
                      path={workspacePath}
                      target="directory"
                      title={workspacePath}
                    >
                      {workspacePath}
                    </OpenPathButton>
                  </DetailRow>
                ) : null}
                {outputText ? (
                  <DetailRow label="Output" align="start">
                    <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 px-2 py-1.5 font-mono ui-text-xs leading-tight text-muted-foreground">
                      {outputText}
                    </pre>
                  </DetailRow>
                ) : null}
                {additionalDetailsText ? (
                  <DetailRow label="Additional details" align="start">
                    <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 px-2 py-1.5 font-mono ui-text-xs leading-tight text-muted-foreground">
                      {additionalDetailsText}
                    </pre>
                  </DetailRow>
                ) : null}
              </DetailCard>
            ) : (
              <div className="mt-0.5 space-y-0.5">
                {fallbackDetailLines.map((line, index) => (
                  <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  if (message.opType === "thread-operation-intent") {
    const detailText = message.detail?.trim();
    if (!detailText) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full rounded-md px-2 py-1 text-sm text-muted-foreground">
            <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
              {message.title}
            </div>
          </div>
        </div>
      );
    }

    const promptLabel = "Prompt:\n";
    const promptStart = detailText.indexOf(promptLabel);
    if (promptStart === -1) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground/80">{message.title}</span>
              <span className="ml-2 text-muted-foreground/80">{detailText}</span>
            </div>
          </div>
        </div>
      );
    }

    const operationDetailText = detailText.slice(0, promptStart).trim();
    const promptText = detailText.slice(promptStart + promptLabel.length).trim();

    if (!promptText) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground/80">{message.title}</span>
              {operationDetailText ? (
                <span className="ml-2 text-muted-foreground/80">{operationDetailText}</span>
              ) : null}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={message.title}
            summaryContentClassName="min-w-0"
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            <pre
              className="mt-0.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/70 px-2 py-1.5 font-mono ui-text-xs leading-tight text-muted-foreground"
            >
              {promptText}
            </pre>
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  if (message.opType === "worktree-commit") {
    const detailLines = (message.detail ?? "")
      .split("•")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const commitHash =
      detailLines.find((line) => /^[0-9a-f]{7,40}$/i.test(line)) ??
      detailLines[detailLines.length - 1];
    const hasCommitHash = Boolean(commitHash);
    const collapsedSummaryContent =
      message.title === "Committed changes" ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground/90">Committed</span>
          <span className="truncate font-semibold text-foreground/95">changes</span>
        </span>
      ) : (
        message.title
      );

    if (!hasCommitHash) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
                {collapsedSummaryContent}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={collapsedSummaryContent}
            summaryContentClassName="min-w-0"
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            <div className="mt-0.5">
              <div className="font-mono ui-text-sm text-foreground/80">{commitHash}</div>
            </div>
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  if (message.opType === "worktree-squash-merge") {
    const detailLines = (message.detail ?? "")
      .split("•")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hasDetails = detailLines.length > 0;
    const mergedBranchMatch = message.detail?.match(
      /\b(?:into|to)\s+[`'"]?([A-Za-z0-9._/-]+)[`'"]?/i,
    );
    const mergedBranch = mergedBranchMatch?.[1];
    const collapsedSummaryContent =
      message.title === "Squash merged" && mergedBranch ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-muted-foreground/90">Squash merged into</span>
          <em className="truncate font-semibold text-foreground/95">{mergedBranch}</em>
        </span>
      ) : (
        message.title
      );

    if (message.title === "Squash merged" && mergedBranch) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
                {collapsedSummaryContent}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (!hasDetails) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={`py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`}>
                {collapsedSummaryContent}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={collapsedSummaryContent}
            summaryContentClassName="min-w-0"
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            <div className="mt-0.5 space-y-0.5">
              {detailLines.map((line, index) => (
                <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">
                  {line}
                </div>
              ))}
            </div>
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  if (message.opType === "primary-checkout") {
    const detailLines = (message.detail ?? "")
      .split("•")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hasDetails = detailLines.length > 0;
    const shouldUseSubtlePrimaryCheckoutTitle =
      message.title === "Promoted to primary checkout" ||
      message.title === "Demoted from primary checkout" ||
      message.title === "Promoted then demoted as primary checkout";
    const primaryCheckoutTitleClassName = shouldUseSubtlePrimaryCheckoutTitle
      ? "text-muted-foreground/70"
      : undefined;
    const primaryCheckoutSummaryContentClassName = primaryCheckoutTitleClassName
      ? `min-w-0 ${primaryCheckoutTitleClassName}`
      : "min-w-0";
    const primaryCheckoutStaticTitleClassName = primaryCheckoutTitleClassName
      ? `py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS} ${primaryCheckoutTitleClassName}`
      : `py-0.5 ${COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}`;

    if (!hasDetails) {
      return (
        <div className="group w-full" style={{ overflowAnchor: "none" }}>
          <div className="mr-auto w-full">
            <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
              <div className={primaryCheckoutStaticTitleClassName}>
                {message.title}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <ExpandableEntryContainer
            isExpanded={isExpanded}
            summaryContent={message.title}
            summaryContentClassName={primaryCheckoutSummaryContentClassName}
            headerToneClass={headerToneClass}
            onToggle={onToggle}
          >
            <div className="mt-0.5 space-y-0.5">
              {detailLines.map((line, index) => (
                <div key={`${message.id}:${index}`} className="font-mono ui-text-sm text-foreground/80">
                  {line}
                </div>
              ))}
            </div>
          </ExpandableEntryContainer>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
          <span className="font-medium text-foreground/80">{message.title}</span>
          {message.detail ? <span className="ml-2 text-muted-foreground/80">{message.detail}</span> : null}
        </div>
      </div>
    </div>
  );
}

function normalizeErrorMessageText(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes("\n")) return normalized;
  if (!normalized.includes("\\n") && !normalized.includes("\\r\\n")) return normalized;
  if (/[A-Za-z]:\\\\/.test(normalized)) return normalized;
  return normalized.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
}

function isThreadProvisioningFailureTitle(value: string): boolean {
  return /^Thread provisioning failed for project\s+.+$/i.test(value.trim());
}

function normalizeProvisioningErrorDetail(detail: string): string {
  let normalized = normalizeErrorMessageText(detail).trim();
  if (!normalized) return normalized;
  if (!normalized.startsWith(".bb-env-setup.sh failed:")) {
    return normalized;
  }

  normalized = normalized.replace(
    /^(\.bb-env-setup\.sh failed:)\s*•\s*/i,
    "$1\n• ",
  );
  return normalized.replace(/\s+•\s+/g, "\n• ");
}

function normalizeErrorDetailForDisplay(title: string, detail?: string): string | undefined {
  const normalized = detail?.trim();
  if (!normalized) return undefined;
  if (title === "Thread provisioning failed") {
    return normalizeProvisioningErrorDetail(normalized);
  }
  return normalizeErrorMessageText(normalized).trim();
}

function parseErrorDisplay(message: UIErrorMessage): {
  title: string;
  detail?: string;
  hint?: string;
} {
  const trimmed = normalizeErrorMessageText(message.message).trim();
  if (!trimmed) {
    return {
      title: "Error event",
    };
  }

  const [titleCandidate, ...detailParts] = trimmed.split(" - ");
  const detailFromDelimiter = normalizeErrorMessageText(detailParts.join(" - ")).trim();
  const titleFromDelimiter = titleCandidate?.trim();

  if (message.rawType === "system/error" && trimmed.startsWith("Project folder not found")) {
    const missingPathMatch = trimmed.match(/^Project folder not found:\s*(.+?)(?:\s+-\s+.*)?$/);
    const missingPath = missingPathMatch?.[1]?.trim();
    const detail = missingPath
      ? `Project folder not found: ${missingPath}. Please update the project path and try again.`
      : "Project folder not found. Please update the project path and try again.";
    return {
      title: "Project folder is missing",
      detail,
    };
  }

  if (
    titleFromDelimiter &&
    isThreadProvisioningFailureTitle(titleFromDelimiter)
  ) {
    return {
      title: "Thread provisioning failed",
      detail: detailFromDelimiter
        ? normalizeProvisioningErrorDetail(detailFromDelimiter)
        : undefined,
    };
  }

  if (isThreadProvisioningFailureTitle(trimmed)) {
    return {
      title: "Thread provisioning failed",
    };
  }

  if (
    titleFromDelimiter &&
    detailFromDelimiter &&
    titleFromDelimiter.length <= 96
  ) {
    return {
      title: titleFromDelimiter,
      detail: detailFromDelimiter,
    };
  }

  return {
    title: trimmed,
  };
}

function ErrorRow({
  message,
  initialExpanded = false,
}: {
  message: UIErrorMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const display = parseErrorDisplay(message);
  const isExpandable = Boolean(display.detail?.trim() || display.hint?.trim());
  const headerToneClass = isExpanded
    ? "text-destructive"
    : isExpandable
      ? "text-destructive/90 transition-colors group-hover:text-destructive group-focus-within:text-destructive"
      : "text-destructive/90";
  const summaryContent = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-destructive/85">Error:</span>
      <span className="truncate font-semibold text-destructive">
        {display.title}
      </span>
    </span>
  );
  const detailText = normalizeErrorDetailForDisplay(display.title, display.detail);
  const hasMultilineDetail = Boolean(detailText?.includes("\n"));

  if (!isExpandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full rounded-md px-2 py-1 text-muted-foreground">
          <CollapsibleHeader
            toneClassName={headerToneClass}
            summaryClassName="min-w-0"
            summaryContent={summaryContent}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName="min-w-0"
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div className="space-y-1 rounded-md border border-destructive/25 bg-destructive/[0.06] px-2 py-1.5 ui-text-sm text-destructive/90">
            {detailText ? (
              hasMultilineDetail ? (
                <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md px-1 py-0.5 font-mono ui-text-xs leading-tight text-destructive/90">
                  {detailText}
                </pre>
              ) : (
                <p className="whitespace-pre-wrap break-words">
                  {detailText}
                </p>
              )
            ) : null}
            {display.hint ? <p>{display.hint}</p> : null}
          </div>
        </ExpandableEntryContainer>
      </div>
    </div>
  );
}

function DebugEventRow({ message }: { message: UIDebugRawEventMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const event = message.rawEvent;
  const expandedContent = formatDebugEventData(event.data, {
    maxLength: DEBUG_EVENT_EXPANDED_MAX_LENGTH,
    pretty: true,
  });

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          className="w-full px-1 py-0.5 text-left"
        >
          <p className="flex items-center gap-1.5 font-mono ui-text-xs text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            <span className="shrink-0">#{event.seq}</span>
            <span className="shrink-0">{message.rawType}</span>
            <Badge variant="outline" className="h-4 rounded px-1 ui-text-3xs">
              {message.reason}
            </Badge>
          </p>
        </button>
        {isExpanded ? (
          <div className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
            <pre className="whitespace-pre-wrap break-all font-mono ui-text-xs text-muted-foreground/80">
              {expandedContent}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConversationEntryComponent({
  message,
  projectId,
  initialExpanded = false,
  preferOngoingLabels = false,
}: ConversationEntryProps) {
  if (message.kind === "user") {
    return <UserMessageRow message={message} projectId={projectId} />;
  }

  if (message.kind === "assistant-reasoning") {
    return <ReasoningRow message={message} />;
  }

  if (message.kind === "assistant-text") {
    return <AssistantMessageRow message={message} />;
  }

  if (message.kind === "tool-exploring") {
    return (
      <ToolExploringRow
        message={message}
        initialExpanded={initialExpanded}
        preferOngoingLabels={preferOngoingLabels}
      />
    );
  }

  if (message.kind === "tool-call") {
    return (
      <ToolCallRow
        message={message}
        initialExpanded={initialExpanded}
        preferOngoingLabels={preferOngoingLabels}
      />
    );
  }

  if (message.kind === "web-search") {
    return (
      <WebSearchRow message={message} preferOngoingLabels={preferOngoingLabels} />
    );
  }

  if (message.kind === "file-edit") {
    return (
      <FileEditRow
        message={message}
        initialExpanded={initialExpanded}
        preferOngoingLabels={preferOngoingLabels}
      />
    );
  }

  if (message.kind === "operation") {
    return <OperationRow message={message} initialExpanded={initialExpanded} />;
  }

  if (message.kind === "error") {
    return <ErrorRow message={message} initialExpanded={initialExpanded} />;
  }

  if (message.kind === "debug/raw-event") {
    return <DebugEventRow message={message} />;
  }

  return null;
}

export const ConversationEntry = memo(ConversationEntryComponent);
ConversationEntry.displayName = "ConversationEntry";
