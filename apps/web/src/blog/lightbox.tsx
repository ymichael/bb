import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getImageSize } from "./image-sizes";

const FOCUSABLE = 'button, [href], [tabindex]:not([tabindex="-1"])';

export function LightboxImage({
  src,
  alt,
  className,
  loading = "lazy",
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const size = getImageSize(src);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          className ? `lightbox-trigger ${className}` : "lightbox-trigger"
        }
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt}
          loading={loading}
          width={size?.width}
          height={size?.height}
        />
      </button>
      {open ? (
        <div
          ref={dialogRef}
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelId}
          onClick={close}
        >
          <span id={labelId} className="sr-only">
            {alt || "Image"}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="lightbox-close"
            onClick={close}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close</span>
          </button>
          <img src={src} alt={alt} />
        </div>
      ) : null}
    </>
  );
}
