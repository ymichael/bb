import { memo } from "react";
import { assertNever } from "@bb/core-ui";
import type { ViewMessage } from "@bb/domain";
import { AssistantMessageRow } from "./rows/AssistantMessageRow.js";
import { DelegationRow } from "./rows/DelegationRow.js";
import { DebugEventRow } from "./rows/DebugEventRow.js";
import { ErrorRow } from "./rows/ErrorRow.js";
import { FileEditRow } from "./rows/FileEditRow.js";
import {
  PermissionGrantLifecycleRow,
  OperationRow,
} from "./rows/OperationRow.js";
import { TasksRow } from "./rows/TasksRow.js";
import { ToolCallRow } from "./rows/ToolCallRow.js";
import { ToolExploringRow } from "./rows/ToolExploringRow.js";
import { UserMessageRow } from "./rows/UserMessageRow.js";
import { WebFetchRow, WebSearchRow } from "./rows/WebSearchRow.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineRenderOptions,
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";

type ConversationRenderableMessage = Exclude<
  ViewMessage,
  { kind: "assistant-reasoning" }
>;

interface ConversationEntryProps {
  initialExpanded?: boolean;
  message: ViewMessage;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  preferOngoingLabels?: boolean;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  themeType?: ThreadTimelineTheme;
}

interface NestedRenderOptions extends ThreadTimelineRenderOptions {
  preferOngoingLabels?: boolean;
}

function requireConversationRenderableMessage(
  message: ViewMessage,
): ConversationRenderableMessage {
  if (message.kind === "assistant-reasoning") {
    throw new Error(
      "assistant-reasoning messages must be filtered before ConversationEntry renders",
    );
  }

  return message;
}

function ConversationEntryComponent({
  message,
  onOpenLocalFileLink,
  projectId,
  initialExpanded = false,
  preferOngoingLabels = false,
  resolveUserAttachmentImageSrc,
  themeType,
}: ConversationEntryProps) {
  const renderableMessage = requireConversationRenderableMessage(message);

  switch (renderableMessage.kind) {
    case "user":
      return (
        <UserMessageRow
          message={renderableMessage}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        />
      );
    case "assistant-text":
      return (
        <AssistantMessageRow
          message={renderableMessage}
          onOpenLocalFileLink={onOpenLocalFileLink}
        />
      );
    case "tool-exploring":
      return (
        <ToolExploringRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "tool-call":
      return (
        <ToolCallRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "web-search":
      return (
        <WebSearchRow
          message={renderableMessage}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "web-fetch":
      return (
        <WebFetchRow
          message={renderableMessage}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "file-edit":
      return (
        <FileEditRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
          themeType={themeType}
        />
      );
    case "operation":
      return (
        <OperationRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
        />
      );
    case "permission-grant-lifecycle":
      return (
        <PermissionGrantLifecycleRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
        />
      );
    case "tasks":
      return (
        <TasksRow message={renderableMessage} initialExpanded={initialExpanded} />
      );
    case "delegation":
      return (
        <DelegationRow
          message={renderableMessage}
          initialExpanded={initialExpanded}
          onOpenLocalFileLink={onOpenLocalFileLink}
          preferOngoingLabels={preferOngoingLabels}
          renderMessage={(
            nestedMessage: ViewMessage,
            nestedOptions?: NestedRenderOptions,
          ) => (
            <ConversationEntry
              message={nestedMessage}
              projectId={projectId}
              initialExpanded={nestedOptions?.initialExpanded}
              onOpenLocalFileLink={onOpenLocalFileLink}
              preferOngoingLabels={nestedOptions?.preferOngoingLabels}
              resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
              themeType={themeType}
            />
          )}
        />
      );
    case "error":
      return (
        <ErrorRow message={renderableMessage} initialExpanded={initialExpanded} />
      );
    case "debug/raw-event":
      return <DebugEventRow message={renderableMessage} />;
    default:
      return assertNever(
        renderableMessage,
        "Unhandled conversation entry message kind",
      );
  }
}

export const ConversationEntry = memo(ConversationEntryComponent);
ConversationEntry.displayName = "ConversationEntry";
