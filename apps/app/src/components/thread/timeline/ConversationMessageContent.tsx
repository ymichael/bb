import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  TimelineConversationAttachments,
  TimelineConversationTurnRequest,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import { fileNameFromPath } from "@bb/thread-view";
import { ImageLightbox, getWrappedImageIndex } from "../../ui/image-lightbox.js";
import { CopyButton } from "../../ui/copy-button.js";
import { cn } from "@/lib/utils";
import { buildProjectAttachmentContentUrl } from "@/lib/file-content-urls";
import { MarkdownPreview } from "../../ui/markdown-preview.js";
import { Icon } from "@/components/ui/icon.js";
import { computeMutedPrefixLength } from "./compute-muted-prefix-length.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";

interface ConversationMessageContentBaseProps {
  attachments: TimelineConversationAttachments | null;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  text: string;
}

export interface ConversationMessageContentUserProps
  extends ConversationMessageContentBaseProps {
  role: "user";
  initiator: TimelineUserConversationRow["initiator"];
  turnRequest: TimelineUserConversationRow["turnRequest"];
}

export interface ConversationMessageContentAssistantProps
  extends ConversationMessageContentBaseProps {
  role: "assistant";
  turnRequest: null;
}

/**
 * Discriminated on `role` so the user variant carries `initiator` +
 * non-null `turnRequest` while the assistant variant requires neither.
 * Avoids optional-with-default props (AGENTS.md: "do not use optional
 * fields to hide defaults") and lets the renderer drop optional-chain
 * defenses on contract-required fields.
 */
export type ConversationMessageContentProps =
  | ConversationMessageContentUserProps
  | ConversationMessageContentAssistantProps;

interface ConversationImageItem {
  alt: string;
  src: string;
}

interface ConversationAttachmentItems {
  filePaths: string[];
  imageItems: ConversationImageItem[];
}

interface ConversationAttachmentsProps extends ConversationAttachmentItems {
  align?: "start" | "end";
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
}

interface UserConversationMessageProps
  extends Omit<ConversationMessageContentUserProps, "role"> {
  attachmentItems: ConversationAttachmentItems;
}

interface AssistantConversationMessageProps
  extends Omit<ConversationMessageContentAssistantProps, "role"> {
  attachmentItems: ConversationAttachmentItems;
}

interface CollapsibleMessageTextProps {
  text: string;
  /**
   * When set, the first `mutePrefixLength` characters of `text` are rendered
   * inside a muted, max-width-truncated pill — used for `[bb …]` prefixes on
   * agent/system-initiated messages.
   */
  mutePrefixLength?: number;
}

interface ProjectAttachmentHrefArgs {
  path: string;
  projectId: string | undefined;
}

interface PathClassificationArgs {
  path: string;
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/u;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

function isAbsoluteLocalPath({ path }: PathClassificationArgs): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

function isProjectAttachmentPath({ path }: PathClassificationArgs): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("\\") &&
    !isAbsoluteLocalPath({ path }) &&
    !URL_SCHEME_PATTERN.test(path)
  );
}

function projectAttachmentHref({
  path,
  projectId,
}: ProjectAttachmentHrefArgs): string | null {
  if (!projectId || !isProjectAttachmentPath({ path })) {
    return null;
  }

  return buildProjectAttachmentContentUrl(projectId, path);
}

function turnRequestLabel(
  turnRequest: TimelineConversationTurnRequest,
): string | null {
  if (turnRequest.kind !== "steer") {
    return null;
  }
  return turnRequest.status === "pending" ? "steer pending" : "steer";
}

function buildAttachmentItems({
  attachments,
  projectId,
  resolveUserAttachmentImageSrc,
}: Pick<
  ConversationMessageContentProps,
  "attachments" | "projectId" | "resolveUserAttachmentImageSrc"
>): ConversationAttachmentItems {
  if (!attachments) {
    return {
      filePaths: [],
      imageItems: [],
    };
  }

  const imageItems: ConversationImageItem[] = [
    ...attachments.imageUrls.map((url) => ({
      alt: fileNameFromPath(url),
      src: url,
    })),
    ...attachments.localImagePaths.map((path) => ({
      alt: fileNameFromPath(path),
      src: resolveUserAttachmentImageSrc
        ? resolveUserAttachmentImageSrc(path, projectId)
        : path,
    })),
  ];

  return {
    filePaths: attachments.localFilePaths,
    imageItems,
  };
}

function ConversationAttachments({
  align = "start",
  filePaths,
  imageItems,
  onOpenLocalFileLink,
  projectId,
}: ConversationAttachmentsProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageItem =
    expandedImageIndex === null
      ? null
      : (imageItems[expandedImageIndex] ?? null);
  const hasMultipleImages = imageItems.length > 1;
  const justifyClassName = align === "end" ? "justify-end" : "justify-start";

  useEffect(() => {
    if (expandedImageIndex === null || expandedImageIndex < imageItems.length) {
      return;
    }
    setExpandedImageIndex(null);
  }, [expandedImageIndex, imageItems.length]);

  if (filePaths.length === 0 && imageItems.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {imageItems.length > 0 ? (
        <div className={cn("flex flex-wrap gap-2", justifyClassName)}>
          {imageItems.map((imageItem, index) => (
            <button
              type="button"
              key={`${imageItem.src}-${index}`}
              className={cn(
                "cursor-zoom-in overflow-hidden rounded-md border",
                align === "end"
                  ? "border-surface-selected-border bg-surface-raised"
                  : "border-border bg-surface-recessed",
              )}
              onClick={() => setExpandedImageIndex(index)}
              title={imageItem.alt}
            >
              <img
                src={imageItem.src}
                alt={imageItem.alt}
                className={cn(
                  "object-cover",
                  align === "end" ? "h-20 max-w-36" : "h-16 w-24",
                )}
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
      {filePaths.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", justifyClassName)}>
          {filePaths.map((path) => {
            const className = cn(
              "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground",
              align === "end"
                ? "border-surface-selected-border bg-surface-raised"
                : "border-border bg-surface-recessed",
            );
            const label = (
              <span className="truncate">{fileNameFromPath(path)}</span>
            );
            const attachmentHref = projectAttachmentHref({ path, projectId });

            if (attachmentHref) {
              return (
                <a
                  key={path}
                  href={attachmentHref}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(className, "hover:bg-state-hover")}
                >
                  {label}
                </a>
              );
            }

            if (!onOpenLocalFileLink || !isAbsoluteLocalPath({ path })) {
              return (
                <span key={path} className={cn(className, "cursor-default")}>
                  {label}
                </span>
              );
            }

            return (
              <button
                key={path}
                type="button"
                className={cn(className, "hover:bg-state-hover")}
                onClick={() => {
                  onOpenLocalFileLink({ lineNumber: null, path });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
      <ImageLightbox
        title="Attached image preview"
        imageSrc={currentImageItem?.src ?? null}
        imageAlt={currentImageItem?.alt ?? "Attached image"}
        hasMultipleImages={hasMultipleImages}
        onPrevious={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onNext={() => {
          setExpandedImageIndex(
            expandedImageIndex === null || imageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: imageItems.length,
                }),
          );
        }}
        onClose={() => setExpandedImageIndex(null)}
      />
    </div>
  );
}

const COLLAPSED_MESSAGE_LINE_COUNT = 15;
// Hard upper bound on what a user message ever hands to the DOM, even fully
// expanded. Pasting a megabyte-scale blob (logs, HARs, JSON dumps) would
// otherwise make every window-resize frame reflow the entire string.
const USER_MESSAGE_CHAR_CAP = 4096;

function splitPreWrappedLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

function useIsOverflowing(
  elementRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  measurementKey: string,
): boolean {
  const [isOverflowing, setIsOverflowing] = useState(false);

  // useLayoutEffect (not useEffect) so the first measurement runs before
  // paint. Otherwise the first paint renders without the "Show more" toggle
  // (isOverflowing starts at false), and the button appears on the next
  // frame after the effect runs — visible as a flicker on page load for any
  // user message long enough to overflow.
  useLayoutEffect(() => {
    if (!enabled) {
      setIsOverflowing(false);
      return;
    }

    const element = elementRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [elementRef, enabled, measurementKey]);

  return isOverflowing;
}

function CollapsibleMessageText({
  text,
  mutePrefixLength,
}: CollapsibleMessageTextProps) {
  // The prefix is computed off the full source text; if it would consume
  // everything we'd show (or extend past the text — e.g. char-cap truncates
  // before the closing `]`), fall back to plain rendering.
  const showMutedPrefix =
    typeof mutePrefixLength === "number" &&
    mutePrefixLength > 0 &&
    mutePrefixLength < text.length;
  const prefixText = showMutedPrefix ? text.slice(0, mutePrefixLength) : null;
  const bodyText = showMutedPrefix ? text.slice(mutePrefixLength) : text;

  const [isExpanded, setIsExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const isTruncated = bodyText.length > USER_MESSAGE_CHAR_CAP;
  const cappedBody = isTruncated
    ? bodyText.slice(0, USER_MESSAGE_CHAR_CAP)
    : bodyText;
  const lines = splitPreWrappedLines(cappedBody);
  const exceedsCollapsedLineCount = lines.length > COLLAPSED_MESSAGE_LINE_COUNT;
  // Collapsed view hands only the visible-by-line-clamp lines to the DOM;
  // expanded view hands the (already-capped) full text. Both stay below the
  // hard char cap so a megabyte paste can't dominate window-resize reflow.
  const renderedBody =
    isExpanded || !exceedsCollapsedLineCount
      ? cappedBody
      : lines.slice(0, COLLAPSED_MESSAGE_LINE_COUNT).join("\n");
  const isOverflowing = useIsOverflowing(textRef, !isExpanded, renderedBody);
  const showToggle =
    isExpanded || exceedsCollapsedLineCount || isOverflowing;

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
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap break-words",
          !isExpanded && "line-clamp-[15]",
        )}
      >
        {renderedBody}
        {isExpanded && isTruncated ? (
          <span className="text-muted-foreground"> [truncated]</span>
        ) : null}
      </p>
      {showToggle ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={isExpanded}
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function UserConversationMessage({
  attachmentItems,
  initiator,
  onOpenLocalFileLink,
  projectId,
  text,
  turnRequest,
}: UserConversationMessageProps) {
  const mutePrefixLength = useMemo(
    () => computeMutedPrefixLength(initiator, text),
    [initiator, text],
  );
  const messageText = text.trim();
  const requestLabel = turnRequestLabel(turnRequest);
  const isPendingSteer =
    turnRequest.kind === "steer" && turnRequest.status === "pending";
  const showToolbar = requestLabel !== null || messageText.length > 0;

  return (
    <div className="w-full">
      <div className="ml-auto w-fit max-w-[80%]">
        <div className="rounded-md bg-surface-selected p-2 text-sm leading-relaxed text-foreground">
          {messageText ? (
            <CollapsibleMessageText
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
        {showToolbar ? (
          <div className="mt-1 flex items-center justify-end gap-2">
            {requestLabel ? (
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap text-xs leading-none text-muted-foreground",
                  isPendingSteer && "animate-shine",
                )}
              >
                <Icon name="CornerDownRight" className="mr-1 inline-block size-3 align-middle" />
                {requestLabel}
              </span>
            ) : null}
            {messageText ? (
              <CopyButton text={text} label="Copy message" />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantConversationMessage({
  attachmentItems,
  onOpenLocalFileLink,
  projectId,
  text,
}: AssistantConversationMessageProps) {
  return (
    <div className="group w-full px-2 text-sm leading-relaxed">
      <MarkdownPreview
        content={text}
        onOpenLocalFileLink={onOpenLocalFileLink}
      />
      <ConversationAttachments
        filePaths={attachmentItems.filePaths}
        imageItems={attachmentItems.imageItems}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
      />
    </div>
  );
}

export function ConversationMessageContent(
  props: ConversationMessageContentProps,
) {
  const { attachments, onOpenLocalFileLink, projectId, resolveUserAttachmentImageSrc, text } =
    props;
  const attachmentItems = useMemo(
    () =>
      buildAttachmentItems({
        attachments,
        projectId,
        resolveUserAttachmentImageSrc,
      }),
    [attachments, projectId, resolveUserAttachmentImageSrc],
  );

  if (props.role === "user") {
    return (
      <UserConversationMessage
        attachmentItems={attachmentItems}
        attachments={attachments}
        initiator={props.initiator}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        text={text}
        turnRequest={props.turnRequest}
      />
    );
  }

  return (
    <AssistantConversationMessage
      attachmentItems={attachmentItems}
      attachments={attachments}
      onOpenLocalFileLink={onOpenLocalFileLink}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      text={text}
      turnRequest={props.turnRequest}
    />
  );
}
