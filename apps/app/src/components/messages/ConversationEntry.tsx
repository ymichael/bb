import { memo, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
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
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";
import {
  CollapsibleHeader,
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  COLLAPSIBLE_HEADER_TEXT_CLASS,
  getCollapsibleHeaderToneClass,
} from "@/components/messages/CollapsibleHeader";
import { ConversationMarkdown } from "./ConversationMarkdown";

interface ConversationEntryProps {
  message: UIMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

const DEBUG_EVENT_EXPANDED_MAX_LENGTH = 4000;

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

function diffStats(diff: string | undefined): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };

  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }

  return { added, removed };
}

type ParsedDiffLineType = "add" | "del" | "normal" | "hunk" | "meta";

interface ParsedDiffLine {
  type: ParsedDiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

function parseUnifiedDiffLines(diff: string | undefined): ParsedDiffLine[] {
  if (!diff || diff.trim().length === 0) {
    return [{ type: "meta", content: "(No diff provided)" }];
  }

  const lines = diff.split("\n");
  const parsed: ParsedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let hasHunkHeader = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hasHunkHeader = true;
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match?.[1] && match?.[2]) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      parsed.push({ type: "hunk", content: line });
      continue;
    }

    if (line.startsWith("diff --git") || line.startsWith("index ")) {
      parsed.push({ type: "meta", content: line });
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      parsed.push({ type: "meta", content: line });
      continue;
    }

    if (line.startsWith("+")) {
      parsed.push({
        type: "add",
        content: line,
        newLineNumber: hasHunkHeader ? newLine : undefined,
      });
      if (hasHunkHeader) newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      parsed.push({
        type: "del",
        content: line,
        oldLineNumber: hasHunkHeader ? oldLine : undefined,
      });
      if (hasHunkHeader) oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      parsed.push({
        type: "normal",
        content: line,
        oldLineNumber: hasHunkHeader ? oldLine : undefined,
        newLineNumber: hasHunkHeader ? newLine : undefined,
      });
      if (hasHunkHeader) {
        oldLine += 1;
        newLine += 1;
      }
      continue;
    }

    parsed.push({
      type: "normal",
      content: line,
      oldLineNumber: hasHunkHeader ? oldLine : undefined,
      newLineNumber: hasHunkHeader ? newLine : undefined,
    });
    if (hasHunkHeader) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return parsed;
}

function DiffLine({
  line,
}: {
  line: ParsedDiffLine;
}) {
  if (line.type === "hunk") {
    return (
      <div className="px-2 py-0.5 font-mono ui-text-2xs text-muted-foreground/90">
        {line.content}
      </div>
    );
  }

  if (line.type === "meta") {
    return (
      <div className="px-2 py-0.5 font-mono ui-text-2xs text-muted-foreground/80">
        {line.content}
      </div>
    );
  }

  let lineClassName = "bg-background/90 border-l-2 border-transparent";
  let contentClassName = "text-foreground/85";

  if (line.type === "add") {
    lineClassName = "bg-emerald-500/10 border-l-2 border-emerald-500/60";
    contentClassName = "text-emerald-700 dark:text-emerald-300";
  } else if (line.type === "del") {
    lineClassName = "bg-destructive/10 border-l-2 border-destructive/60";
    contentClassName = "text-destructive/90";
  }

  return (
    <div
      className={`grid items-center px-2 py-0.5 font-mono ui-text-xs ${lineClassName}`}
      style={{ gridTemplateColumns: "30px 30px 1fr", whiteSpace: "pre" }}
    >
      <span className="select-none pr-2 text-right ui-text-2xs text-muted-foreground/70">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="select-none pr-2 text-right ui-text-2xs text-muted-foreground/70">
        {line.newLineNumber ?? ""}
      </span>
      <span className={contentClassName}>{line.content}</span>
    </div>
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

function UserMessageRow({ message }: { message: UIUserMessage }) {
  const attachments: string[] = [];
  if (message.attachments?.webImages) {
    const count = message.attachments.webImages;
    attachments.push(`${count} web image${count === 1 ? "" : "s"}`);
  }
  if (message.attachments?.localImages) {
    const count = message.attachments.localImages;
    attachments.push(`${count} local image${count === 1 ? "" : "s"}`);
  }

  return (
    <div className="group w-full py-2" style={{ overflowAnchor: "none" }}>
      <div className="ml-auto w-fit max-w-[80%]">
        <div className="rounded-md bg-primary/10 p-2 text-sm leading-relaxed text-foreground">
          {message.text ? (
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          ) : (
            <p className="text-muted-foreground">Sent attachments</p>
          )}
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
  if (intent.type === "read") return `Read ${intent.name}`;
  if (intent.type === "list_files") {
    return `List ${intent.path && intent.path.length > 0 ? intent.path : intent.cmd}`;
  }
  if (intent.type === "search") return `Search ${formatSearchDetail(intent)}`;
  return intent.cmd;
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
} {
  const readNames = new Set<string>();
  let searches = 0;

  for (const call of calls) {
    for (const intent of call.parsedCmd) {
      if (intent.type === "read") {
        readNames.add(intent.name);
        continue;
      }
      if (intent.type === "search") {
        searches += 1;
      }
    }
  }

  return {
    filesRead: readNames.size,
    searches,
  };
}

function formatExploredSummary(counts: { filesRead: number; searches: number }): string {
  const parts: string[] = [];
  if (counts.filesRead > 0) {
    parts.push(`${counts.filesRead} file${counts.filesRead === 1 ? "" : "s"}`);
  }
  if (counts.searches > 0) {
    parts.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`);
  }
  if (parts.length === 0) return "Explored";
  return `Explored ${parts.join(", ")}`;
}

function formatExploredDetail(counts: { filesRead: number; searches: number }): string {
  const summary = formatExploredSummary(counts);
  if (!summary.startsWith("Explored ")) return "";
  return summary.slice("Explored ".length);
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
  const counts = useMemo(() => summarizeExploringCounts(message.calls), [message.calls]);
  const hasDetails = detailLines.length > 0;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);
  const actionLabel =
    message.status === "pending" || preferOngoingLabels ? "Exploring" : "Explored";
  const exploredDetail = formatExploredDetail(counts);
  const collapsedSummaryContent =
    actionLabel === "Exploring" || !exploredDetail ? (
      actionLabel
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
          summaryContent={isExpanded ? actionLabel : collapsedSummaryContent}
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
  const actionLabel =
    message.status === "error"
      ? "Failed"
      : message.status === "interrupted"
        ? "Declined"
        : message.status === "pending" || preferOngoingLabels
          ? "Running"
          : "Ran";
  const summaryText = isExpanded ? `${actionLabel} command` : `${actionLabel} ${command}`;
  const headerToneClass = getCollapsibleHeaderToneClass(isExpanded);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={summaryText}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <div className="overflow-hidden rounded-lg border border-zinc-700/40 bg-zinc-900/90">
            <div className="px-4 py-3 font-mono ui-text-sm leading-tight text-zinc-100">
              <div className="whitespace-pre-wrap break-words leading-tight">$ {command}</div>
              <pre className="mt-1.5 max-h-[220px] overflow-auto whitespace-pre-wrap break-words leading-tight text-zinc-400">
                {message.output && message.output.length > 0
                  ? message.output
                  : "(no output)"}
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
  const firstChange = message.changes[0];
  const firstPath = firstChange?.path;
  const firstFileName = firstPath ? fileNameFromPath(firstPath) : "file";
  const firstMoveFileName = firstChange?.movePath
    ? fileNameFromPath(firstChange.movePath)
    : undefined;
  const extraCount = Math.max(0, message.changes.length - 1);
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
          const stats = diffStats(change.diff);
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
          : `${actionLabel} ${message.changes.length === 1 ? "file" : "files"}`
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
                const actionChip = fileChangeActionLabel(action);
                const stats = diffStats(change.diff);
                const diffLines = parseUnifiedDiffLines(change.diff);
                const fileName = fileNameFromPath(change.path);
                const pathDetail = change.movePath
                  ? `${change.path} → ${change.movePath}`
                  : change.path;
                const visibleDiffLines = diffLines.filter(
                  (line) => line.type !== "meta" && line.type !== "hunk",
                );
                return (
                  <div
                    key={`${change.path}:${change.movePath ?? ""}:${index}`}
                    className={index === 0 ? "" : "mt-1.5"}
                  >
                    <div className="overflow-hidden rounded-lg border border-border/60 bg-background/70">
                      <div className="flex items-center gap-2 px-3 pb-0.5 pt-2">
                        <Badge variant="outline" className="h-4 rounded px-1 ui-text-3xs">
                          {actionChip}
                        </Badge>
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
                          {visibleDiffLines.length > 0 ? (
                            visibleDiffLines.map((line, lineIndex) => (
                              <DiffLine key={`${change.path}:${lineIndex}`} line={line} />
                            ))
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

function OperationRow({ message }: { message: UIOperationMessage }) {
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

function parseErrorDisplay(message: UIErrorMessage): {
  title: string;
  detail?: string;
  hint?: string;
} {
  const trimmed = message.message.trim();
  if (!trimmed) {
    return {
      title: "Error event",
    };
  }

  const [titleCandidate, ...detailParts] = trimmed.split(" - ");
  const detailFromDelimiter = detailParts.join(" - ").trim();
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
  const headerToneClass = isExpanded
    ? "text-destructive"
    : "text-destructive/90 transition-colors group-hover:text-destructive group-focus-within:text-destructive";
  const summaryContent = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-destructive/85">Error:</span>
      <span className="truncate font-semibold text-destructive">
        {display.title}
      </span>
    </span>
  );

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
            {display.detail ? (
              <p className="whitespace-pre-wrap break-words">
                {display.detail}
              </p>
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
  initialExpanded = false,
  preferOngoingLabels = false,
}: ConversationEntryProps) {
  if (message.kind === "user") {
    return <UserMessageRow message={message} />;
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
    return <OperationRow message={message} />;
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
