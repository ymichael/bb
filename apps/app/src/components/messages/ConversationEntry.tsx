import { memo } from "react";
import { assertNever, type UIMessage } from "@beanbag/agent-core";
import { AssistantMessageRow } from "./rows/AssistantMessageRow";
import { DebugEventRow } from "./rows/DebugEventRow";
import { ErrorRow } from "./rows/ErrorRow";
import { FileEditRow } from "./rows/FileEditRow";
import { OperationRow } from "./rows/OperationRow";
import { ReasoningRow } from "./rows/ReasoningRow";
import { ToolCallRow } from "./rows/ToolCallRow";
import { ToolExploringRow } from "./rows/ToolExploringRow";
import { UserMessageRow } from "./rows/UserMessageRow";
import { WebSearchRow } from "./rows/WebSearchRow";

interface ConversationEntryProps {
  message: UIMessage;
  projectId?: string;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}

function ConversationEntryComponent({
  message,
  projectId,
  initialExpanded = false,
  preferOngoingLabels = false,
}: ConversationEntryProps) {
  switch (message.kind) {
    case "user":
      return <UserMessageRow message={message} projectId={projectId} />;
    case "assistant-reasoning":
      return <ReasoningRow message={message} />;
    case "assistant-text":
      return <AssistantMessageRow message={message} />;
    case "tool-exploring":
      return (
        <ToolExploringRow
          message={message}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "tool-call":
      return (
        <ToolCallRow
          message={message}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "web-search":
      return (
        <WebSearchRow message={message} preferOngoingLabels={preferOngoingLabels} />
      );
    case "file-edit":
      return (
        <FileEditRow
          message={message}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "operation":
      return <OperationRow message={message} initialExpanded={initialExpanded} />;
    case "error":
      return <ErrorRow message={message} initialExpanded={initialExpanded} />;
    case "debug/raw-event":
      return <DebugEventRow message={message} />;
    default:
      return assertNever(message, "Unhandled conversation entry message kind");
  }
}

export const ConversationEntry = memo(ConversationEntryComponent);
ConversationEntry.displayName = "ConversationEntry";
