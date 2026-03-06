import {
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  DEFAULT_SCROLL_STICK_THRESHOLD_PX,
  getScrollAnimationBehavior,
} from "@beanbag/ui-core";
import {
  createLatestInitialExpandedState,
  reduceLatestInitialExpandedState,
} from "@/lib/latestInitialExpanded";

export const EVENT_DETAIL_MAX_HEIGHT_CLASS = "max-h-[220px]";
export const EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS = "max-h-[320px]";
export const DEBUG_EVENT_EXPANDED_MAX_LENGTH = 4000;

export function OngoingEventLabel({ text }: { text: string }) {
  return <span className="animate-shine">{text}</span>;
}

export function renderShimmeringSummary(text: string, shouldShimmer: boolean): ReactNode {
  if (!shouldShimmer) return text;
  return <OngoingEventLabel text={text} />;
}

export function useLatestInitialExpanded(initialExpanded: boolean): {
  isExpanded: boolean;
  onToggle: () => void;
} {
  const [state, dispatch] = useReducer(
    reduceLatestInitialExpandedState,
    initialExpanded,
    createLatestInitialExpandedState,
  );

  useEffect(() => {
    dispatch({ type: "sync", initialExpanded });
  }, [initialExpanded]);

  const onToggle = () => {
    dispatch({ type: "toggle" });
  };

  return { isExpanded: state.isExpanded, onToggle };
}

function isScrolledNearBottom(
  element: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop">,
): boolean {
  const maxScrollOffset = element.scrollHeight - element.clientHeight;
  if (maxScrollOffset <= DEFAULT_SCROLL_STICK_THRESHOLD_PX) {
    return true;
  }
  const distanceFromBottom = maxScrollOffset - element.scrollTop;
  return distanceFromBottom <= DEFAULT_SCROLL_STICK_THRESHOLD_PX;
}

export function useStickyBottomAutoScroll<ElementType extends HTMLElement>({
  isExpanded,
  scrollDep,
}: {
  isExpanded: boolean;
  scrollDep: unknown;
}) {
  const elementRef = useRef<ElementType | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) return;
    shouldStickToBottomRef.current = true;
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded || !shouldStickToBottomRef.current) return;
    const element = elementRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: getScrollAnimationBehavior(),
    });
  }, [isExpanded, scrollDep]);

  const handleScroll = () => {
    const element = elementRef.current;
    if (!element) return;
    shouldStickToBottomRef.current = isScrolledNearBottom(element);
  };

  return { elementRef, handleScroll };
}
