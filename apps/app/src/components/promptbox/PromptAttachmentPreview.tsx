import { X } from "lucide-react";
import { ImageLightbox, getWrappedImageIndex } from "@/components/shared/ImageLightbox";
import type { PromptDraftAttachment } from "@/lib/prompt-draft";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";

function isImageAttachment(attachment: PromptDraftAttachment): boolean {
  return (
    attachment.type === "localImage" ||
    attachment.mimeType?.toLowerCase().startsWith("image/") === true
  );
}

interface PromptAttachmentPreviewProps {
  attachments: PromptDraftAttachment[];
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (path: string) => void;
}

export function PromptAttachmentPreview({
  attachments,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: PromptAttachmentPreviewProps) {
  const imageAttachments = attachments.filter(isImageAttachment);
  const nonImageAttachments = attachments.filter((attachment) => !isImageAttachment(attachment));
  const attachmentImageItems = imageAttachments.map((attachment) => ({
    alt: attachment.name,
    src: toUserAttachmentImageSrc(attachment.path, attachmentProjectId),
  }));
  const hasMultipleAttachmentImages = imageAttachments.length > 1;
  const currentAttachmentImage =
    expandedImageIndex !== null ? (attachmentImageItems[expandedImageIndex] ?? null) : null;

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
                  className="cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/20"
                  onClick={() => onExpandedImageIndexChange(index)}
                  title={attachment.name}
                >
                  <img
                    src={toUserAttachmentImageSrc(attachment.path, attachmentProjectId)}
                    alt={attachment.name}
                    className="h-16 w-24 object-cover"
                    loading="lazy"
                  />
                </button>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.path)}
                    className="absolute right-1 top-1 z-10 rounded-full bg-black/55 p-0.5 text-white transition-colors hover:bg-black/70"
                    title={`Remove ${attachment.name}`}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <X className="size-3" />
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
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
              >
                <span className="truncate">{attachment.name}</span>
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.path)}
                    className="rounded p-0.5 hover:bg-background/70"
                    title={`Remove ${attachment.name}`}
                  >
                    <X className="size-3" />
                  </button>
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
