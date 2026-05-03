import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
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
import type {
  ThreadTimelineLocalFileLink,
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

interface ConversationMarkdownProps {
  content: string;
  className?: string;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}

interface MarkdownAnchorProps
  extends ComponentPropsWithoutRef<"a">,
    ExtraProps {
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}

interface BuildMarkdownComponentsArgs {
  imageUrls: readonly string[];
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  setExpandedImageIndex: ExpandedImageIndexSetter;
}

interface MarkdownImageRendererArgs {
  alt: ComponentPropsWithoutRef<"img">["alt"];
  imageUrls: readonly string[];
  setExpandedImageIndex: ExpandedImageIndexSetter;
  src: ComponentPropsWithoutRef<"img">["src"];
}

interface LocalFileHrefParts {
  lineNumber: number | null;
  path: string;
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

type ConversationMarkdownAnchorEvent = ReactMouseEvent<HTMLAnchorElement>;
type ExpandedImageIndexSetter = Dispatch<SetStateAction<number | null>>;
type MarkdownBlockquoteProps = ComponentPropsWithoutRef<"blockquote"> &
  ExtraProps;
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;
type MarkdownHrProps = ComponentPropsWithoutRef<"hr"> & ExtraProps;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & ExtraProps;
type MarkdownListItemProps = ComponentPropsWithoutRef<"li"> & ExtraProps;
type MarkdownOrderedListProps = ComponentPropsWithoutRef<"ol"> & ExtraProps;
type MarkdownParagraphProps = ComponentPropsWithoutRef<"p"> & ExtraProps;
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
type MarkdownTableCellProps = ComponentPropsWithoutRef<"td"> & ExtraProps;
type MarkdownTableHeadProps = ComponentPropsWithoutRef<"thead"> & ExtraProps;
type MarkdownTableHeaderProps = ComponentPropsWithoutRef<"th"> & ExtraProps;
type MarkdownUnorderedListProps = ComponentPropsWithoutRef<"ul"> &
  ExtraProps;

function userRequestLabel(
  userRequest: TimelineConversationUserRequest | null,
): string | null {
  if (userRequest?.kind !== "steer") {
    return null;
  }
  return userRequest.status === "pending" ? "steer pending" : "steer";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) {
    return null;
  }
  const parsedValue = Number(value);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : null;
}

function parseLineSuffix(value: string): LocalFileHrefParts {
  const hashLineMatch = value.match(/#L([0-9]+)$/u);
  if (hashLineMatch) {
    return {
      lineNumber: parsePositiveInteger(hashLineMatch[1] ?? ""),
      path: value.slice(0, hashLineMatch.index),
    };
  }

  const colonLineMatch = value.match(/:([0-9]+)$/u);
  if (colonLineMatch) {
    return {
      lineNumber: parsePositiveInteger(colonLineMatch[1] ?? ""),
      path: value.slice(0, colonLineMatch.index),
    };
  }

  return {
    lineNumber: null,
    path: value,
  };
}

function parseLocalFileHref(
  href: string | undefined,
): ThreadTimelineLocalFileLink | null {
  if (!href) {
    return null;
  }

  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      const parsed = parseLineSuffix(
        safeDecodeURIComponent(url.pathname + url.hash),
      );
      return parsed.path.startsWith("/") ? parsed : null;
    } catch {
      return null;
    }
  }

  const parsed = parseLineSuffix(safeDecodeURIComponent(href));
  return parsed.path.startsWith("/") ? parsed : null;
}

function extractMarkdownImageUrls(markdown: string): string[] {
  const imageUrls: string[] = [];
  const markdownImagePattern =
    /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
  let match: RegExpExecArray | null = markdownImagePattern.exec(markdown);
  while (match) {
    const imageUrl = match[1];
    if (imageUrl) {
      imageUrls.push(imageUrl);
    }
    match = markdownImagePattern.exec(markdown);
  }
  return imageUrls;
}

function MarkdownAnchor({
  children,
  href,
  onOpenLocalFileLink,
  ...anchorProps
}: MarkdownAnchorProps) {
  const localFileLink = parseLocalFileHref(href);
  const handleLocalFileLinkClick = (
    event: ConversationMarkdownAnchorEvent,
  ) => {
    if (!localFileLink || !onOpenLocalFileLink) {
      return;
    }

    if (!onOpenLocalFileLink(localFileLink)) {
      return;
    }

    event.preventDefault();
  };

  return (
    <a
      {...anchorProps}
      href={href}
      className="break-words underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleLocalFileLinkClick}
    >
      {children}
    </a>
  );
}

function MarkdownCode({
  className: codeClassName,
  children,
  ...props
}: MarkdownCodeProps) {
  const codeText = String(children ?? "").replace(/\n$/, "");
  const languageMatch = /language-(\w+)/u.exec(codeClassName || "");
  const language = languageMatch?.[1];
  const isBlock = codeText.includes("\n");
  if (isBlock) {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border/70 bg-muted/35">
        <div className="flex items-center justify-between pl-3 pr-1.5 pt-1.5">
          <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {language ?? ""}
          </span>
          <CopyButton text={codeText} label="Copy code" />
        </div>
        <pre className="overflow-x-auto px-3 pb-3 pt-1">
          <code
            className={cn(
              "font-mono text-xs",
              language ? `language-${language}` : "",
            )}
            {...props}
          >
            {codeText}
          </code>
        </pre>
      </div>
    );
  }
  return (
    <code
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
      {...props}
    >
      {children}
    </code>
  );
}

function MarkdownPre({ children }: MarkdownPreProps) {
  return <>{children}</>;
}

function MarkdownParagraph({ children }: MarkdownParagraphProps) {
  return <p className="mb-2 text-foreground last:mb-0">{children}</p>;
}

function MarkdownUnorderedList({ children }: MarkdownUnorderedListProps) {
  return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>;
}

function MarkdownOrderedList({ children }: MarkdownOrderedListProps) {
  return <ol className="mb-2 list-decimal pl-5 text-foreground">{children}</ol>;
}

function MarkdownListItem({ children }: MarkdownListItemProps) {
  return <li className="mb-1 text-foreground">{children}</li>;
}

function MarkdownBlockquote({ children }: MarkdownBlockquoteProps) {
  return (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  );
}

function MarkdownTable({ children }: MarkdownTableProps) {
  return (
    <div
      className="my-2"
      style={{
        width: "max(100%, min(1100px, 100cqw - 2rem))",
        marginInline:
          "calc((100% - max(100%, min(1100px, 100cqw - 2rem))) / 2)",
      }}
    >
      <div className="mx-auto w-max max-w-full overflow-x-auto">
        <table className="border border-border/80">{children}</table>
      </div>
    </div>
  );
}

function MarkdownTableHead({ children }: MarkdownTableHeadProps) {
  return <thead className="bg-muted/40">{children}</thead>;
}

function MarkdownTableHeader({ children }: MarkdownTableHeaderProps) {
  return (
    <th className="border border-border/80 px-2 py-1 text-left font-medium">
      {children}
    </th>
  );
}

function MarkdownTableCell({ children }: MarkdownTableCellProps) {
  return <td className="border border-border/80 px-2 py-1">{children}</td>;
}

function renderMarkdownImage({
  alt,
  imageUrls,
  setExpandedImageIndex,
  src,
}: MarkdownImageRendererArgs) {
  const imageUrl = typeof src === "string" ? src : "";
  if (!imageUrl) return null;
  const imageIndex = imageUrls.indexOf(imageUrl);
  return (
    <img
      src={imageUrl}
      alt={typeof alt === "string" ? alt : "Image"}
      className="my-2 max-h-96 max-w-full cursor-zoom-in rounded-md border border-border/60 object-contain"
      loading="lazy"
      onClick={() => setExpandedImageIndex(imageIndex >= 0 ? imageIndex : 0)}
    />
  );
}

function MarkdownHr(_props: MarkdownHrProps) {
  return <hr className="my-4 border-t border-border/70" />;
}

function buildMarkdownComponents({
  imageUrls,
  onOpenLocalFileLink,
  setExpandedImageIndex,
}: BuildMarkdownComponentsArgs): Components {
  function MarkdownLink(props: MarkdownAnchorProps) {
    return (
      <MarkdownAnchor
        {...props}
        onOpenLocalFileLink={onOpenLocalFileLink}
      />
    );
  }

  function MarkdownImage({ src, alt }: MarkdownImageProps) {
    return renderMarkdownImage({
      alt,
      imageUrls,
      setExpandedImageIndex,
      src,
    });
  }

  return {
    a: MarkdownLink,
    blockquote: MarkdownBlockquote,
    code: MarkdownCode,
    hr: MarkdownHr,
    img: MarkdownImage,
    li: MarkdownListItem,
    ol: MarkdownOrderedList,
    p: MarkdownParagraph,
    pre: MarkdownPre,
    table: MarkdownTable,
    td: MarkdownTableCell,
    th: MarkdownTableHeader,
    thead: MarkdownTableHead,
    ul: MarkdownUnorderedList,
  };
}

function ConversationMarkdownComponent({
  content,
  className,
  onOpenLocalFileLink,
}: ConversationMarkdownProps) {
  const imageUrls = useMemo(() => extractMarkdownImageUrls(content), [content]);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageUrl =
    expandedImageIndex !== null
      ? (imageUrls[expandedImageIndex] ?? null)
      : null;
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        imageUrls,
        onOpenLocalFileLink,
        setExpandedImageIndex,
      }),
    [imageUrls, onOpenLocalFileLink, setExpandedImageIndex],
  );

  const showPreviousImage = useCallback(() => {
    setExpandedImageIndex((currentIndex) => {
      if (currentIndex === null || imageUrls.length <= 1) return currentIndex;
      return getWrappedImageIndex({
        currentIndex,
        direction: "previous",
        itemCount: imageUrls.length,
      });
    });
  }, [imageUrls.length]);

  const showNextImage = useCallback(() => {
    setExpandedImageIndex((currentIndex) => {
      if (currentIndex === null || imageUrls.length <= 1) return currentIndex;
      return getWrappedImageIndex({
        currentIndex,
        direction: "next",
        itemCount: imageUrls.length,
      });
    });
  }, [imageUrls.length]);

  return (
    <>
      <div
        className={cn(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>

      <ImageLightbox
        imageSrc={currentImageUrl}
        imageAlt="Expanded image"
        title="Expanded image preview"
        hasMultipleImages={imageUrls.length > 1}
        onPrevious={showPreviousImage}
        onNext={showNextImage}
        onClose={() => setExpandedImageIndex(null)}
      />
    </>
  );
}

const ConversationMarkdown = memo(ConversationMarkdownComponent);
ConversationMarkdown.displayName = "ConversationMarkdown";

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
const OVERFLOW_MEASURE_MIN_LENGTH = 800;

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
  const canOverflow =
    text.length >= OVERFLOW_MEASURE_MIN_LENGTH || exceedsCollapsedLineCount;
  const isOverflowing = useIsOverflowing(
    textRef,
    canOverflow && !isExpanded,
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
    <div className="group mt-2 w-full">
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
    <div className="group w-full">
      <div className="mr-auto w-full">
        <div className="rounded-md p-2 text-sm leading-relaxed">
          <ConversationMarkdown
            content={text}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
          <ConversationAttachments
            filePaths={attachmentItems.filePaths}
            imageItems={attachmentItems.imageItems}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        </div>
      </div>
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
