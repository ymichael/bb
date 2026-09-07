import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./button";
import { Icon } from "./icon";
import { cn } from "../../lib/utils";

export const RESOURCE_LIST_PAGE_SIZE = 10;
export const RESOURCE_GRID_PAGE_SIZE = 12;

interface ResourcePaginationOptions {
  pageSize?: number;
  resetKey?: string;
}

interface ResourcePaginationResult<Item> {
  items: readonly Item[];
  page: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  setPage: (page: number) => void;
}

interface ResourceViewportPageSizeOptions {
  fallbackPageSize?: number;
  resetKey?: string;
}

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ResourceViewportMeasurement {
  pageSize: number;
  rowHeight: number;
}

function measureResourceViewportPageSize(
  viewport: HTMLElement,
  fallbackPageSize: number,
  tallestRowHeight: number,
): ResourceViewportMeasurement {
  const availableHeight = viewport.clientHeight;
  const panel = viewport.querySelector<HTMLElement>(
    "[data-resource-list-panel]",
  );
  if (availableHeight <= 0 || panel === null) {
    return { pageSize: fallbackPageSize, rowHeight: tallestRowHeight };
  }

  const rowHeights = Array.from(
    panel.querySelectorAll<HTMLElement>("[data-resource-row]"),
    (row) => row.getBoundingClientRect().height,
  ).filter((height) => Number.isFinite(height) && height > 0);
  if (rowHeights.length === 0) {
    return { pageSize: fallbackPageSize, rowHeight: tallestRowHeight };
  }

  const panelStyle = panel.ownerDocument.defaultView?.getComputedStyle(panel);
  const panelChromeHeight = panelStyle
    ? cssPixelValue(panelStyle.paddingTop) +
      cssPixelValue(panelStyle.paddingBottom) +
      cssPixelValue(panelStyle.borderTopWidth) +
      cssPixelValue(panelStyle.borderBottomWidth)
    : 0;
  const rowHeight = Math.max(tallestRowHeight, ...rowHeights);
  return {
    pageSize: Math.max(
      1,
      Math.floor((availableHeight - panelChromeHeight) / rowHeight),
    ),
    rowHeight,
  };
}

export function useResourceViewportPageSize(
  viewport: HTMLElement | null,
  options: ResourceViewportPageSizeOptions = {},
): number {
  const fallbackPageSize = Math.max(
    1,
    Math.floor(options.fallbackPageSize ?? RESOURCE_LIST_PAGE_SIZE),
  );
  const resetKey = options.resetKey ?? "";
  const [pageSize, setPageSize] = useState(fallbackPageSize);

  useEffect(() => {
    if (viewport === null) return;
    const viewportElement = viewport;

    let observedPanel: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let tallestRowHeight = 0;
    let measuredWidth = viewportElement.clientWidth;
    let scheduledFrame: number | null = null;

    function observeCurrentPanel() {
      const panel = viewportElement.querySelector<HTMLElement>(
        "[data-resource-list-panel]",
      );
      if (panel === observedPanel) return;
      if (observedPanel !== null) resizeObserver?.unobserve(observedPanel);
      observedPanel = panel;
      if (observedPanel !== null) resizeObserver?.observe(observedPanel);
    }

    function measure() {
      observeCurrentPanel();
      const width = viewportElement.clientWidth;
      if (width !== measuredWidth) {
        measuredWidth = width;
        tallestRowHeight = 0;
      }
      const measurement = measureResourceViewportPageSize(
        viewportElement,
        fallbackPageSize,
        tallestRowHeight,
      );
      tallestRowHeight = measurement.rowHeight;
      setPageSize((current) =>
        current === measurement.pageSize ? current : measurement.pageSize,
      );
    }

    function scheduleMeasure() {
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      if (scheduledFrame !== null) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        measure();
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(viewportElement);
    }
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(scheduleMeasure);
    mutationObserver?.observe(viewportElement, {
      childList: true,
      subtree: true,
    });
    measure();

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (
        scheduledFrame !== null &&
        typeof cancelAnimationFrame === "function"
      ) {
        cancelAnimationFrame(scheduledFrame);
      }
    };
  }, [fallbackPageSize, resetKey, viewport]);

  return viewport === null ? fallbackPageSize : pageSize;
}

export function useResourcePagination<Item>(
  items: readonly Item[],
  options: ResourcePaginationOptions = {},
): ResourcePaginationResult<Item> {
  const pageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? RESOURCE_LIST_PAGE_SIZE),
  );
  const resetKey = options.resetKey ?? "";
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const [anchor, setAnchor] = useState({ resetKey, page: 0, pageSize });

  if (anchor.resetKey !== resetKey) {
    setAnchor({ resetKey, page: 0, pageSize });
  }

  const requestedPage =
    anchor.resetKey !== resetKey
      ? 0
      : anchor.pageSize === pageSize
        ? anchor.page
        : Math.floor((anchor.page * anchor.pageSize) / pageSize);
  const page = Math.min(requestedPage, pageCount - 1);

  const setPage = useCallback(
    (nextPage: number) => {
      setAnchor({
        resetKey,
        page: Math.max(0, Math.min(Math.floor(nextPage), pageCount - 1)),
        pageSize,
      });
    },
    [pageCount, pageSize, resetKey],
  );
  const paginatedItems = useMemo(() => {
    const start = page * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  return {
    items: paginatedItems,
    page,
    pageSize,
    total: items.length,
    visibleCount: paginatedItems.length,
    setPage,
  };
}

interface ResourceInfiniteItemsResult<Item> {
  items: readonly Item[];
  total: number;
  hasMore: boolean;
  loadMore: () => void;
}

export function useResourceInfiniteItems<Item>(
  items: readonly Item[],
  options: ResourcePaginationOptions = {},
): ResourceInfiniteItemsResult<Item> {
  const pageSize = Math.max(
    1,
    Math.floor(options.pageSize ?? RESOURCE_LIST_PAGE_SIZE),
  );
  const resetKey = options.resetKey ?? "";
  const [anchor, setAnchor] = useState({ resetKey, loadedCount: 0 });
  if (anchor.resetKey !== resetKey) {
    setAnchor({ resetKey, loadedCount: 0 });
  }
  const loadedCount = anchor.resetKey === resetKey ? anchor.loadedCount : 0;
  const visibleCount = Math.max(pageSize, loadedCount);
  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  );
  const hasMore = items.length > visibleItems.length;
  const loadMore = useCallback(() => {
    setAnchor((current) => ({
      resetKey,
      loadedCount:
        (current.resetKey === resetKey
          ? Math.max(pageSize, current.loadedCount)
          : pageSize) + pageSize,
    }));
  }, [pageSize, resetKey]);
  return { items: visibleItems, total: items.length, hasMore, loadMore };
}

export function ResourceInfiniteScrollSentinel({
  hasMore,
  loading = false,
  onLoadMore,
  className,
}: {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const element = ref.current;
    if (
      element === null ||
      !hasMore ||
      loading ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const root = element.closest(
      "[data-resource-collection-scroll], [data-infinite-scroll-root]",
    );
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      {
        root: root instanceof HTMLElement ? root : null,
        rootMargin: "240px 0px",
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  if (!hasMore && !loading) return null;
  return (
    <div
      ref={ref}
      data-resource-infinite-sentinel
      className={cn("flex items-center justify-center py-3", className)}
    >
      {loading ? (
        <span
          className="text-xs text-subtle-foreground"
          role="status"
          aria-live="polite"
        >
          Loading more…
        </span>
      ) : null}
    </div>
  );
}

function scrollToResults(scrollTargetId: string | undefined): void {
  if (
    scrollTargetId === undefined ||
    typeof requestAnimationFrame !== "function"
  ) {
    return;
  }
  requestAnimationFrame(() => {
    const target = document.getElementById(scrollTargetId);
    if (target === null) return;
    target.scrollTo?.({ top: 0, behavior: "instant" });
  });
}

export function ResourcePagination({
  page,
  pageSize,
  total,
  visibleCount,
  onPageChange,
  scrollTargetId,
  summary,
  ariaLabel = "Results pagination",
}: {
  page: number;
  pageSize: number;
  total: number;
  visibleCount: number;
  onPageChange: (page: number) => void;
  scrollTargetId?: string;
  summary?: ReactNode;
  ariaLabel?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;

  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const firstItem = safePage * pageSize + 1;
  const lastItem = Math.min(firstItem + visibleCount - 1, total);
  const changePage = (nextPage: number) => {
    onPageChange(nextPage);
    scrollToResults(scrollTargetId);
  };

  return (
    <nav
      aria-label={ariaLabel}
      className="flex flex-wrap items-center justify-between gap-2 px-1"
    >
      <span className="text-xs text-subtle-foreground">
        {summary ?? `${firstItem}–${lastItem} of ${total}`}
      </span>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={safePage === 0}
          onClick={() => changePage(safePage - 1)}
        >
          <Icon name="ChevronLeft" aria-hidden />
          Previous
        </Button>
        <span className="min-w-24 text-center text-xs text-muted-foreground">
          Page {safePage + 1} of {pageCount}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={safePage >= pageCount - 1}
          onClick={() => changePage(safePage + 1)}
        >
          Next
          <Icon name="ChevronRight" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
