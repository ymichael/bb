import { ExpandablePanel } from "@bb/ui-core";
import type { UIToolCallMessage } from "@bb/domain";
import { useLatestInitialExpanded } from "@/lib/latestInitialExpanded";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
} from "./shared";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

function getToolCallTone(message: UIToolCallMessage): "default" | "destructive" {
  // Shell command rows are common, and failed commands should read like regular
  // command history rather than error alerts. Keep destructive tone for any future
  // non-shell tool rows that may still need stronger emphasis.
  if (message.toolName === "exec_command") return "default";
  return message.status === "error" ? "destructive" : "default";
}

export function ToolCallRow({
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
  const preferRunningLabel = preferOngoingLabels && message.status === "completed";
  const actionLabel =
    message.status === "error"
      ? "Failed"
      : message.status === "interrupted"
        ? "Declined"
        : message.status === "pending" || preferRunningLabel
          ? "Running"
          : "Ran";
  const duration = formatSummaryDuration(message.durationMs);
  const isRunning = message.status === "pending" || preferRunningLabel;
  const tone = getToolCallTone(message);
  const summaryContent = (
    <EventTitle
      prefix={actionLabel}
      detail={command}
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
