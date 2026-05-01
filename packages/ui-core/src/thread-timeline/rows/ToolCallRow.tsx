import { useEffect, useState } from "react";
import {
  formatCommandOutputText,
  getThreadTimelineRowTitle,
  getTimelineDisplayStatus,
  type ThreadTimelineRowTitle,
} from "@bb/thread-view";
import type { ViewCommandMessage, ViewToolCallMessage } from "@bb/domain";
import { ExpandablePanel } from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./shared.js";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";

type ExecutionMessage = ViewCommandMessage | ViewToolCallMessage;

interface ToolCallRowProps {
  message: ViewToolCallMessage;
  initialExpanded?: boolean;
}

interface CommandRowProps {
  message: ViewCommandMessage;
  initialExpanded?: boolean;
}

interface ExecutionRowProps {
  approvalStatus: ExecutionMessage["approvalStatus"];
  exitCode: number | null;
  initialExpanded: boolean;
  displayText: string;
  message: ExecutionMessage;
  title: ThreadTimelineRowTitle;
  tone: "default" | "destructive";
}

interface ExecutionTitleDetailArgs {
  isExpanded: boolean;
  message: ExecutionMessage;
  title: ThreadTimelineRowTitle;
}

function useLiveNow(enabled: boolean): number | undefined {
  const [now, setNow] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setNow(undefined);
      return;
    }

    setNow(Date.now());
    const intervalId = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [enabled]);

  return now;
}

function getElapsedDurationMs(
  message: ExecutionMessage,
  now: number | undefined,
): number | undefined {
  if (message.startedAt === undefined) return undefined;
  if (now === undefined) return undefined;
  return Math.max(0, now - message.startedAt);
}

function getSummaryDurationMs(
  message: ExecutionMessage,
  liveNow: number | undefined,
): number | undefined {
  if (message.status === "pending") {
    return message.durationMs ?? getElapsedDurationMs(message, liveNow);
  }
  return message.durationMs ?? undefined;
}

function executionTitleContent(title: ThreadTimelineRowTitle): string {
  switch (title.rich.kind) {
    case "plain":
      return title.rich.text;
    case "prefixed":
      return title.rich.content;
  }
}

function executionTitlePrefix(title: ThreadTimelineRowTitle): string {
  switch (title.rich.kind) {
    case "plain":
      return title.rich.text;
    case "prefixed":
      return title.rich.prefix;
  }
}

function executionTitleDetail({
  isExpanded,
  message,
  title,
}: ExecutionTitleDetailArgs): string {
  if (message.kind === "command" && isExpanded) {
    return "command";
  }
  return executionTitleContent(title);
}

function getExecutionRowTitle(
  message: ExecutionMessage,
): ThreadTimelineRowTitle {
  return getThreadTimelineRowTitle(
    {
      kind: "message",
      id: message.id,
      message,
    },
    {
      preferOngoingLabels: false,
    },
  );
}

function ExecutionRow({
  approvalStatus,
  exitCode,
  displayText,
  message,
  initialExpanded,
  title,
  tone,
}: ExecutionRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const titleDetail = executionTitleDetail({
    isExpanded,
    message,
    title,
  });
  const displayStatus = getTimelineDisplayStatus({
    approvalStatus,
    status: message.status,
  });
  const outputText = formatCommandOutputText({
    displayStatus,
    exitCode,
    output: message.output,
  });
  const actionLabel = executionTitlePrefix(title);
  const isVisuallyActive =
    message.status === "pending" && approvalStatus !== "denied";
  const isRunning = displayStatus === "running";
  const liveNow = useLiveNow(isRunning && message.status === "pending");
  const duration = formatSummaryDuration(
    getSummaryDurationMs(message, liveNow),
  );
  const summaryContent = (
    <EventTitle
      prefix={actionLabel}
      detail={titleDetail}
      suffix={duration}
      tone={tone}
      shimmerPrefix={isVisuallyActive}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded, tone);

  return (
    <div className="group w-full">
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <TerminalOutputBlock
            command={displayText}
            outputText={outputText}
            isExpanded={isExpanded}
          />
        </ExpandablePanel>
      </div>
    </div>
  );
}

export function CommandRow({
  message,
  initialExpanded = false,
}: CommandRowProps) {
  const command = message.command;
  const title = getExecutionRowTitle(message);
  return (
    <ExecutionRow
      approvalStatus={message.approvalStatus}
      exitCode={message.exitCode}
      displayText={command}
      initialExpanded={initialExpanded}
      message={message}
      title={title}
      tone="default"
    />
  );
}

export function ToolCallRow({
  message,
  initialExpanded = false,
}: ToolCallRowProps) {
  const title = getExecutionRowTitle(message);
  const displayText = executionTitleContent(title);
  return (
    <ExecutionRow
      approvalStatus={message.approvalStatus}
      exitCode={null}
      displayText={displayText}
      initialExpanded={initialExpanded}
      message={message}
      title={title}
      tone={message.status === "error" ? "destructive" : "default"}
    />
  );
}
