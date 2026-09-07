// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS,
  ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS,
  useDelayedBusyIndicator,
} from "./route-navigation-indicator";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ busy }: { busy: boolean }) {
  const visible = useDelayedBusyIndicator(busy);
  return <div data-testid="probe">{visible ? "visible" : "hidden"}</div>;
}

function state(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useDelayedBusyIndicator", () => {
  it("stays hidden for navigations that resolve before the reveal delay", () => {
    vi.useFakeTimers();
    const view = render(<Probe busy />);

    advance(ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS - 20);
    expect(state()).toBe("hidden");

    view.rerender(<Probe busy={false} />);
    advance(1000);
    expect(state()).toBe("hidden");
  });

  it("reveals once a navigation outlasts the delay", () => {
    vi.useFakeTimers();
    render(<Probe busy />);

    expect(state()).toBe("hidden");
    advance(ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS);
    expect(state()).toBe("visible");
  });

  it("holds the revealed indicator long enough to avoid a flash", () => {
    vi.useFakeTimers();
    const view = render(<Probe busy />);

    advance(ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS);
    expect(state()).toBe("visible");

    view.rerender(<Probe busy={false} />);
    advance(ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS - 20);
    expect(state()).toBe("visible");

    advance(40);
    expect(state()).toBe("hidden");
  });

  it("hides immediately when the minimum visible window already elapsed", () => {
    vi.useFakeTimers();
    const view = render(<Probe busy />);

    advance(ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS);
    advance(ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS + 100);
    expect(state()).toBe("visible");

    view.rerender(<Probe busy={false} />);
    advance(0);
    expect(state()).toBe("hidden");
  });
});
