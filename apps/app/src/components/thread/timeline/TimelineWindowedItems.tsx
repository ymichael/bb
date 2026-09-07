import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import type { TimelineWindowedItemsProps } from "./TimelineWindowedItemsLoader.js";

export type { TimelineWindowedItemRenderState } from "./TimelineWindowedItemsLoader.js";

const TIMELINE_WINDOW_OVERSCAN_ITEMS = 8;
const TIMELINE_WINDOW_IDLE_DELAY_MS = 300;
const TIMELINE_WINDOW_MAX_INTERACTION_PINS = 24;
const TIMELINE_WINDOW_MAX_MEASUREMENTS = 2_000;
const TIMELINE_WINDOWING_MIN_ITEM_COUNT = 20;

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();
const GET_NO_SCROLL_ELEMENT = () => null;
const NOOP_ITEM_REF = () => {};

function recordTimelineMeasurement(
  measurements: Map<string, number>,
  key: string,
  height: number,
): void {
  measurements.delete(key);
  measurements.set(key, height);
  while (measurements.size > TIMELINE_WINDOW_MAX_MEASUREMENTS) {
    const oldestKey = measurements.keys().next().value;
    if (oldestKey === undefined) break;
    measurements.delete(oldestKey);
  }
}

interface ScrollSample {
  at: number;
  fast: boolean;
  offset: number;
}

function measureBorderBox(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
): number {
  const observedHeight = entry?.borderBoxSize[0]?.blockSize;
  return observedHeight ?? element.getBoundingClientRect().height;
}

function findOwnedWindowKey(
  target: EventTarget | null,
  container: HTMLElement,
  indexByKey: ReadonlyMap<string, number>,
): string | null {
  let element = target instanceof Element ? target : null;
  while (element !== null && element !== container) {
    const key = element.getAttribute("data-timeline-window-key");
    if (key !== null && indexByKey.has(key)) return key;
    element = element.parentElement;
  }
  return null;
}

export function TimelineWindowedItems({
  enabled,
  alwaysMountedKeys = EMPTY_KEY_SET,
  estimateItemHeight,
  gap,
  getScrollElement,
  itemKeys,
  measurements,
  minItemCount = TIMELINE_WINDOWING_MIN_ITEM_COUNT,
  renderItem,
}: TimelineWindowedItemsProps) {
  const configured =
    enabled && itemKeys.length >= minItemCount && getScrollElement !== null;
  const [scrollRootUsable, setScrollRootUsable] = useState(true);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [interactionPins, setInteractionPins] = useState<readonly string[]>([]);
  const containerElementRef = useRef<HTMLDivElement>(null);
  const scrollSampleRef = useRef<ScrollSample>({
    at: 0,
    fast: false,
    offset: 0,
  });
  const windowingEnabled = configured && scrollRootUsable;
  const resolvedGetScrollElement = getScrollElement ?? GET_NO_SCROLL_ELEMENT;

  const indexByKey = useMemo(
    () => new Map(itemKeys.map((key, index) => [key, index])),
    [itemKeys],
  );
  const forcedIndexes = useMemo(() => {
    const indexes = new Set<number>();
    for (const key of alwaysMountedKeys) {
      const index = indexByKey.get(key);
      if (index !== undefined) indexes.add(index);
    }
    for (const key of interactionPins) {
      const index = indexByKey.get(key);
      if (index !== undefined) indexes.add(index);
    }
    return indexes;
  }, [alwaysMountedKeys, indexByKey, interactionPins]);

  const getItemKey = useCallback(
    (index: number) => itemKeys[index] ?? index,
    [itemKeys],
  );
  const estimateSize = useCallback(
    (index: number) => {
      const key = itemKeys[index];
      return key === undefined
        ? Math.max(1, estimateItemHeight(index))
        : (measurements.get(key) ?? Math.max(1, estimateItemHeight(index)));
    },
    [estimateItemHeight, itemKeys, measurements],
  );
  const measureElement = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
    ): number => {
      const index = Number(element.dataset.index);
      const height = measureBorderBox(element, entry);
      const key = Number.isInteger(index) ? itemKeys[index] : undefined;
      if (
        key !== undefined &&
        height > 0 &&
        element.dataset.timelineWindowedRealized === "true"
      ) {
        recordTimelineMeasurement(measurements, key, height);
      }
      return height > 0 ? height : estimateSize(index);
    },
    [estimateSize, itemKeys, measurements],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of forcedIndexes) indexes.add(index);
      return [...indexes].sort((left, right) => left - right);
    },
    [forcedIndexes],
  );
  const handleVirtualizerChange = useCallback(
    (
      instance: Virtualizer<HTMLElement, HTMLDivElement>,
      scrolling: boolean,
    ) => {
      const sample = scrollSampleRef.current;
      if (!scrolling) {
        sample.fast = false;
        sample.at = 0;
        sample.offset = instance.scrollOffset ?? sample.offset;
        return;
      }
      const now = performance.now();
      const offset = instance.scrollOffset ?? 0;
      const elapsed = sample.at === 0 ? 0 : now - sample.at;
      const distance = Math.abs(offset - sample.offset);
      const viewportSize = instance.scrollRect?.height ?? 0;
      sample.fast =
        (sample.at === 0 || elapsed <= 100) &&
        distance >= Math.max(200, viewportSize * 0.5);
      sample.at = now;
      sample.offset = offset;
    },
    [],
  );
  const initialOffset = useCallback(
    () => resolvedGetScrollElement()?.scrollTop ?? 0,
    [resolvedGetScrollElement],
  );

  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: itemKeys.length,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    enabled: windowingEnabled,
    estimateSize,
    gap,
    getItemKey,
    getScrollElement: resolvedGetScrollElement,
    initialOffset,
    isScrollingResetDelay: TIMELINE_WINDOW_IDLE_DELAY_MS,
    measureElement,
    onChange: handleVirtualizerChange,
    overscan: TIMELINE_WINDOW_OVERSCAN_ITEMS,
    rangeExtractor,
    scrollMargin,
    useFlushSync: false,
  });
  const containerRef = useComposedRefs(
    containerElementRef,
    virtualizer.containerRef,
  );

  const updateScrollGeometry = useCallback(() => {
    if (!configured) return;
    const container = containerElementRef.current;
    const scrollElement = resolvedGetScrollElement();
    if (container === null || scrollElement === null) return;
    const nextMargin =
      container.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop -
      scrollElement.clientTop;
    setScrollMargin((previous) =>
      Math.abs(previous - nextMargin) < 0.5 ? previous : nextMargin,
    );
  }, [configured, resolvedGetScrollElement]);

  useLayoutEffect(() => {
    if (!configured) return;
    const updateRootUsability = () => {
      const scrollElement = resolvedGetScrollElement();
      if (scrollElement !== null) {
        setScrollRootUsable(scrollElement.clientHeight > 0);
      }
    };
    const scrollElement = resolvedGetScrollElement();
    if (scrollElement === null) {
      const frame = requestAnimationFrame(() => {
        updateRootUsability();
        updateScrollGeometry();
      });
      return () => cancelAnimationFrame(frame);
    }
    updateRootUsability();
    updateScrollGeometry();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateRootUsability();
      updateScrollGeometry();
    });
    observer.observe(scrollElement);
    const containerParent = containerElementRef.current?.parentElement;
    if (containerParent !== null && containerParent !== undefined) {
      observer.observe(containerParent);
    }
    return () => observer.disconnect();
  }, [configured, resolvedGetScrollElement, updateScrollGeometry]);

  useLayoutEffect(updateScrollGeometry);

  const retainInteractedItem = useCallback(
    (event: SyntheticEvent<HTMLDivElement>) => {
      const container = containerElementRef.current;
      if (container === null) return;
      const key = findOwnedWindowKey(event.target, container, indexByKey);
      if (key === null) return;
      setInteractionPins((previous) => {
        const next = previous.filter((candidate) => candidate !== key);
        next.push(key);
        return next.slice(-TIMELINE_WINDOW_MAX_INTERACTION_PINS);
      });
    },
    [indexByKey],
  );

  if (!windowingEnabled) {
    return (
      <>
        {itemKeys.map((key, index) =>
          renderItem(index, {
            isRealized: true,
            itemIndex: undefined,
            itemRef: NOOP_ITEM_REF,
            itemStyle: undefined,
            windowingEnabled: false,
          }),
        )}
      </>
    );
  }

  const fastScrolling = scrollSampleRef.current.fast;
  const virtualItemsByIndex = new Map(
    virtualizer.getVirtualItems().map((item) => [item.index, item]),
  );
  for (const index of forcedIndexes) {
    const item = virtualizer.measurementsCache[index];
    if (item !== undefined) virtualItemsByIndex.set(index, item);
  }
  const virtualItems = [...virtualItemsByIndex.values()].sort(
    (left, right) => left.index - right.index,
  );
  return (
    <div
      ref={containerRef}
      className="relative w-full"
      data-timeline-virtual-spacer=""
      onClickCapture={retainInteractedItem}
      onFocusCapture={retainInteractedItem}
    >
      {virtualItems.map((item) => {
        const isRealized = !fastScrolling || forcedIndexes.has(item.index);
        return renderItem(item.index, {
          isRealized,
          itemIndex: item.index,
          itemRef: virtualizer.measureElement,
          itemStyle: {
            position: "absolute",
            left: 0,
            width: "100%",
            ...(isRealized
              ? undefined
              : {
                  height: item.size,
                  minHeight: item.size,
                  overflow: "hidden",
                }),
          },
          windowingEnabled: true,
        });
      })}
    </div>
  );
}
