import { useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cx } from "../utils.js";

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

interface WrappedImageIndexInput {
  currentIndex: number;
  direction: "next" | "previous";
  itemCount: number;
}

interface IconButtonProps {
  children: ReactNode;
  className?: string;
  label: string;
  onClick: () => void;
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
  if (itemCount <= 0) return currentIndex;
  if (direction === "previous") {
    return currentIndex === 0 ? itemCount - 1 : currentIndex - 1;
  }
  return currentIndex === itemCount - 1 ? 0 : currentIndex + 1;
}

interface ImageLightboxProps {
  imageAlt: string;
  imageSrc: string | null;
  hasMultipleImages?: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  title: string;
}

function IconButton({
  children,
  className,
  label,
  onClick,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex size-9 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/60",
        className,
      )}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function ImageLightbox({
  imageAlt,
  imageSrc,
  hasMultipleImages = false,
  onClose,
  onNext,
  onPrevious,
  title,
}: ImageLightboxProps) {
  const hasNavigation =
    hasMultipleImages && onPrevious !== undefined && onNext !== undefined;

  useEffect(() => {
    if (!imageSrc) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = getImageLightboxKeyAction({
        event,
        hasNavigation,
      });
      if (!action) return;

      switch (action) {
        case "close":
          event.preventDefault();
          onClose();
          return;
        case "previous":
          if (!onPrevious) return;
          event.preventDefault();
          onPrevious();
          return;
        case "next":
          if (!onNext) return;
          event.preventDefault();
          onNext();
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasNavigation, imageSrc, onClose, onNext, onPrevious]);

  if (!imageSrc) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex h-screen w-screen items-center justify-center bg-black/55 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="left-0 top-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center border-none bg-transparent p-0 shadow-none data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0 data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 sm:rounded-none [&>button]:hidden">
        <span className="sr-only">{title}</span>
        <img
          src={imageSrc}
          alt={imageAlt}
          className="max-h-[82vh] max-w-[90vw] rounded bg-background/95 object-contain"
        />

        {hasNavigation ? (
          <>
            <IconButton
              className="absolute left-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              onClick={onPrevious}
              label="Previous image"
            >
              <ChevronLeft className="size-5" />
            </IconButton>
            <IconButton
              className="absolute right-2 top-1/2 size-9 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              onClick={onNext}
              label="Next image"
            >
              <ChevronRight className="size-5" />
            </IconButton>
          </>
        ) : null}

        <IconButton
          className="absolute right-2 top-2"
          onClick={onClose}
          label="Close image preview"
        >
          <X className="size-5" />
        </IconButton>
      </div>
    </div>
  );
}
