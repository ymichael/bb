import { useLayoutEffect, useState, type RefObject } from "react";
import { cn } from "@bb/shared-ui/lib/utils";

interface UseOverflowMeasurementArgs {
  elementRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  measurementKey: string;
}

type OverflowMeasurement = "unmeasured" | "fits" | "overflowing";

type OverflowMeasurementListener = (
  measurement: Exclude<OverflowMeasurement, "unmeasured">,
) => void;

const overflowListenersByElement = new Map<
  HTMLElement,
  Set<OverflowMeasurementListener>
>();
let sharedOverflowResizeObserver: ResizeObserver | null = null;

function readOverflowMeasurement(
  element: HTMLElement,
): Exclude<OverflowMeasurement, "unmeasured"> {
  return element.scrollHeight > element.clientHeight + 1 ||
    element.scrollWidth > element.clientWidth + 1
    ? "overflowing"
    : "fits";
}

function measureOverflowElements(elements: readonly HTMLElement[]): void {
  const results = elements.map((element) => ({
    element,
    measurement: readOverflowMeasurement(element),
  }));
  for (const { element, measurement } of results) {
    for (const listener of overflowListenersByElement.get(element) ?? []) {
      listener(measurement);
    }
  }
}

function getSharedOverflowResizeObserver(): ResizeObserver {
  sharedOverflowResizeObserver ??= new ResizeObserver((entries) => {
    const connectedElements: HTMLElement[] = [];
    for (const entry of entries) {
      if (entry.target instanceof HTMLElement && entry.target.isConnected) {
        connectedElements.push(entry.target);
      }
    }
    measureOverflowElements(connectedElements);
  });
  return sharedOverflowResizeObserver;
}

function observeOverflow(
  element: HTMLElement,
  listener: OverflowMeasurementListener,
): () => void {
  let listeners = overflowListenersByElement.get(element);
  if (!listeners) {
    listeners = new Set();
    overflowListenersByElement.set(element, listeners);
    getSharedOverflowResizeObserver().observe(element);
  }
  listeners.add(listener);

  return () => {
    const currentListeners = overflowListenersByElement.get(element);
    currentListeners?.delete(listener);
    if (currentListeners?.size === 0) {
      overflowListenersByElement.delete(element);
      sharedOverflowResizeObserver?.unobserve?.(element);
      if (overflowListenersByElement.size === 0) {
        sharedOverflowResizeObserver?.disconnect?.();
        sharedOverflowResizeObserver = null;
      }
    }
  };
}

interface ConversationMessageOverflowToggleProps {
  expanded: boolean;
  onToggle: () => void;
}

interface ConversationMessageInlineOverflowToggleProps {
  buttonBackgroundClassName: string;
  fadeFromClassName: string;
  label: string;
  onToggle: () => void;
}

export function useOverflowMeasurement({
  elementRef,
  enabled,
  measurementKey,
}: UseOverflowMeasurementArgs): OverflowMeasurement {
  const [measurement, setMeasurement] =
    useState<OverflowMeasurement>("unmeasured");

  useLayoutEffect(() => {
    if (!enabled) {
      setMeasurement("fits");
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setMeasurement("unmeasured");
      return;
    }

    const applyMeasurement: OverflowMeasurementListener = (nextMeasurement) => {
      if (!element.isConnected) return;
      setMeasurement(nextMeasurement);
    };
    if (typeof ResizeObserver === "undefined") {
      applyMeasurement(readOverflowMeasurement(element));
      return;
    }

    return observeOverflow(element, applyMeasurement);
  }, [elementRef, enabled, measurementKey]);

  return measurement;
}

export function useIsOverflowing(args: UseOverflowMeasurementArgs): boolean {
  return useOverflowMeasurement(args) === "overflowing";
}

export function ConversationMessageOverflowToggle({
  expanded,
  onToggle,
}: ConversationMessageOverflowToggleProps) {
  return (
    <div className="mt-1 flex justify-end">
      <button
        type="button"
        onClick={onToggle}
        className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

export function ConversationMessageInlineOverflowToggle({
  buttonBackgroundClassName,
  fadeFromClassName,
  label,
  onToggle,
}: ConversationMessageInlineOverflowToggleProps) {
  return (
    <span className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[1lh] items-stretch justify-end">
      <span
        className={cn(
          "w-12 bg-gradient-to-l to-transparent",
          fadeFromClassName,
        )}
      />
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "pointer-events-auto cursor-pointer whitespace-nowrap pl-1.5 text-xs font-medium text-muted-foreground hover:text-foreground",
          buttonBackgroundClassName,
        )}
        aria-expanded={false}
      >
        {label}
      </button>
    </span>
  );
}
