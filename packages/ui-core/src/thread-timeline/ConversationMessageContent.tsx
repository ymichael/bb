import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  TimelineConversationAttachments,
  TimelineConversationRow,
  TimelineConversationUserRequest,
} from "@bb/server-contract";
import { fileNameFromPath } from "@bb/thread-view";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "../primitives/image-lightbox.js";
import { CopyButton } from "../primitives/ui/copy-button.js";
import { cn } from "../primitives/cn.js";
import { MarkdownPreview } from "../primitives/markdown-preview.js";
import type {
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";

export interface ConversationMessageContentProps {
  attachments: TimelineConversationAttachments | null;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  role: TimelineConversationRow["role"];
  text: string;
  userRequest: TimelineConversationRow["userRequest"];
}

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
}

interface UserConversationMessageProps
  extends Omit<ConversationMessageContentProps, "role"> {
  attachmentItems: ConversationAttachmentItems;
}

interface AssistantConversationMessageProps
  extends Omit<ConversationMessageContentProps, "role"> {
  attachmentItems: ConversationAttachmentItems;
}

interface CollapsibleMessageTextProps {
  text: string;
}

interface CountPreWrappedLinesInput {
  text: string;
}

function userRequestLabel(
  userRequest: TimelineConversationUserRequest | null,
): string | null {
  if (userRequest?.kind !== "steer") {
    return null;
  }
  return userRequest.status === "pending" ? "steer pending" : "steer";
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
}: ConversationAttachmentsProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageItem =
    expandedImageIndex === null ? null : (imageItems[expandedImageIndex] ?? null);
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
                  ? "border-primary/30 bg-background/70"
                  : "border-border/70 bg-muted/20",
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
                ? "border-primary/30 bg-background/70"
                : "border-border/70 bg-muted/40",
            );
            const label = (
              <span className="truncate">{fileNameFromPath(path)}</span>
            );

            if (!onOpenLocalFileLink) {
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
                className={cn(className, "hover:bg-muted/60")}
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

function countPreWrappedLines({ text }: CountPreWrappedLinesInput): number {
  return text.split(/\r\n|\r|\n/u).length;
}

function useIsOverflowing(
  elementRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  measurementKey: string,
): boolean {
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
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

function CollapsibleMessageText({ text }: CollapsibleMessageTextProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const exceedsCollapsedLineCount =
    countPreWrappedLines({ text }) > COLLAPSED_MESSAGE_LINE_COUNT;
  const isOverflowing = useIsOverflowing(
    textRef,
    !isExpanded,
    text,
  );
  const showToggle = isExpanded || exceedsCollapsedLineCount || isOverflowing;

  return (
    <>
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap break-words",
          !isExpanded && "line-clamp-[15]",
        )}
      >
        {text}
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
  onOpenLocalFileLink,
  text,
  userRequest,
}: UserConversationMessageProps) {
  const messageText = text.trim();
  const requestLabel = userRequestLabel(userRequest);

  return (
    <div className="group w-full">
      <div className="ml-auto w-fit max-w-[80%]">
        <div className="rounded-md bg-primary/10 p-2 text-sm leading-relaxed text-foreground">
          {messageText ? (
            <CollapsibleMessageText text={text} />
          ) : (
            <p className="text-muted-foreground">Sent attachments</p>
          )}
          <ConversationAttachments
            align="end"
            filePaths={attachmentItems.filePaths}
            imageItems={attachmentItems.imageItems}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        </div>
        {requestLabel ? (
          <div className="mt-1 flex justify-end">
            <span className="text-xs leading-none text-muted-foreground">
              {requestLabel}
            </span>
          </div>
        ) : null}
        {messageText ? (
          <div className="mt-1 flex justify-end opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <CopyButton text={messageText} label="Copy message" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantConversationMessage({
  attachmentItems,
  onOpenLocalFileLink,
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
      />
    </div>
  );
}

export function ConversationMessageContent({
  attachments,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  role,
  text,
  userRequest,
}: ConversationMessageContentProps) {
  const attachmentItems = useMemo(
    () =>
      buildAttachmentItems({
        attachments,
        projectId,
        resolveUserAttachmentImageSrc,
      }),
    [attachments, projectId, resolveUserAttachmentImageSrc],
  );

  if (role === "user") {
    return (
      <UserConversationMessage
        attachmentItems={attachmentItems}
        attachments={attachments}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        text={text}
        userRequest={userRequest}
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
      userRequest={userRequest}
    />
  );
}
