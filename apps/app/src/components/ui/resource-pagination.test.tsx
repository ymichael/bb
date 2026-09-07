// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import {
  useResourceInfiniteItems,
  useResourcePagination,
  useResourceViewportPageSize,
} from "@bb/shared-ui/resource-pagination";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROWS = Array.from({ length: 30 }, (_, index) => index + 1);
const SELECTABLE_PAGES = [0, 1, 2];

function Probe({
  pageSize,
  resetKey,
  rowCount = ROWS.length,
}: {
  pageSize: number;
  resetKey?: string;
  rowCount?: number;
}) {
  const pagination = useResourcePagination(ROWS.slice(0, rowCount), {
    pageSize,
    resetKey,
  });
  return (
    <>
      <span data-testid="page">{pagination.page}</span>
      <span data-testid="rows">{pagination.items.join(",")}</span>
      {SELECTABLE_PAGES.map((page) => (
        <button
          key={page}
          type="button"
          onClick={() => pagination.setPage(page)}
        >
          {`go to ${page}`}
        </button>
      ))}
    </>
  );
}

function InfiniteProbe({
  pageSize,
  resetKey,
}: {
  pageSize: number;
  resetKey?: string;
}) {
  const infinite = useResourceInfiniteItems(ROWS, { pageSize, resetKey });
  return (
    <>
      <span data-testid="rows">{infinite.items.join(",")}</span>
      <button type="button" onClick={infinite.loadMore}>
        load more
      </button>
    </>
  );
}

function selectedPage(): number {
  return Number(screen.getByTestId("page").textContent);
}

function visibleRows(): number[] {
  const rows = screen.getByTestId("rows").textContent ?? "";
  return rows === "" ? [] : rows.split(",").map(Number);
}

function loadMore(): void {
  fireEvent.click(screen.getByRole("button", { name: "load more" }));
}

function goToPage(page: number): void {
  fireEvent.click(screen.getByRole("button", { name: `go to ${page}` }));
}

afterEach(() => {
  cleanup();
});

describe("useResourcePagination", () => {
  it("rescales the selection across page-size changes instead of overwriting it", () => {
    const { rerender } = render(<Probe pageSize={10} />);
    goToPage(1);
    expect(visibleRows()).toEqual(ROWS.slice(10, 20));

    rerender(<Probe pageSize={15} />);
    expect(selectedPage()).toBe(0);
    expect(visibleRows()).toEqual(ROWS.slice(0, 15));

    rerender(<Probe pageSize={10} />);
    expect(selectedPage()).toBe(1);
    expect(visibleRows()).toEqual(ROWS.slice(10, 20));
  });

  it("resets to the first page for each new projection", () => {
    const { rerender } = render(<Probe pageSize={10} resetKey="all" />);
    goToPage(2);
    expect(selectedPage()).toBe(2);

    rerender(<Probe pageSize={10} resetKey="filtered" />);
    expect(selectedPage()).toBe(0);

    rerender(<Probe pageSize={10} resetKey="all" />);
    expect(selectedPage()).toBe(0);
  });

  it("clamps the page when live data shrinks past it", () => {
    const { rerender } = render(<Probe pageSize={10} />);
    goToPage(2);
    expect(visibleRows()).toEqual(ROWS.slice(20, 30));

    rerender(<Probe pageSize={10} rowCount={12} />);
    expect(selectedPage()).toBe(1);
    expect(visibleRows()).toEqual(ROWS.slice(10, 12));
  });
});

describe("useResourceInfiniteItems", () => {
  it("keeps already-loaded rows visible when the measured page size shrinks", () => {
    const { rerender } = render(<InfiniteProbe pageSize={10} />);
    loadMore();
    expect(visibleRows()).toEqual(ROWS.slice(0, 20));

    rerender(<InfiniteProbe pageSize={5} />);
    expect(visibleRows()).toEqual(ROWS.slice(0, 20));

    loadMore();
    expect(visibleRows()).toEqual(ROWS.slice(0, 25));
  });

  it("resets to one page's worth for each new projection", () => {
    const { rerender } = render(<InfiniteProbe pageSize={10} resetKey="all" />);
    loadMore();
    expect(visibleRows()).toEqual(ROWS.slice(0, 20));

    rerender(<InfiniteProbe pageSize={10} resetKey="filtered" />);
    expect(visibleRows()).toEqual(ROWS.slice(0, 10));
  });
});

const VIEWPORT_HEIGHT = 220;
const NARROW_VIEWPORT_WIDTH = 600;
const WIDE_VIEWPORT_WIDTH = 900;
const SHORT_ROW_HEIGHT = 40;
const TALL_ROW_HEIGHT = 110;
const TALL_ROW_INDEX = 3;
const SHORT_ROW_PAGE_SIZE = Math.floor(VIEWPORT_HEIGHT / SHORT_ROW_HEIGHT);
const TALL_ROW_PAGE_SIZE = Math.floor(VIEWPORT_HEIGHT / TALL_ROW_HEIGHT);
const MEASUREMENT_LIMIT = 12;

let rowMeasurements = 0;

function stubSize(node: HTMLElement, height: number, width: number): void {
  Object.defineProperty(node, "clientHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(node, "clientWidth", {
    configurable: true,
    value: width,
  });
  node.getBoundingClientRect = () => {
    rowMeasurements += 1;
    return {
      height,
      width,
      top: 0,
      bottom: height,
      left: 0,
      right: width,
    } as DOMRect;
  };
}

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  static emit(): void {
    for (const instance of TestResizeObserver.instances) {
      instance.callback([], instance);
    }
  }
}

function ViewportProbe({
  measured,
  resetKey,
  tallRow = true,
  viewportWidth = NARROW_VIEWPORT_WIDTH,
}: {
  measured: number[];
  resetKey?: string;
  tallRow?: boolean;
  viewportWidth?: number;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const pageSize = useResourceViewportPageSize(viewport, {
    fallbackPageSize: SHORT_ROW_PAGE_SIZE,
    resetKey,
  });
  measured.push(pageSize);
  const rowCount = measured.length > MEASUREMENT_LIMIT ? 1 : pageSize;

  return (
    <div
      ref={(node) => {
        if (node !== null) stubSize(node, VIEWPORT_HEIGHT, viewportWidth);
        setViewport(node);
      }}
    >
      <div data-resource-list-panel="" data-testid="panel">
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            key={index}
            data-resource-row=""
            ref={(node) => {
              if (node === null) return;
              stubSize(
                node,
                index === TALL_ROW_INDEX && tallRow
                  ? TALL_ROW_HEIGHT
                  : SHORT_ROW_HEIGHT,
                viewportWidth,
              );
            }}
          />
        ))}
      </div>
    </div>
  );
}

async function settle(): Promise<void> {
  for (let frame = 0; frame < 6; frame += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("useResourceViewportPageSize", () => {
  beforeEach(() => {
    rowMeasurements = 0;
    TestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("settles instead of trading page sizes with the rows it measures", async () => {
    const measured: number[] = [];
    render(<ViewportProbe measured={measured} />);
    await settle();

    const changes = measured.filter(
      (value, index) => index > 0 && value !== measured[index - 1],
    );
    expect(changes.length).toBeLessThanOrEqual(1);
    expect(measured.at(-1)).toBe(TALL_ROW_PAGE_SIZE);
  });

  it("measures a new projection from its own rows", async () => {
    const measured: number[] = [];
    const { rerender } = render(
      <ViewportProbe measured={measured} resetKey="all" />,
    );
    await settle();
    expect(measured.at(-1)).toBe(TALL_ROW_PAGE_SIZE);

    rerender(
      <ViewportProbe measured={measured} resetKey="filtered" tallRow={false} />,
    );
    await settle();
    expect(measured.at(-1)).toBe(SHORT_ROW_PAGE_SIZE);
  });

  it("measures again when the viewport width changes", async () => {
    const measured: number[] = [];
    const { rerender } = render(<ViewportProbe measured={measured} />);
    await settle();
    expect(measured.at(-1)).toBe(TALL_ROW_PAGE_SIZE);

    rerender(
      <ViewportProbe
        measured={measured}
        tallRow={false}
        viewportWidth={WIDE_VIEWPORT_WIDTH}
      />,
    );
    await act(async () => {
      TestResizeObserver.emit();
    });
    await settle();
    expect(measured.at(-1)).toBe(SHORT_ROW_PAGE_SIZE);
  });

  it("measures once per frame however many mutations arrive", async () => {
    const measured: number[] = [];
    render(<ViewportProbe measured={measured} tallRow={false} />);
    await settle();
    const rowCount = screen.getAllByTestId("panel")[0].childElementCount;
    rowMeasurements = 0;

    await act(async () => {
      for (let mutation = 0; mutation < 4; mutation += 1) {
        const marker = document.createElement("span");
        screen.getByTestId("panel").appendChild(marker);
        marker.remove();
        await Promise.resolve();
      }
    });
    await settle();

    expect(rowMeasurements).toBe(rowCount);
  });
});
