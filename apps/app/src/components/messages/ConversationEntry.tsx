import { memo } from "react";
import type { UIMessage } from "@beanbag/agent-core";
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
}

function ConversationEntryComponent({
  message,
  projectId,
  initialExpanded = false,
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
      />
    );
  }

  if (message.kind === "tool-call") {
    return (
      <ToolCallRow
        message={message}
        initialExpanded={initialExpanded}
      />
    );
  }

  if (message.kind === "web-search") {
    return <WebSearchRow message={message} />;
  }

  if (message.kind === "file-edit") {
    return (
      <FileEditRow
        message={message}
        initialExpanded={initialExpanded}
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
