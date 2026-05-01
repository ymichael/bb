import { useEffect, useState } from "react";
import {
  formatCommandOutputText,
  formatToolCallCommand,
  getTimelineDisplayStatus,
  getTimelineDisplayStatusInfo,
} from "@bb/core-ui";
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
  preferOngoingLabels?: boolean;
}

interface CommandRowProps {
  message: ViewCommandMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

interface ExecutionRowProps {
  approvalStatus: ExecutionMessage["approvalStatus"];
  exitCode: number | null;
  getTitleDetail: (isExpanded: boolean) => string;
  initialExpanded: boolean;
  displayText: string;
  message: ExecutionMessage;
  preferOngoingLabels: boolean;
  tone: "default" | "destructive";
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
  preferRunningLabel: boolean,
  liveNow: number | undefined,
): number | undefined {
  if (message.status === "pending") {
    return message.durationMs ?? getElapsedDurationMs(message, liveNow);
  }
  if (preferRunningLabel) {
    return message.durationMs ?? getElapsedDurationMs(message, undefined);
  }
  return message.durationMs ?? undefined;
}

function ExecutionRow({
  approvalStatus,
  exitCode,
  displayText,
  getTitleDetail,
  message,
  initialExpanded,
  preferOngoingLabels,
  tone,
}: ExecutionRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const titleDetail = getTitleDetail(isExpanded);
  const preferRunningLabel =
    preferOngoingLabels && message.status === "completed";
  const displayStatus = getTimelineDisplayStatus({
    approvalStatus,
    preferRunningLabel,
    status: message.status,
  });
  const outputText = formatCommandOutputText({
    displayStatus,
    exitCode,
    output: message.output,
  });
  const actionLabel = getTimelineDisplayStatusInfo(displayStatus).reactLabel;
  const isVisuallyActive =
    message.status === "pending" && approvalStatus !== "denied";
  const isRunning = displayStatus === "running";
  const liveNow = useLiveNow(isRunning && message.status === "pending");
  const duration = formatSummaryDuration(
    getSummaryDurationMs(message, preferRunningLabel, liveNow),
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
  preferOngoingLabels = false,
}: CommandRowProps) {
  const command = message.command;
  return (
    <ExecutionRow
      approvalStatus={message.approvalStatus}
      exitCode={message.exitCode}
      displayText={command}
      getTitleDetail={(isExpanded) => (isExpanded ? "command" : command)}
      initialExpanded={initialExpanded}
      message={message}
      preferOngoingLabels={preferOngoingLabels}
      tone="default"
    />
  );
}

export function ToolCallRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: ToolCallRowProps) {
  const displayText = formatToolCallCommand(message.toolName, message.toolArgs);
  return (
    <ExecutionRow
      approvalStatus={message.approvalStatus}
      exitCode={null}
      displayText={displayText}
      getTitleDetail={() => displayText}
      initialExpanded={initialExpanded}
      message={message}
      preferOngoingLabels={preferOngoingLabels}
      tone={message.status === "error" ? "destructive" : "default"}
    />
  );
}
