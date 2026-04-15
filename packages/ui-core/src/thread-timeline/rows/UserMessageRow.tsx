import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ViewUserMessage } from "@bb/domain";
import { Check, Copy } from "lucide-react";
import { cn } from "../../cn.js";
import { ImageLightbox, getWrappedImageIndex } from "../ImageLightbox.js";
import { toUserAttachmentImageSrc } from "../userAttachmentImages.js";
import type { UserAttachmentImageSrcResolver } from "../types.js";

interface UserMessageRowProps {
  message: ViewUserMessage;
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
}

export function UserMessageRow({
  message,
  projectId,
  resolveUserAttachmentImageSrc = toUserAttachmentImageSrc,
}: UserMessageRowProps) {
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const attachments: string[] = [];
  if (message.attachments?.localFiles) {
    const count = message.attachments.localFiles;
    attachments.push(`${count} local file${count === 1 ? "" : "s"}`);
  }
  const messageText = message.text.trim();

  const imageSources = useMemo(
    () => [
      ...(message.attachments?.imageUrls ?? []),
      ...(message.attachments?.localImagePaths ?? []),
    ],
    [message.attachments?.imageUrls, message.attachments?.localImagePaths],
  );

  const imageItems = useMemo(
    () =>
      imageSources.map((source, index) => ({
        alt: `Attached image ${index + 1}`,
        src: resolveUserAttachmentImageSrc(source, projectId),
      })),
    [imageSources, projectId, resolveUserAttachmentImageSrc],
  );
  const hasMultipleImages = imageItems.length > 1;
  const currentImage =
    expandedImageIndex !== null ? (imageItems[expandedImageIndex] ?? null) : null;

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const handleCopy = async () => {
    if (!messageText || copied) {
      return;
    }
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const showPreviousImage = useCallback(() => {
    setExpandedImageIndex((index) => {
      if (index === null || imageItems.length <= 1) return index;
      return getWrappedImageIndex({
        currentIndex: index,
        direction: "previous",
        itemCount: imageItems.length,
      });
    });
  }, [imageItems.length]);

  const showNextImage = useCallback(() => {
    setExpandedImageIndex((index) => {
      if (index === null || imageItems.length <= 1) return index;
      return getWrappedImageIndex({
        currentIndex: index,
        direction: "next",
        itemCount: imageItems.length,
      });
    });
  }, [imageItems.length]);

  return (
    <>
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="ml-auto w-fit max-w-[80%]">
          <div className="rounded-md bg-primary/10 p-2 text-sm leading-relaxed text-foreground">
            {messageText ? (
              <CollapsibleMessageText text={message.text} />
            ) : (
              <p className="text-muted-foreground">Sent attachments</p>
            )}

            {imageSources.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap justify-end gap-2">
                {imageSources.map((source, index) => (
                  <button
                    key={`${source}-${index}`}
                    type="button"
                    className="cursor-zoom-in overflow-hidden rounded-md border border-primary/30 bg-background/70"
                    onClick={() => setExpandedImageIndex(index)}
                  >
                    <img
                      src={resolveUserAttachmentImageSrc(source, projectId)}
                      alt={`Attached image ${index + 1}`}
                      className="h-20 max-w-36 object-cover"
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            ) : null}

            {attachments.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                {attachments.map((attachment) => (
                  <span
                    key={attachment}
                    className="inline-flex items-center rounded-full border border-primary/30 bg-background/70 px-2 py-0 text-xs text-muted-foreground"
                  >
                    {attachment}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {messageText ? (
            <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                className="size-6 text-muted-foreground hover:text-foreground focus-visible:opacity-100"
                onClick={() => {
                  void handleCopy();
                }}
                aria-label="Copy message"
                title="Copy message"
              >
                {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <ImageLightbox
        imageSrc={currentImage?.src ?? null}
        imageAlt={currentImage?.alt ?? "Attached image"}
        title="Attached image preview"
        hasMultipleImages={hasMultipleImages}
        onPrevious={showPreviousImage}
        onNext={showNextImage}
        onClose={() => setExpandedImageIndex(null)}
      />
    </>
  );
}

// 15 clamped lines × ~80 chars/line ≈ 1200 chars. Below that, wrapping cannot
// exceed the clamp, so skip measurement entirely.
const OVERFLOW_MEASURE_MIN_LENGTH = 1200;

function CollapsibleMessageText({ text }: { text: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const canOverflow = text.length >= OVERFLOW_MEASURE_MIN_LENGTH;

  useLayoutEffect(() => {
    if (!canOverflow || isExpanded) return;
    const el = textRef.current;
    if (!el) return;
    const check = () => {
      setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, isExpanded, canOverflow]);

  const showToggle = isExpanded || isOverflowing;

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

