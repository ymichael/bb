import { ExpandablePanel, getCollapsibleHeaderToneClass } from "@beanbag/ui-core";
import type { UIToolCallMessage } from "@beanbag/agent-core";
import {
  renderShimmeringSummary,
  useLatestInitialExpanded,
} from "./shared";
import { TerminalOutputBlock } from "./TerminalOutputBlock";

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
