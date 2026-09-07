import { useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  TimelineConversationAttachments,
  TimelineRowBase,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import type { PromptTextMention, ThreadOriginKind } from "@bb/domain";
import { fileNameFromPath } from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  MarkdownPreview,
  type MarkdownThreadMentions,
} from "../../ui/markdown-preview.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import {
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
} from "@/components/ui/markdown-local-file-link.js";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { computeMutedPrefixLength } from "@bb/client-core";
import type {
  TimelineTitleActionResolver,
  TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import {
  ConversationAttachments,
  buildAttachmentItems,
  type ConversationAttachmentItems,
} from "./ConversationAttachments.js";
import {
  GeneratedConversationMessage,
  generatedConversationBodySlice,
} from "./GeneratedConversationMessage.js";
import {
  clipMentionTextToVisibleRange,
  shiftMentionsToTextRange,
} from "./ConversationMessageMentions.js";
import type { MarkdownPromptMentions } from "@/components/ui/markdown-prompt-mentions.js";
import {
  useMessageDirectiveRegistry,
  type MarkdownMessageDirectives,
} from "@/components/ui/markdown-message-directives.js";
import {
  boundedMarkdownPreview,
  closeUnterminatedMarkdownCodeSpan,
  USER_MESSAGE_CHAR_CAP,
} from "@bb/client-core";
import { turnRequestLabel } from "@bb/client-core";
import { splitStreamingMarkdown } from "./streaming-markdown-split.js";
import { TurnRequestLabel } from "./TurnRequestLabel.js";
import {
  MessageActionBar,
  PROSE_COLUMN_INSET_CLASS,
} from "./MessageActionBar.js";
import {
  ConversationMessageOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow.js";
import {
  SelectableMessageProse,
  type MessageProseSelection,
} from "./SelectableMessageProse.js";
import type { ThreadTimelinePluginMessageAction } from "./types.js";
import type { PromptDraftAttachment } from "@bb/client-core";
import { buildThreadHostFileContentUrl } from "@/lib/file-content-urls";

interface ConversationMessageContentBaseProps {
  attachments: TimelineConversationAttachments | null;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: MarkdownMessageDirectives["openThreadPanel"];
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  text: string;
}

interface ConversationMessageContentUserProps extends ConversationMessageContentBaseProps {
  role: "user";
  mobileActionDisplay?: "inline" | "overflow";
  originKind: ThreadOriginKind | null;
  initiator: TimelineUserConversationRow["initiator"];
  mentions: readonly PromptTextMention[];
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onEdit?: () => void;
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
  onOpenLink?: ThreadTimelineLinkHandler;
  onTitleAction?: TimelineTitleActionResolver;
  senderThreadId: TimelineUserConversationRow["senderThreadId"];
  senderThreadProjectId?: string;
  senderThreadTitle: string | null;
  senderIsPluginSideChat: boolean;
  systemMessageKind: TimelineUserConversationRow["systemMessageKind"];
  systemMessageSubject: TimelineUserConversationRow["systemMessageSubject"];
  turnRequest: TimelineUserConversationRow["turnRequest"];
}

type AssistantMessageRowIdentity = Pick<
  TimelineRowBase,
  "id" | "threadId" | "turnId"
>;

const COLLAPSED_MESSAGE_FADE_STYLE: CSSProperties = {
  maskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
};

const ASSISTANT_THREAD_MENTIONS: MarkdownThreadMentions = {
  mentions: [],
  preserveSoftBreaks: false,
};

const STREAMING_SETTLED_MARKDOWN_CLASS_NAME = "[&>p:last-child]:mb-2";
const STREAMING_TAIL_MARKDOWN_CLASS_NAME =
  "[&>h1:first-child]:mt-4 [&>h2:first-child]:mt-4 [&>h3:first-child]:mt-3 [&>h4:first-child]:mt-3 [&>h5:first-child]:mt-2 [&>h6:first-child]:mt-2";

interface ConversationMessageContentAssistantProps
  extends ConversationMessageContentBaseProps, AssistantMessageRowIdentity {
  role: "assistant";
  onOpenLink?: ThreadTimelineLinkHandler;
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onFork?: () => void;
  onSendToMain?: () => void;
  forkDisabled?: boolean;
  onSelectProse?: (selection: MessageProseSelection | null) => void;
  showActions: boolean;
  mobileActionDisplay: "inline" | "overflow";
  streaming: boolean;
  workspaceRootPath?: string;
}

type ConversationMessageContentProps =
  | ConversationMessageContentUserProps
  | ConversationMessageContentAssistantProps;

interface UserConversationMessageProps {
  addToChatAttachments: readonly PromptDraftAttachment[];
  attachmentItems: ConversationAttachmentItems;
  originKind: ThreadOriginKind | null;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  initiator: TimelineUserConversationRow["initiator"];
  mentions: readonly PromptTextMention[];
  mobileActionDisplay: "inline" | "overflow";
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onEdit?: () => void;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
  onTitleAction?: TimelineTitleActionResolver;
  senderThreadId: TimelineUserConversationRow["senderThreadId"];
  senderThreadProjectId: string | null;
  senderThreadTitle: string | null;
  senderIsPluginSideChat: boolean;
  systemMessageKind: TimelineUserConversationRow["systemMessageKind"];
  systemMessageSubject: TimelineUserConversationRow["systemMessageSubject"];
  text: string;
  turnRequest: TimelineUserConversationRow["turnRequest"];
}

interface AssistantConversationMessageProps extends AssistantMessageRowIdentity {
  addToChatAttachments: readonly PromptDraftAttachment[];
  attachmentItems: ConversationAttachmentItems;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onFork?: () => void;
  onSendToMain?: () => void;
  forkDisabled?: boolean;
  onSelectProse?: (selection: MessageProseSelection | null) => void;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: MarkdownMessageDirectives["openThreadPanel"];
  projectId?: string;
  showActions: boolean;
  mobileActionDisplay: "inline" | "overflow";
  streaming: boolean;
  text: string;
  workspaceRootPath?: string;
}

interface CollapsibleMessageTextProps {
  mentions: readonly PromptTextMention[];
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
  onOpenLink?: ThreadTimelineLinkHandler;
  text: string;
  mutePrefixLength?: number;
}

function CollapsibleMessageText({
  mentions,
  resolveMentionLink,
  resolveSegmentLinkHref,
  onOpenLink,
  text,
  mutePrefixLength,
}: CollapsibleMessageTextProps) {
  const showMutedPrefix =
    typeof mutePrefixLength === "number" &&
    mutePrefixLength > 0 &&
    mutePrefixLength < text.length;
  const prefixText = showMutedPrefix ? text.slice(0, mutePrefixLength) : null;
  const bodyText = showMutedPrefix ? text.slice(mutePrefixLength) : text;
  const bodyOffset = showMutedPrefix ? mutePrefixLength : 0;

  const [isExpanded, setIsExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const exceedsCollapsedRenderCap = bodyText.length > USER_MESSAGE_CHAR_CAP;
  const collapsedPreview =
    !isExpanded && exceedsCollapsedRenderCap
      ? boundedMarkdownPreview(bodyText, USER_MESSAGE_CHAR_CAP)
      : null;
  const renderedBodyText = collapsedPreview?.text ?? bodyText;
  const body = useMemo(
    () =>
      clipMentionTextToVisibleRange({
        mentions,
        rangeStart: bodyOffset,
        text: renderedBodyText,
      }),
    [mentions, bodyOffset, renderedBodyText],
  );
  const promptMentions = useMemo<MarkdownPromptMentions>(
    () => ({
      mentions: body.mentions,
      resolveLinkHref: resolveSegmentLinkHref,
      resolveMentionLink,
    }),
    [body.mentions, resolveSegmentLinkHref, resolveMentionLink],
  );
  const rawThreadMentions = useMemo<MarkdownThreadMentions>(
    () => ({
      mentions: body.mentions,
      preserveSoftBreaks: true,
    }),
    [body.mentions],
  );
  const linkRouting = useMemo<MarkdownLinkRouting | undefined>(
    () => (onOpenLink ? { onOpenLink } : undefined),
    [onOpenLink],
  );

  const isOverflowing = useIsOverflowing({
    elementRef: bodyRef,
    enabled: !isExpanded,
    measurementKey: body.text,
  });
  const showToggle = isExpanded || exceedsCollapsedRenderCap || isOverflowing;

  return (
    <>
      {prefixText !== null ? (
        <span
          className="line-clamp-1 text-muted-foreground"
          title={prefixText.trimEnd()}
        >
          {prefixText}
        </span>
      ) : null}
      <div
        ref={bodyRef}
        className={cn(
          "break-words",
          !isExpanded && "max-h-[15lh] overflow-hidden",
        )}
        style={
          !isExpanded && showToggle ? COLLAPSED_MESSAGE_FADE_STYLE : undefined
        }
      >
        {collapsedPreview?.parseAsMarkdown === false ? (
          <span>{body.text}</span>
        ) : (
          <MarkdownPreview
            content={
              collapsedPreview?.wasCapped === true
                ? closeUnterminatedMarkdownCodeSpan(body.text)
                : body.text
            }
            promptMentions={promptMentions}
            threadMentions={rawThreadMentions}
            linkRouting={linkRouting}
          />
        )}
      </div>
      {showToggle ? (
        <ConversationMessageOverflowToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded((prev) => !prev)}
        />
      ) : null}
    </>
  );
}

function buildAddToChatAttachments(
  attachments: TimelineConversationAttachments | null,
): PromptDraftAttachment[] {
  if (!attachments) {
    return [];
  }

  return [
    ...attachments.localImagePaths.map((path) => ({
      type: "localImage" as const,
      path,
      name: fileNameFromPath(path),
      sizeBytes: 0,
    })),
    ...attachments.localFilePaths.map((path) => ({
      type: "localFile" as const,
      path,
      name: fileNameFromPath(path),
      sizeBytes: 0,
    })),
  ];
}

function UserConversationMessage({
  addToChatAttachments,
  attachmentItems,
  originKind,
  initiator,
  mentions,
  mobileActionDisplay,
  onAddToChat,
  onEdit,
  onOpenLink,
  onOpenLocalFileLink,
  pluginActions = [],
  projectId,
  resolveMentionLink,
  resolveSegmentLinkHref,
  onTitleAction,
  senderThreadId,
  senderThreadProjectId,
  senderThreadTitle,
  senderIsPluginSideChat,
  systemMessageKind,
  systemMessageSubject,
  text,
  turnRequest,
}: UserConversationMessageProps) {
  if (initiator === "agent" && senderThreadId !== null) {
    const body = generatedConversationBodySlice({ initiator, text });
    const bodyMentions = shiftMentionsToTextRange({
      mentions,
      rangeStart: body.startOffset,
      rangeEnd: body.startOffset + body.text.length,
    });
    return (
      <GeneratedConversationMessage
        attachmentItems={attachmentItems}
        originKind={originKind}
        mentions={bodyMentions}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        resolveSegmentLinkHref={resolveSegmentLinkHref}
        onTitleAction={onTitleAction}
        sourceKind="agent"
        sourceName={
          senderIsPluginSideChat ? "side chat" : (senderThreadTitle ?? "Agent")
        }
        sourceProjectId={senderThreadProjectId}
        sourceThreadId={senderThreadId}
        sourceIsPluginSideChat={senderIsPluginSideChat}
        systemMessageKind={systemMessageKind}
        systemMessageSubject={systemMessageSubject}
        text={body.text}
        turnRequest={turnRequest}
      />
    );
  }

  if (initiator === "system") {
    const body = generatedConversationBodySlice({ initiator, text });
    const bodyMentions = shiftMentionsToTextRange({
      mentions,
      rangeStart: body.startOffset,
      rangeEnd: body.startOffset + body.text.length,
    });
    return (
      <GeneratedConversationMessage
        attachmentItems={attachmentItems}
        originKind={null}
        mentions={bodyMentions}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        resolveSegmentLinkHref={resolveSegmentLinkHref}
        onTitleAction={onTitleAction}
        sourceKind="system"
        sourceName="BB"
        sourceProjectId={null}
        sourceThreadId={null}
        sourceIsPluginSideChat={false}
        systemMessageKind={systemMessageKind}
        systemMessageSubject={systemMessageSubject}
        text={body.text}
        turnRequest={turnRequest}
      />
    );
  }

  const mutePrefixLength = computeMutedPrefixLength(initiator, text);
  const messageText = text.trim();
  const requestLabel = turnRequestLabel(turnRequest);

  return (
    <div className="w-full" data-message-column="">
      <div className="group/message ml-auto flex w-fit max-w-[70%] flex-col items-end">
        {requestLabel ? (
          <div className="mb-1 flex items-center justify-end gap-2">
            <TurnRequestLabel
              turnRequest={turnRequest}
              icon="ArrowTurnForward"
            />
          </div>
        ) : null}
        {}
        <div className="flex w-fit max-w-full flex-col items-end">
          <div className="max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground">
            {messageText ? (
              <CollapsibleMessageText
                mentions={mentions}
                resolveMentionLink={resolveMentionLink}
                resolveSegmentLinkHref={resolveSegmentLinkHref}
                onOpenLink={onOpenLink}
                text={text}
                mutePrefixLength={mutePrefixLength || undefined}
              />
            ) : (
              <p className="text-muted-foreground">Sent attachments</p>
            )}
            <ConversationAttachments
              align="end"
              filePaths={attachmentItems.filePaths}
              imageItems={attachmentItems.imageItems}
              onOpenLocalFileLink={onOpenLocalFileLink}
              projectId={projectId}
            />
          </div>
          {}
          <MessageActionBar
            messageText={messageText}
            alignment="end"
            mobileActionDisplay={mobileActionDisplay}
            addToChatAttachments={addToChatAttachments}
            copyImageUrl={attachmentItems.imageItems[0]?.src}
            onAddToChat={onAddToChat}
            onEdit={onEdit}
            pluginActions={pluginActions}
          />
        </div>
      </div>
    </div>
  );
}

function AssistantConversationMessage({
  addToChatAttachments,
  attachmentItems,
  id,
  onAddToChat,
  onFork,
  onSendToMain,
  forkDisabled,
  onSelectProse,
  onOpenLink,
  onOpenLocalFileLink,
  onOpenPluginPanel,
  pluginActions,
  projectId,
  showActions,
  mobileActionDisplay,
  streaming,
  text,
  threadId,
  turnId,
  workspaceRootPath,
}: AssistantConversationMessageProps) {
  const streamingSplit = useMemo(
    () => (streaming ? splitStreamingMarkdown(text) : null),
    [streaming, text],
  );
  const linkRouting = useMemo<MarkdownLinkRouting>(() => {
    const localImage: NonNullable<MarkdownLinkRouting["localImage"]> = {
      absolutePaths: {
        kind: "trusted-host",
      },
      resolveSrc: ({ path }) => buildThreadHostFileContentUrl(threadId, path),
    };
    const routing: MarkdownLinkRouting = {
      localImage,
    };
    if (workspaceRootPath !== undefined) {
      localImage.relativePaths = {
        baseDir: workspaceRootPath,
        rootPath: workspaceRootPath,
      };
    }
    if (onOpenLink) {
      routing.onOpenLink = onOpenLink;
    }
    if (onOpenLocalFileLink) {
      routing.localFile = {
        absoluteLinks: {
          kind: "trusted-host",
        },
        onOpenLink: onOpenLocalFileLink,
      };
      if (workspaceRootPath !== undefined) {
        routing.localFile.relativeLinks = {
          baseDir: workspaceRootPath,
          rootPath: workspaceRootPath,
        };
      }
    }
    return routing;
  }, [onOpenLink, onOpenLocalFileLink, threadId, workspaceRootPath]);

  const messageDirectiveRegistry = useMessageDirectiveRegistry();
  const openDirectiveWorkspaceFile = useMemo<
    MarkdownMessageDirectives["openWorkspaceFile"]
  >(() => {
    if (onOpenLocalFileLink === undefined || workspaceRootPath === undefined) {
      return null;
    }

    return (path) => {
      const href = resolveRelativeLocalFileHref({
        baseDir: workspaceRootPath,
        href: path,
        rootPath: workspaceRootPath,
      });
      if (href === null) {
        return false;
      }
      const link = parseLocalFileHref({
        absoluteLinks: { kind: "contained", rootPath: workspaceRootPath },
        href,
      });
      return link === null ? false : onOpenLocalFileLink(link);
    };
  }, [onOpenLocalFileLink, workspaceRootPath]);
  const messageDirectives = useMemo<
    MarkdownMessageDirectives | undefined
  >(() => {
    if (
      messageDirectiveRegistry === null ||
      messageDirectiveRegistry.size === 0
    ) {
      return undefined;
    }
    return {
      registry: messageDirectiveRegistry,
      message: {
        id,
        threadId,
        turnId,
        projectId: projectId ?? null,
      },
      openWorkspaceFile: openDirectiveWorkspaceFile,
      openThreadPanel: onOpenPluginPanel ?? null,
    };
  }, [
    messageDirectiveRegistry,
    id,
    threadId,
    turnId,
    projectId,
    openDirectiveWorkspaceFile,
    onOpenPluginPanel,
  ]);

  return (
    <div
      className={cn(
        "group/message w-full text-sm font-normal leading-relaxed",
        PROSE_COLUMN_INSET_CLASS,
      )}
      data-message-column=""
    >
      {}
      <SelectableMessageProse onSelect={onSelectProse}>
        <MarkdownPreview
          className={
            streamingSplit === null
              ? undefined
              : STREAMING_SETTLED_MARKDOWN_CLASS_NAME
          }
          content={streamingSplit === null ? text : streamingSplit.settled}
          linkRouting={linkRouting}
          messageDirectives={messageDirectives}
          threadMentions={ASSISTANT_THREAD_MENTIONS}
        />
        {streamingSplit === null ? null : (
          <MarkdownPreview
            className={STREAMING_TAIL_MARKDOWN_CLASS_NAME}
            content={streamingSplit.tail}
            linkRouting={linkRouting}
            messageDirectives={messageDirectives}
            threadMentions={ASSISTANT_THREAD_MENTIONS}
          />
        )}
      </SelectableMessageProse>
      <ConversationAttachments
        filePaths={attachmentItems.filePaths}
        imageItems={attachmentItems.imageItems}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
      />
      {showActions ? (
        <MessageActionBar
          messageText={text}
          alignment="start"
          mobileActionDisplay={mobileActionDisplay}
          addToChatAttachments={addToChatAttachments}
          copyImageUrl={attachmentItems.imageItems[0]?.src}
          onAddToChat={onAddToChat}
          onFork={onFork}
          onSendToMain={onSendToMain}
          disabled={forkDisabled}
          pluginActions={pluginActions}
        />
      ) : null}
    </div>
  );
}

export function ConversationMessageContent(
  props: ConversationMessageContentProps,
) {
  const {
    attachments,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    projectId,
    resolveUserAttachmentImageSrc,
    text,
  } = props;
  const attachmentItems = useMemo(
    () =>
      buildAttachmentItems({
        attachments,
        projectId,
        resolveUserAttachmentImageSrc,
      }),
    [attachments, projectId, resolveUserAttachmentImageSrc],
  );
  const addToChatAttachments = useMemo(
    () => buildAddToChatAttachments(attachments),
    [attachments],
  );

  if (props.role === "user") {
    return (
      <UserConversationMessage
        addToChatAttachments={addToChatAttachments}
        attachmentItems={attachmentItems}
        originKind={props.originKind}
        pluginActions={props.pluginActions}
        initiator={props.initiator}
        mentions={props.mentions}
        mobileActionDisplay={props.mobileActionDisplay ?? "overflow"}
        onAddToChat={props.onAddToChat}
        onEdit={props.onEdit}
        onOpenLink={props.onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={props.resolveMentionLink}
        resolveSegmentLinkHref={props.resolveSegmentLinkHref}
        onTitleAction={props.onTitleAction}
        senderThreadId={props.senderThreadId}
        senderThreadProjectId={props.senderThreadProjectId ?? null}
        senderThreadTitle={props.senderThreadTitle}
        senderIsPluginSideChat={props.senderIsPluginSideChat}
        systemMessageKind={props.systemMessageKind}
        systemMessageSubject={props.systemMessageSubject}
        text={text}
        turnRequest={props.turnRequest}
      />
    );
  }

  return (
    <AssistantConversationMessage
      addToChatAttachments={addToChatAttachments}
      attachmentItems={attachmentItems}
      id={props.id}
      pluginActions={props.pluginActions}
      onAddToChat={props.onAddToChat}
      onFork={props.onFork}
      onSendToMain={props.onSendToMain}
      forkDisabled={props.forkDisabled}
      onSelectProse={props.onSelectProse}
      onOpenLink={props.onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onOpenPluginPanel={onOpenPluginPanel}
      projectId={projectId}
      showActions={props.showActions}
      mobileActionDisplay={props.mobileActionDisplay}
      streaming={props.streaming}
      text={text}
      threadId={props.threadId}
      turnId={props.turnId}
      workspaceRootPath={props.workspaceRootPath}
    />
  );
}
