import { useLayoutEffect, useRef, type ReactNode } from "react";
import { OverflowFade } from "@/components/ui/overflow-fade";
import {
  MOBILE_RECENT_LABEL_HEIGHT_PX,
  MOBILE_RECENT_ROW_HEIGHT_PX,
} from "./RootComposeMobileRecents";

const COMPACT_HOME_CHROME_OFFSET_PX = 56;
const COMPACT_HOME_COLUMN_CLASS = "mx-auto w-full max-w-[760px] px-4";
const COMPACT_HOME_REST_VISIBLE_ROWS = 4.5;
const COMPACT_HOME_SCROLLED_VISIBLE_ROWS = 5.5;
const COMPACT_HOME_SCROLLED_BAND_PX =
  COMPACT_HOME_SCROLLED_VISIBLE_ROWS * MOBILE_RECENT_ROW_HEIGHT_PX +
  MOBILE_RECENT_LABEL_HEIGHT_PX;
const COMPACT_HOME_REST_OFFSET_PX =
  (COMPACT_HOME_SCROLLED_VISIBLE_ROWS - COMPACT_HOME_REST_VISIBLE_ROWS) *
  MOBILE_RECENT_ROW_HEIGHT_PX;

export function getCompactHomeScrollViewportTop({
  regionHeight,
  composerHeight,
}: {
  regionHeight: number;
  composerHeight: number;
}): number {
  return Math.max(
    COMPACT_HOME_CHROME_OFFSET_PX,
    regionHeight - composerHeight - COMPACT_HOME_SCROLLED_BAND_PX,
  );
}

interface RootComposeCompactHomeProps {
  children: ReactNode;
  composer: ReactNode;
}

function useCompactHomeMetrics() {
  const regionRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const region = regionRef.current;
    const composer = composerRef.current;
    const scrollViewport = scrollViewportRef.current;
    const bottomSpacer = bottomSpacerRef.current;
    if (!region || !composer || !scrollViewport || !bottomSpacer) return;
    const measure = () => {
      const composerHeight = composer.offsetHeight;
      scrollViewport.style.top = `${getCompactHomeScrollViewportTop({
        regionHeight: region.offsetHeight,
        composerHeight,
      })}px`;
      bottomSpacer.style.height = `${composerHeight}px`;
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  return { regionRef, composerRef, scrollViewportRef, bottomSpacerRef };
}

export function RootComposeCompactHome({
  children,
  composer,
}: RootComposeCompactHomeProps) {
  const { regionRef, composerRef, scrollViewportRef, bottomSpacerRef } =
    useCompactHomeMetrics();

  return (
    <div
      ref={regionRef}
      data-testid="root-compose-compact-home"
      className="relative min-h-0 flex-1"
    >
      <div
        ref={scrollViewportRef}
        data-testid="root-compose-compact-scroll-viewport"
        className="absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain"
        style={{ top: COMPACT_HOME_CHROME_OFFSET_PX }}
      >
        <div
          aria-hidden
          data-testid="root-compose-compact-recents-offset"
          style={{ height: COMPACT_HOME_REST_OFFSET_PX }}
        />
        <div className={COMPACT_HOME_COLUMN_CLASS}>{children}</div>
        <div ref={bottomSpacerRef} aria-hidden />
      </div>
      <div
        ref={composerRef}
        data-testid="root-compose-compact-composer"
        className="absolute inset-x-0 bottom-0 z-10"
      >
        <OverflowFade placement="above" tone="background" size="lg" />
        <div className="bg-background pb-4">
          <div className={COMPACT_HOME_COLUMN_CLASS}>{composer}</div>
        </div>
      </div>
    </div>
  );
}
