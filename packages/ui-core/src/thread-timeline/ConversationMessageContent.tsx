import { useEffect, useMemo, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TimelineConversationAttachments } from "@bb/server-contract";
import {
  ImageLightbox,
  getWrappedImageIndex,
} from "../primitives/image-lightbox.js";
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
  text: string;
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
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}

interface ConversationMarkdownProps {
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  text: string;
}

interface MarkdownAnchorProps extends ComponentProps<"a"> {
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
}

interface LocalFileHrefParts {
  lineNumber: number | null;
  path: string;
}

function fileName(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").pop() || path;
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

function MarkdownAnchor({
  children,
  href,
  onOpenLocalFileLink,
  ...anchorProps
}: MarkdownAnchorProps) {
  const localFileLink = parseLocalFileHref(href);

  return (
    <a
      {...anchorProps}
      href={href}
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      onClick={(event) => {
        if (!localFileLink || !onOpenLocalFileLink) {
          return;
        }
        const handled = onOpenLocalFileLink(localFileLink);
        if (handled) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </a>
  );
}

function ConversationMarkdown({
  onOpenLocalFileLink,
  text,
}: ConversationMarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => (
          <MarkdownAnchor
            {...props}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
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
      alt: fileName(url),
      src: url,
    })),
    ...attachments.localImagePaths.map((path) => ({
      alt: fileName(path),
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
  filePaths,
  imageItems,
  onOpenLocalFileLink,
}: ConversationAttachmentsProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(null);
  const currentImageItem =
    expandedImageIndex === null ? null : (imageItems[expandedImageIndex] ?? null);
  const hasMultipleImages = imageItems.length > 1;

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
        <div className="flex flex-wrap gap-2">
          {imageItems.map((imageItem, index) => (
            <button
              type="button"
              key={`${imageItem.src}-${index}`}
              className="cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/20"
              onClick={() => setExpandedImageIndex(index)}
              title={imageItem.alt}
            >
              <img
                src={imageItem.src}
                alt={imageItem.alt}
                className="h-16 w-24 object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
      {filePaths.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {filePaths.map((path) => {
            const className =
              "inline-flex max-w-full items-center rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground";
            const label = <span className="truncate">{fileName(path)}</span>;

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

export function ConversationMessageContent({
  attachments,
  onOpenLocalFileLink,
  projectId,
  resolveUserAttachmentImageSrc,
  text,
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

  return (
    <div className="mt-1 text-sm leading-relaxed text-foreground/90">
      {text.trim().length > 0 ? (
        <div className="max-w-none break-words text-current [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>ol]:my-1.5 [&>ol]:list-decimal [&>ol]:pl-5 [&>p]:my-1.5 [&>pre]:my-2 [&>ul]:my-1.5 [&>ul]:list-disc [&>ul]:pl-5">
          <ConversationMarkdown
            text={text}
            onOpenLocalFileLink={onOpenLocalFileLink}
          />
        </div>
      ) : null}
      <ConversationAttachments
        filePaths={attachmentItems.filePaths}
        imageItems={attachmentItems.imageItems}
        onOpenLocalFileLink={onOpenLocalFileLink}
      />
    </div>
  );
}
