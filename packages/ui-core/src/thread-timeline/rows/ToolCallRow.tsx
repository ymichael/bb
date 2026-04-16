import { useEffect, useState } from "react";
import { isShellToolName } from "@bb/core-ui";
import type { ViewToolCallMessage } from "@bb/domain";
import { ExpandablePanel } from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./shared.js";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";

interface ToolCallRowProps {
  message: ViewToolCallMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

function getToolCallTone(message: ViewToolCallMessage): "default" | "destructive" {
  // Shell command rows are common, and failed commands should read like regular
  // command history rather than error alerts. Keep destructive tone for any future
  // non-shell tool rows that may still need stronger emphasis.
  if (isShellToolName(message.toolName)) return "default";
  return message.status === "error" ? "destructive" : "default";
}

function toolCallActionLabel(
  message: ViewToolCallMessage,
  preferRunningLabel: boolean,
): string {
  if (message.approvalStatus === "waiting_for_approval") {
    return "Waiting for approval to run";
  }
  if (message.approvalStatus === "denied") {
    return "Permission denied:";
  }
  if (message.status === "error") return "Failed";
  if (message.status === "interrupted") return "Interrupted";
  if (message.status === "pending" || preferRunningLabel) return "Running";
  return "Ran";
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
  message: ViewToolCallMessage,
  now: number | undefined,
): number | undefined {
  if (message.startedAt === undefined) return undefined;
  if (now === undefined) return undefined;
  return Math.max(0, now - message.startedAt);
}

function getSummaryDurationMs(
  message: ViewToolCallMessage,
  preferRunningLabel: boolean,
  liveNow: number | undefined,
): number | undefined {
  if (message.status === "pending") {
    return message.durationMs ?? getElapsedDurationMs(message, liveNow);
  }
  if (preferRunningLabel) {
    return message.durationMs ?? getElapsedDurationMs(message, undefined);
  }
  return message.durationMs;
}

function formatExitCodeLine(message: ViewToolCallMessage): string | undefined {
  if (message.exitCode === undefined || message.exitCode === 0) return undefined;
  return `exit code ${message.exitCode}`;
}

function formatOutputText(message: ViewToolCallMessage): string {
  const output = message.output && message.output.length > 0 ? message.output : undefined;
  const exitCodeLine = formatExitCodeLine(message);

  if (output && exitCodeLine) {
    const trimmedOutput = output.trimEnd();
    return trimmedOutput.length > 0
      ? `${trimmedOutput}\n\n${exitCodeLine}`
      : exitCodeLine;
  }
  if (output) return output;
  return exitCodeLine ?? "(no output)";
}

export function ToolCallRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: ToolCallRowProps) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const command = message.command ?? message.toolName;
  const titleDetail =
    isExpanded && isShellToolName(message.toolName) ? "command" : command;
  const outputText = formatOutputText(message);
  const preferRunningLabel = preferOngoingLabels && message.status === "completed";
  const actionLabel = toolCallActionLabel(message, preferRunningLabel);
  const isRunning =
    message.approvalStatus !== "denied" &&
    (message.status === "pending" || preferRunningLabel);
  const liveNow = useLiveNow(isRunning && message.status === "pending");
  const duration = formatSummaryDuration(
    getSummaryDurationMs(message, preferRunningLabel, liveNow),
  );
  const tone = getToolCallTone(message);
  const summaryContent = (
    <EventTitle
      prefix={actionLabel}
      detail={titleDetail}
      suffix={duration}
      tone={tone}
      shimmerPrefix={isRunning}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded, tone);

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <TerminalOutputBlock
            command={command}
            outputText={outputText}
            isExpanded={isExpanded}
          />
        </ExpandablePanel>
      </div>
    </div>
  );
}
