import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  UIMessage,
  UIDebugRawEventMessage,
  UIErrorMessage,
  UIFileEditMessage,
  UIOperationMessage,
  UIToolCallMessage,
  UIUserMessage,
  UIAssistantReasoningMessage,
  UIAssistantTextMessage,
} from "@beanbag/core";
import { ChevronDown, ChevronRight, CircleX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConversationMarkdown } from "./ConversationMarkdown";

interface ConversationEntryProps {
  message: UIMessage;
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
      <div className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/90">
        {line.content}
      </div>
    );
  }

  if (line.type === "meta") {
    return (
      <div className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground/80">
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
      className={`grid items-center px-2 py-0.5 font-mono text-[11px] ${lineClassName}`}
      style={{ gridTemplateColumns: "30px 30px 1fr", whiteSpace: "pre" }}
    >
      <span className="select-none pr-2 text-right text-[10px] text-muted-foreground/70">
        {line.oldLineNumber ?? ""}
      </span>
      <span className="select-none pr-2 text-right text-[10px] text-muted-foreground/70">
        {line.newLineNumber ?? ""}
      </span>
      <span className={contentClassName}>{line.content}</span>
    </div>
  );
}

const HEADER_COLLAPSED_TONE_CLASS =
  "text-muted-foreground/90 transition-colors group-hover:text-foreground/90 group-focus-within:text-foreground/90";
const HEADER_EXPANDED_TONE_CLASS = "text-foreground/90";
const HEADER_STATIC_TONE_CLASS = "text-muted-foreground/90";
const HEADER_BUTTON_BASE_CLASS =
  "inline-flex max-w-full items-center gap-1 overflow-hidden py-0.5 text-left text-sm";
const HEADER_TEXT_CLASS = "min-w-0 truncate";
const HEADER_CHEVRON_COLLAPSED_CLASS =
  "size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100";

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
        <button
          type="button"
          onClick={onToggle}
          className={`${HEADER_BUTTON_BASE_CLASS} ${headerToneClass}${headerButtonClassName ? ` ${headerButtonClassName}` : ""}`}
        >
          <span className={summaryContentClassName ?? HEADER_TEXT_CLASS}>
            {summaryContent}
          </span>
          {isExpanded ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className={HEADER_CHEVRON_COLLAPSED_CLASS} />
          )}
        </button>
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
                  className="rounded-full border-primary/30 bg-background/70 px-2 py-0 text-[10px] text-muted-foreground"
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
  const headerToneClass = isExpanded
    ? HEADER_EXPANDED_TONE_CLASS
    : HEADER_COLLAPSED_TONE_CLASS;

  useEffect(() => {
    if (isStreaming) setIsExpanded(true);
    if (!isStreaming && !expandable) setIsExpanded(false);
  }, [expandable, isStreaming]);

  if (!expandable) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-muted-foreground">
            <div className={`py-0.5 text-sm italic ${HEADER_STATIC_TONE_CLASS}`}>
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

function ToolCallRow({ message }: { message: UIToolCallMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const command = message.command ?? message.toolName;
  const actionLabel =
    message.status === "error"
      ? "Failed"
      : message.status === "interrupted"
        ? "Declined"
        : message.status === "pending"
          ? "Running"
          : "Ran";
  const summaryText = isExpanded ? `${actionLabel} command` : `${actionLabel} ${command}`;
  const headerToneClass = isExpanded
    ? HEADER_EXPANDED_TONE_CLASS
    : HEADER_COLLAPSED_TONE_CLASS;

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={summaryText}
          headerToneClass={headerToneClass}
          onToggle={() => setIsExpanded((prev) => !prev)}
        >
          <div className="overflow-hidden rounded-lg border border-zinc-700/40 bg-zinc-900/90">
            <div className="px-4 py-3 font-mono text-[12px] leading-tight text-zinc-100">
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

function FileEditRow({ message }: { message: UIFileEditMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);
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
    if (message.status === "pending") return "Applying";
    if (message.changes.length === 0) return "Edited";
    const actions = message.changes.map((change) => fileChangeAction(change));
    const first = actions[0];
    const hasMixed = actions.some((action) => action !== first);
    if (hasMixed || !first) return "Changed";
    return fileChangeActionLabel(first);
  }, [message.changes, message.status]);
  const title = isExpanded ? `${actionLabel} file` : `${actionLabel} ${collapsedFileLabel}`;
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
  const headerToneClass = isExpanded
    ? HEADER_EXPANDED_TONE_CLASS
    : HEADER_COLLAPSED_TONE_CLASS;

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandableEntryContainer
          isExpanded={isExpanded}
          summaryContent={collapsedSummaryContent}
          summaryContentClassName={isExpanded ? HEADER_TEXT_CLASS : "min-w-0"}
          headerToneClass={headerToneClass}
          onToggle={() => setIsExpanded((prev) => !prev)}
        >
          <div className="font-mono text-[12px] text-foreground/90">
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
                        <Badge variant="outline" className="h-4 rounded px-1 text-[9px]">
                          {actionChip}
                        </Badge>
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90"
                          title={change.path}
                        >
                          {fileName}
                        </span>
                        <span className="shrink-0 font-mono text-[12px]">
                          <span className="text-emerald-600">+{stats.added}</span>{" "}
                          <span className="text-destructive/80">-{stats.removed}</span>
                        </span>
                      </div>
                      <div className="break-all px-3 pb-1 pt-0.5 font-mono text-[10px] text-muted-foreground/75">
                        {pathDetail}
                      </div>
                      <div className="max-h-[240px] overflow-auto border-t border-border/60 pb-1">
                        <div className="min-w-fit">
                          {visibleDiffLines.length > 0 ? (
                            visibleDiffLines.map((line, lineIndex) => (
                              <DiffLine key={`${change.path}:${lineIndex}`} line={line} />
                            ))
                          ) : (
                            <div className="px-3 py-2 font-mono text-[11px] text-muted-foreground/80">
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

function ErrorRow({ message }: { message: UIErrorMessage }) {
  return (
    <div className="group flex w-full items-center gap-2 rounded-md bg-destructive/5 px-3 py-1.5 text-xs">
      <CircleX className="size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-destructive/90">
        {message.message}
      </p>
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
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
            <span className="shrink-0">#{event.seq}</span>
            <span className="shrink-0">{message.rawType}</span>
            <Badge variant="outline" className="h-4 rounded px-1 text-[9px]">
              {message.reason}
            </Badge>
          </p>
        </button>
        {isExpanded ? (
          <div className="mt-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground/80">
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

  if (message.kind === "tool-call") {
    return <ToolCallRow message={message} />;
  }

  if (message.kind === "file-edit") {
    return <FileEditRow message={message} />;
  }

  if (message.kind === "operation") {
    return <OperationRow message={message} />;
  }

  if (message.kind === "error") {
    return <ErrorRow message={message} />;
  }

  if (message.kind === "debug/raw-event") {
    return <DebugEventRow message={message} />;
  }

  return null;
}

export const ConversationEntry = memo(ConversationEntryComponent);
ConversationEntry.displayName = "ConversationEntry";
