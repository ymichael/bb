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
import { CommandRow, ToolCallRow } from "./rows/ToolCallRow.js";
import { UserMessageRow } from "./rows/UserMessageRow.js";
import { WebFetchRow, WebSearchRow } from "./rows/WebSearchRow.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineRenderOptions,
  ThreadTimelineTheme,
  UserAttachmentImageSrcResolver,
} from "./types.js";

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

function ConversationEntryComponent({
  message,
  onOpenLocalFileLink,
  projectId,
  initialExpanded = false,
  preferOngoingLabels = false,
  resolveUserAttachmentImageSrc,
  themeType,
}: ConversationEntryProps) {
  switch (message.kind) {
    case "user":
      return (
        <UserMessageRow
          message={message}
          projectId={projectId}
          resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        />
      );
    case "assistant-text":
      return (
        <AssistantMessageRow
          message={message}
          onOpenLocalFileLink={onOpenLocalFileLink}
        />
      );
    case "command":
      return (
        <CommandRow
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
        <WebSearchRow
          message={message}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "web-fetch":
      return (
        <WebFetchRow
          message={message}
          preferOngoingLabels={preferOngoingLabels}
        />
      );
    case "file-edit":
      return (
        <FileEditRow
          message={message}
          initialExpanded={initialExpanded}
          preferOngoingLabels={preferOngoingLabels}
          themeType={themeType}
        />
      );
    case "operation":
      return (
        <OperationRow message={message} initialExpanded={initialExpanded} />
      );
    case "permission-grant-lifecycle":
      return (
        <PermissionGrantLifecycleRow
          message={message}
          initialExpanded={initialExpanded}
        />
      );
    case "tasks":
      return <TasksRow message={message} initialExpanded={initialExpanded} />;
    case "delegation":
      return (
        <DelegationRow
          message={message}
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
      return <ErrorRow message={message} initialExpanded={initialExpanded} />;
    case "debug/raw-event":
      return <DebugEventRow message={message} />;
    default:
      return assertNever(message, "Unhandled conversation entry message kind");
  }
}

export const ConversationEntry = memo(ConversationEntryComponent);
ConversationEntry.displayName = "ConversationEntry";
