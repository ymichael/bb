import { useEffect } from "react";
import { Button } from "./button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./dialog.js";
import { Icon } from "@/components/ui/icon.js";

export const imageLightboxKeyActionValues = [
  "close",
  "next",
  "previous",
] as const;
export type ImageLightboxKeyAction =
  (typeof imageLightboxKeyActionValues)[number];

export interface ImageLightboxKeyActionInput {
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey"
  >;
  hasNavigation: boolean;
}

export interface WrappedImageIndexInput {
  currentIndex: number;
  direction: "next" | "previous";
  itemCount: number;
}

export interface ImageLightboxProps {
  hasMultipleImages?: boolean;
  imageAlt: string;
  imageSrc: string | null;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  title: string;
}

export function getImageLightboxKeyAction({
  event,
  hasNavigation,
}: ImageLightboxKeyActionInput): ImageLightboxKeyAction | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return null;
  }

  if (event.key === "Escape") {
    return "close";
  }

  if (!hasNavigation) {
    return null;
  }

  if (event.key === "ArrowLeft") {
    return "previous";
  }

  if (event.key === "ArrowRight") {
    return "next";
  }

  return null;
}

export function getWrappedImageIndex({
  currentIndex,
  direction,
  itemCount,
}: WrappedImageIndexInput): number {
  if (itemCount <= 0) {
    return currentIndex;
  }
  if (direction === "previous") {
    return currentIndex === 0 ? itemCount - 1 : currentIndex - 1;
  }
  return currentIndex === itemCount - 1 ? 0 : currentIndex + 1;
}

export function ImageLightbox({
  hasMultipleImages = false,
  imageAlt,
  imageSrc,
  onClose,
  onNext,
  onPrevious,
  title,
}: ImageLightboxProps) {
  const hasNavigation =
    hasMultipleImages && onPrevious !== undefined && onNext !== undefined;

  useEffect(() => {
    if (!imageSrc) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = getImageLightboxKeyAction({
        event,
        hasNavigation,
      });
      if (!action) {
        return;
      }

      switch (action) {
        case "close":
          event.preventDefault();
          onClose();
          return;
        case "previous":
          if (!onPrevious) {
            return;
          }
          event.preventDefault();
          onPrevious();
          return;
        case "next":
          if (!onNext) {
            return;
          }
          event.preventDefault();
          onNext();
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasNavigation, imageSrc, onClose, onNext, onPrevious]);

  if (!imageSrc) {
    return null;
  }

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="left-0 top-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center border-none bg-transparent p-0 shadow-none data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 sm:rounded-none [&>button]:hidden"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <img
          src={imageSrc}
          alt={imageAlt}
          className="max-h-[82vh] max-w-[90vw] rounded bg-background object-contain"
        />

        {hasNavigation ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute left-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              onClick={onPrevious}
              aria-label="Previous image"
            >
              <Icon name="ChevronLeft" className="size-5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              onClick={onNext}
              aria-label="Next image"
            >
              <Icon name="ChevronRight" className="size-5" />
            </Button>
          </>
        ) : null}

        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 size-9 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
            aria-label="Close image preview"
          >
            <Icon name="X" className="size-5" />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
