import { useEffect } from "react";
import {
  getWrappedImageIndex,
  ImageLightbox,
} from "@/components/ui/image-lightbox.js";
import { Icon } from "@bb/shared-ui/icon";
import type { PromptDraftAttachment } from "@bb/client-core";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  getLocalAttachmentPreviewSrc,
  releaseLocalAttachmentPreview,
} from "@/lib/attachment-local-previews";

function resolveAttachmentPreviewSrc(
  path: string,
  attachmentProjectId: string | undefined,
): string {
  return (
    getLocalAttachmentPreviewSrc(path) ??
    toUserAttachmentImageSrc(path, attachmentProjectId)
  );
}

function isImageAttachment(attachment: PromptDraftAttachment): boolean {
  return (
    attachment.type === "localImage" ||
    attachment.mimeType?.toLowerCase().startsWith("image/") === true
  );
}

interface AttachmentPreviewProps {
  attachments: PromptDraftAttachment[];
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (path: string) => void;
}

export function AttachmentPreview({
  attachments,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: AttachmentPreviewProps) {
  const imageAttachments = attachments.filter(isImageAttachment);
  const nonImageAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment),
  );
  const attachmentImageItems = imageAttachments.map((attachment) => ({
    alt: attachment.name,
    src: resolveAttachmentPreviewSrc(attachment.path, attachmentProjectId),
  }));
  const hasMultipleAttachmentImages = imageAttachments.length > 1;
  const currentAttachmentImage =
    expandedImageIndex !== null
      ? (attachmentImageItems[expandedImageIndex] ?? null)
      : null;

  useEffect(() => {
    if (expandedImageIndex === null) return;
    if (expandedImageIndex < imageAttachments.length) return;
    onExpandedImageIndexChange(null);
  }, [expandedImageIndex, imageAttachments.length, onExpandedImageIndexChange]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mx-3 mb-1 mt-1">
        {imageAttachments.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-2">
            {imageAttachments.map((attachment, index) => (
              <div key={`${attachment.path}-${index}`} className="relative">
                <button
                  type="button"
                  className="cursor-zoom-in overflow-hidden rounded-md border border-border bg-surface-recessed"
                  onClick={() => onExpandedImageIndexChange(index)}
                  title={attachment.name}
                >
                  <img
                    src={attachmentImageItems[index]?.src}
                    alt={attachment.name}
                    className="h-16 w-24 object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                </button>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => {
                      releaseLocalAttachmentPreview(attachment.path);
                      onRemoveAttachment(attachment.path);
                    }}
                    className="group/attachment-remove-image absolute right-1 top-1 z-10 inline-flex size-4 items-center justify-center rounded-full text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:-right-1 max-md:pointer-coarse:-top-1 max-md:pointer-coarse:size-7"
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-black/55 transition-colors group-hover/attachment-remove-image:bg-black/70">
                      <Icon name="X" className="size-3" />
                    </span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {nonImageAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {nonImageAttachments.map((attachment) => (
              <span
                key={attachment.path}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-recessed px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="truncate">{attachment.name}</span>
                {onRemoveAttachment ? (
                  <span className="relative size-4 shrink-0">
                    <button
                      type="button"
                      onClick={() => onRemoveAttachment(attachment.path)}
                      className="group/attachment-remove-file absolute left-1/2 top-1/2 inline-flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-7"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <span className="inline-flex size-4 items-center justify-center rounded transition-colors group-hover/attachment-remove-file:bg-state-hover">
                        <Icon name="X" className="size-3" />
                      </span>
                    </button>
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <ImageLightbox
        imageSrc={currentAttachmentImage?.src ?? null}
        imageAlt={currentAttachmentImage?.alt ?? "Attached image"}
        title="Attached image preview"
        hasMultipleImages={hasMultipleAttachmentImages}
        onPrevious={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onNext={() => {
          onExpandedImageIndexChange(
            expandedImageIndex === null || attachmentImageItems.length <= 1
              ? expandedImageIndex
              : getWrappedImageIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: attachmentImageItems.length,
                }),
          );
        }}
        onClose={() => onExpandedImageIndexChange(null)}
      />
    </>
  );
}
