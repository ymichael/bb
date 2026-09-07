import { Fragment, type ReactNode } from "react";

import { cn } from "./cn";

export function annotationChipClass(active: boolean, className?: string) {
  return cn(
    "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold leading-none transition-colors",
    "scale-[var(--guide-chip-scale,1)]",
    active
      ? "bg-file-accent text-background"
      : "bg-[color-mix(in_oklch,var(--ink)_18%,var(--canvas))] text-foreground",
    className,
  );
}

export const CHIP_COUNTER_SCALE_PROPERTY = "--guide-chip-scale";

export const MAX_CHIP_COUNTER_SCALE = 3;

export function annotationChipCounterScale(fixtureScale: number): number {
  if (!Number.isFinite(fixtureScale) || fixtureScale <= 0) return 1;
  return Math.min(MAX_CHIP_COUNTER_SCALE, Math.max(1, 1 / fixtureScale));
}

export const FOCUS_RING_CLASS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export type AnnotationChipPlacement =
  | "corner"
  | "corner-inset"
  | "side"
  | "outside-above";

export const CHIP_PLACEMENT_CLASS: Record<AnnotationChipPlacement, string> = {
  corner: "-right-2 -top-2",
  "corner-inset": "right-2 -top-2",
  side: "-right-2 top-1/2 -translate-y-1/2",
  "outside-above": "left-1/2 -top-6 -translate-x-1/2",
};

export function ExperimentalBadge() {
  return (
    <span
      className="inline-flex items-center rounded border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-xs text-warning-text"
      title="Experimental: audited before stabilizing — see docs/api_to_audit.md in the bb repository."
    >
      experimental
    </span>
  );
}

export interface SurfaceReference {
  number: number | null;
  otherPage: string | null;
  onOpen: () => void;
}

const COPY_TOKEN = /(`[^`]+`)|(\[[^\]]+\]\([a-z0-9-]+\))|(\{experimental\})/g;

export function renderSurfaceCopy(
  text: string,
  resolve?: (id: string) => SurfaceReference | null,
): ReactNode {
  const parts = text.split(COPY_TOKEN).filter((part) => part !== undefined);
  if (parts.length < 2) {
    return text;
  }
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded bg-surface-recessed px-1 py-px font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part === "{experimental}") {
      return (
        <Fragment key={index}>
          {" "}
          <ExperimentalBadge />
        </Fragment>
      );
    }
    const reference = /^\[([^\]]+)\]\(([a-z0-9-]+)\)$/.exec(part);
    if (!reference) {
      return <Fragment key={index}>{part}</Fragment>;
    }
    const [, label, id] = reference;
    const target = resolve?.(id) ?? null;
    if (!target) {
      return <Fragment key={index}>{label}</Fragment>;
    }
    return (
      <button
        key={index}
        type="button"
        onClick={target.onOpen}
        title={target.otherPage ? `On ${target.otherPage}` : undefined}
        aria-label={
          target.otherPage
            ? `Go to ${label} on ${target.otherPage}`
            : `Go to ${label} on this page`
        }
        className={`cursor-pointer rounded-sm underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground ${FOCUS_RING_CLASS}`}
      >
        {label}
      </button>
    );
  });
}
