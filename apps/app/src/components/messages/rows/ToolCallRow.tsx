import { ExpandablePanel } from "@beanbag/ui-core";
import type { UIToolCallMessage } from "@beanbag/agent-core";
import {
  EventTitle,
  formatSummaryDuration,
  getEventHeaderToneClass,
  renderShimmeringSummary,
  useLatestInitialExpanded,
} from "./shared";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

export function ToolCallRow({
  message,
  initialExpanded = false,
}: {
  message: UIToolCallMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const command = message.command ?? message.toolName;
  const outputText = message.output && message.output.length > 0 ? message.output : "(no output)";
  const actionLabel =
    message.status === "error"
      ? "Failed"
      : message.status === "interrupted"
        ? "Declined"
        : message.status === "pending"
          ? "Running"
          : "Ran";
  const duration = formatSummaryDuration(message.durationMs);
  const isRunning = message.status === "pending";
  const tone = message.status === "error" ? "destructive" : "default";
  const summaryContent = renderShimmeringSummary(
    <EventTitle
      prefix={actionLabel}
      emphasis={command}
      suffix={duration}
      tone={tone}
    />,
    isRunning,
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
