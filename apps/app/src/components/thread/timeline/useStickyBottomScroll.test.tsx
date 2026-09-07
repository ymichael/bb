// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStickyBottomScroll } from "./useStickyBottomScroll";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function StickyScrollProbe({ contentKey }: { contentKey: string }) {
  const sticky = useStickyBottomScroll<HTMLDivElement>({
    contentKey,
    streaming: true,
  });
  return (
    <div
      ref={sticky.ref}
      data-testid="scroll"
      onScroll={sticky.onScroll}
      onWheel={sticky.onWheel}
    >
      <div ref={sticky.contentRef} data-testid="content" />
    </div>
  );
}

describe("useStickyBottomScroll", () => {
  it("uses a cached maximum offset in the scroll handler", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { getByTestId, rerender } = render(
      <StickyScrollProbe contentKey="first" />,
    );
    const scroll = getByTestId("scroll");
    let layoutReads = 0;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      scrollHeight: {
        configurable: true,
        get: () => {
          layoutReads += 1;
          return 120;
        },
      },
      clientHeight: {
        configurable: true,
        get: () => {
          layoutReads += 1;
          return 20;
        },
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    rerender(<StickyScrollProbe contentKey="second" />);
    expect(scrollTop).toBe(100);
    layoutReads = 0;

    scrollTop = 20;
    fireEvent.wheel(scroll);
    fireEvent.scroll(scroll);

    expect(layoutReads).toBe(0);
    rerender(<StickyScrollProbe contentKey="third" />);
    expect(scrollTop).toBe(20);
  });

  it("refreshes the cached maximum when only the content grows", () => {
    const observed: Element[] = [];
    let fireResize: (() => void) | undefined;
    class StubResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        fireResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    const { getByTestId, rerender } = render(
      <StickyScrollProbe contentKey="first" />,
    );
    const scroll = getByTestId("scroll");
    expect(observed).toContain(scroll);
    expect(observed).toContain(getByTestId("content"));

    let scrollHeight = 120;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      scrollHeight: {
        configurable: true,
        get: () => scrollHeight,
      },
      clientHeight: {
        configurable: true,
        get: () => 20,
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      scrollTo: {
        configurable: true,
        value: (options: ScrollToOptions) => {
          scrollTop = options.top ?? 0;
        },
      },
    });

    rerender(<StickyScrollProbe contentKey="second" />);
    expect(scrollTop).toBe(100);

    scrollTop = 40;
    fireEvent.wheel(scroll);
    fireEvent.scroll(scroll);

    scrollHeight = 220;
    fireResize?.();
    scrollTop = 100;
    fireEvent.wheel(scroll);
    fireEvent.scroll(scroll);
    rerender(<StickyScrollProbe contentKey="third" />);
    expect(scrollTop).toBe(100);

    scrollTop = 200;
    fireEvent.scroll(scroll);
    scrollHeight = 260;
    rerender(<StickyScrollProbe contentKey="fourth" />);
    expect(scrollTop).toBe(240);
  });
});
