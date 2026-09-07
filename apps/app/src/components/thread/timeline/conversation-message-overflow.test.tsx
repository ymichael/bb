// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useOverflowMeasurement } from "./conversation-message-overflow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function OverflowProbe({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const measurement = useOverflowMeasurement({
    elementRef: ref,
    enabled: true,
    measurementKey: name,
  });
  return <div ref={ref} data-testid={name} data-measurement={measurement} />;
}

describe("useOverflowMeasurement", () => {
  it("shares one observer and batches measurements for all rows", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    const constructorSpy = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          constructorSpy();
          observerCallback = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === "first" ? 80 : 20;
      });
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(20);
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(20);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(20);

    render(
      <>
        <OverflowProbe name="first" />
        <OverflowProbe name="second" />
      </>,
    );

    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");
    expect(first.dataset.measurement).toBe("unmeasured");
    expect(second.dataset.measurement).toBe("unmeasured");
    expect(scrollHeight).not.toHaveBeenCalled();
    expect(clientHeight).not.toHaveBeenCalled();
    expect(scrollWidth).not.toHaveBeenCalled();
    expect(clientWidth).not.toHaveBeenCalled();

    act(() => {
      observerCallback?.(
        [
          { target: first } as unknown as ResizeObserverEntry,
          { target: second } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });

    expect(constructorSpy).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(scrollHeight).toHaveBeenCalledTimes(2);
    expect(clientHeight).toHaveBeenCalledTimes(2);
    expect(scrollWidth).toHaveBeenCalledOnce();
    expect(clientWidth).toHaveBeenCalledOnce();
    expect(first.dataset.measurement).toBe("overflowing");
    expect(second.dataset.measurement).toBe("fits");
  });
});
