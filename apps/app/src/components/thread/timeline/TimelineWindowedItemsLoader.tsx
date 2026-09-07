import {
  createContext,
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from "react";

const DEFAULT_WINDOWING_MIN_ITEM_COUNT = 20;
const MAX_CONTROL_PATH_MEASUREMENTS = 2_000;
const NOOP_ITEM_REF = () => {};

export interface TimelineWindowingScrollRoot {
  getScrollElement: () => HTMLElement | null;
}

export const TimelineWindowingScrollRootContext =
  createContext<TimelineWindowingScrollRoot | null>(null);

export const TimelineWindowingMeasurementsContext = createContext<Map<
  string,
  number
> | null>(null);

export interface TimelineWindowedItemRenderState {
  isRealized: boolean;
  itemIndex: number | undefined;
  itemRef: (node: HTMLDivElement | null) => void;
  itemStyle: CSSProperties | undefined;
  windowingEnabled: boolean;
}

export interface TimelineWindowedItemsProps {
  enabled: boolean;
  alwaysMountedKeys?: ReadonlySet<string>;
  estimateItemHeight: (index: number) => number;
  gap: number;
  getScrollElement: (() => HTMLElement | null) | null;
  itemKeys: readonly string[];
  measurements: Map<string, number>;
  minItemCount?: number;
  renderItem: (
    index: number,
    state: TimelineWindowedItemRenderState,
  ) => ReactNode;
}

const LazyTimelineWindowedItems = lazy(async () => {
  const module = await import("./TimelineWindowedItems.js");
  return { default: module.TimelineWindowedItems };
});

function TimelineWindowedItemsControl({
  itemKeys,
  measurements,
  renderItem,
  captureMeasurements = false,
}: TimelineWindowedItemsProps & { captureMeasurements?: boolean }) {
  return itemKeys.map((key, index) =>
    renderItem(index, {
      isRealized: true,
      itemIndex: captureMeasurements ? index : undefined,
      itemRef: captureMeasurements
        ? (element) => {
            if (element === null) return;
            const height = element.getBoundingClientRect().height;
            if (height <= 0) return;
            measurements.delete(key);
            measurements.set(key, height);
            while (measurements.size > MAX_CONTROL_PATH_MEASUREMENTS) {
              const oldestKey = measurements.keys().next().value;
              if (oldestKey === undefined) break;
              measurements.delete(oldestKey);
            }
          }
        : NOOP_ITEM_REF,
      itemStyle: undefined,
      windowingEnabled: false,
    }),
  );
}

export function TimelineWindowedItemsLoader(props: TimelineWindowedItemsProps) {
  const configured =
    props.enabled &&
    props.getScrollElement !== null &&
    props.itemKeys.length >=
      (props.minItemCount ?? DEFAULT_WINDOWING_MIN_ITEM_COUNT);
  if (!configured) return <TimelineWindowedItemsControl {...props} />;
  return (
    <Suspense
      fallback={<TimelineWindowedItemsControl {...props} captureMeasurements />}
    >
      <LazyTimelineWindowedItems {...props} />
    </Suspense>
  );
}
