import { useEffect, useState, type RefObject } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";

export const SCROLL_FOOTER_ATTRIBUTE = "data-scroll-footer";
const STICKY_FOOTER_FLEX_ATTRIBUTE = "data-sticky-footer-flex";

export function useStickyFooterAvailableHeight(
  ref: RefObject<HTMLElement | null>,
): number | null {
  const bottomAnchor = useBottomAnchoredScroll();
  const getScrollElement = bottomAnchor?.getScrollElement ?? null;
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    const scrollElement = getScrollElement?.() ?? null;
    const footer = element?.closest<HTMLElement>(
      `[${SCROLL_FOOTER_ATTRIBUTE}]`,
    );
    if (!element || !scrollElement || !footer) {
      setAvailableHeight(null);
      return;
    }
    element.setAttribute(STICKY_FOOTER_FLEX_ATTRIBUTE, "");
    const measure = () => {
      const flexElements = footer.querySelectorAll<HTMLElement>(
        `[${STICKY_FOOTER_FLEX_ATTRIBUTE}]`,
      );
      let flexHeight = 0;
      for (const flexElement of flexElements) {
        flexHeight += flexElement.offsetHeight;
      }
      const fixedHeight = footer.offsetHeight - flexHeight;
      const shared = Math.max(0, scrollElement.clientHeight - fixedHeight);
      const next = Math.floor(shared / Math.max(1, flexElements.length));
      setAvailableHeight((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollElement);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      element.removeAttribute(STICKY_FOOTER_FLEX_ATTRIBUTE);
    };
  }, [getScrollElement, ref]);

  return availableHeight;
}
