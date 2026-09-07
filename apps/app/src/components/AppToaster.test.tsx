// @vitest-environment jsdom

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { AppToaster } from "./AppToaster";
import { ArchivedThreadToastDescription } from "./thread/ArchivedThreadToastDescription";
import { AppToastContent } from "./ui/app-toast";

afterEach(() => {
  toast.dismiss();
  cleanup();
});

async function renderToaster(isCompactViewport: boolean) {
  render(
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <AppToaster position="bottom-right" />
    </CompactViewportOverrideProvider>,
  );

  act(() => {
    toast("Position test", { duration: Number.POSITIVE_INFINITY });
  });

  return waitFor(() => {
    const toaster = document.querySelector<HTMLElement>(
      "[data-sonner-toaster]",
    );
    expect(toaster).not.toBeNull();
    return toaster;
  });
}

function swipeToast(
  toastElement: HTMLElement,
  pointerId: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  pointerTarget: HTMLElement = toastElement,
  terminalEvent:
    | "lostPointerCapture"
    | "pointerCancel"
    | "pointerUp" = "pointerUp",
): void {
  Object.defineProperty(toastElement, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(pointerTarget, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  fireEvent.pointerDown(pointerTarget, {
    clientX: startX,
    clientY: startY,
    pointerId,
    pointerType: "touch",
  });
  fireEvent.pointerMove(pointerTarget, {
    clientX: endX,
    clientY: endY,
    pointerId,
    pointerType: "touch",
  });
  const terminalEventInit = {
    clientX: endX,
    clientY: endY,
    pointerId,
    pointerType: "touch",
  };
  if (terminalEvent === "pointerCancel") {
    fireEvent.pointerCancel(pointerTarget, terminalEventInit);
    return;
  }
  if (terminalEvent === "lostPointerCapture") {
    fireEvent.lostPointerCapture(pointerTarget, terminalEventInit);
    return;
  }
  fireEvent.pointerUp(pointerTarget, terminalEventInit);
}

describe("AppToaster", () => {
  it("places compact viewport toasts at the top center", async () => {
    const toaster = await renderToaster(true);
    expect(toaster?.getAttribute("data-x-position")).toBe("center");
    expect(toaster?.getAttribute("data-y-position")).toBe("top");
    expect(toaster?.style.getPropertyValue("--offset-top")).toBe(
      "calc(env(safe-area-inset-top) + var(--bb-app-chrome-row-height) + 16px)",
    );
    expect(toaster?.style.getPropertyValue("--mobile-offset-top")).toBe(
      "calc(env(safe-area-inset-top) + var(--bb-app-chrome-row-height) + 16px)",
    );
  });

  it("preserves the configured desktop toast position", async () => {
    const toaster = await renderToaster(false);
    expect(toaster?.getAttribute("data-x-position")).toBe("right");
    expect(toaster?.getAttribute("data-y-position")).toBe("bottom");
  });

  it.each([
    ["left", 200, 120],
    ["right", 120, 200],
  ] as const)(
    "dismisses a compact toast to the %s",
    async (_name, startX, endX) => {
      await renderToaster(true);
      const toastElement = document.querySelector<HTMLElement>(
        "[data-sonner-toast]",
      );
      expect(toastElement).not.toBeNull();
      if (toastElement === null) {
        return;
      }

      swipeToast(toastElement, 1, startX, 100, endX, 100);

      await waitFor(() => {
        expect(document.querySelector("[data-sonner-toast]")).toBeNull();
      });
    },
  );

  it("keeps a downward drag onscreen", async () => {
    await renderToaster(true);
    const toastElement = document.querySelector<HTMLElement>(
      "[data-sonner-toast]",
    );
    expect(toastElement).not.toBeNull();
    if (toastElement === null) {
      return;
    }

    swipeToast(toastElement, 1, 160, 100, 160, 180);

    expect(document.querySelector("[data-sonner-toast]")).toBe(toastElement);
  });

  it.each([
    ["pointer cancellation", "pointerCancel"],
    ["pointer capture loss", "lostPointerCapture"],
  ] as const)("resets an interrupted swipe after %s", async (_, eventName) => {
    await renderToaster(true);
    const toastElement = document.querySelector<HTMLElement>(
      "[data-sonner-toast]",
    );
    expect(toastElement).not.toBeNull();
    if (toastElement === null) {
      return;
    }

    swipeToast(toastElement, 1, 120, 100, 132, 100, toastElement, eventName);

    await waitFor(() => {
      expect(toastElement.dataset.swiping).toBe("false");
      expect(toastElement.dataset.swiped).toBe("false");
      expect(toastElement.style.getPropertyValue("--swipe-amount-x")).toBe(
        "0px",
      );
      expect(toastElement.style.getPropertyValue("--swipe-amount-y")).toBe(
        "0px",
      );
    });

    act(() => {
      toast("Short-lived after interruption", {
        duration: 50,
        id: `short-after-${eventName}`,
      });
    });

    const findShortToast = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-sonner-toast]"),
      ).find(
        (element) => element.textContent === "Short-lived after interruption",
      );
    await waitFor(() => {
      expect(findShortToast()).toBeDefined();
    });
    await waitFor(
      () => {
        expect(findShortToast()).toBeUndefined();
      },
      { timeout: 1_000 },
    );
  });

  it("keeps movement continuous while Sonner's axis update is batched", async () => {
    await renderToaster(true);
    const toastElement = document.querySelector<HTMLElement>(
      "[data-sonner-toast]",
    );
    expect(toastElement).not.toBeNull();
    if (toastElement === null) {
      return;
    }
    Object.defineProperty(toastElement, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    fireEvent.pointerDown(toastElement, {
      clientX: 120,
      clientY: 100,
      pointerId: 1,
      pointerType: "touch",
    });
    const firstMove = createEvent.pointerMove(toastElement, {
      clientX: 129,
      clientY: 100,
      pointerId: 1,
      pointerType: "touch",
    });
    const secondMove = createEvent.pointerMove(toastElement, {
      clientX: 142,
      clientY: 100,
      pointerId: 1,
      pointerType: "touch",
    });

    act(() => {
      toastElement.dispatchEvent(firstMove);
      expect(toastElement.style.getPropertyValue("--swipe-amount-x")).toBe(
        "9px",
      );
      toastElement.dispatchEvent(secondMove);
      expect(toastElement.style.getPropertyValue("--swipe-amount-x")).toBe(
        "22px",
      );
    });
  });

  it("keeps an archive title tappable but does not open it during a swipe", async () => {
    const onDismiss = vi.fn();
    const onOpenThread = vi.fn();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <AppToaster position="bottom-right" />
      </CompactViewportOverrideProvider>,
    );
    act(() => {
      toast.custom(
        (id) => (
          <AppToastContent
            cancel={{ label: "Undo", onClick: vi.fn() }}
            description={
              <ArchivedThreadToastDescription
                archivedThreadCount={1}
                onOpenThread={onOpenThread}
                threadTitle="Archive swipe target"
              />
            }
            id={id}
            title="Thread Archived"
            tone="success"
          />
        ),
        {
          className: "bb-app-toast",
          duration: Number.POSITIVE_INFINITY,
          id: "archive-swipe-test",
          onDismiss,
        },
      );
    });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(1);
    });
    const toastElement = document.querySelector<HTMLElement>(
      "[data-sonner-toast]",
    );
    const threadTitle = document.querySelector<HTMLButtonElement>(
      'button[title="Archive swipe target"]',
    );
    expect(toastElement).not.toBeNull();
    expect(threadTitle).not.toBeNull();
    if (toastElement === null || threadTitle === null) {
      return;
    }

    swipeToast(toastElement, 1, 120, 100, 120, 100, threadTitle);
    fireEvent.click(threadTitle);
    expect(onOpenThread).toHaveBeenCalledOnce();
    onOpenThread.mockClear();

    swipeToast(toastElement, 2, 120, 100, 200, 100, threadTitle);
    fireEvent.click(threadTitle);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpenThread).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    });
  });

  it("keeps stacked toast identity during rapid swipes", async () => {
    const onDismissA = vi.fn();
    const onDismissB = vi.fn();
    const onDismissC = vi.fn();
    render(
      <CompactViewportOverrideProvider isCompactViewport>
        <AppToaster position="bottom-right" />
      </CompactViewportOverrideProvider>,
    );
    act(() => {
      toast("Stack A", {
        duration: Number.POSITIVE_INFINITY,
        id: "stack-a",
        onDismiss: onDismissA,
      });
      toast("Stack B", {
        duration: Number.POSITIVE_INFINITY,
        id: "stack-b",
        onDismiss: onDismissB,
      });
      toast("Stack C", {
        duration: Number.POSITIVE_INFINITY,
        id: "stack-c",
        onDismiss: onDismissC,
      });
    });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(3);
    });
    const toastElements = Array.from(
      document.querySelectorAll<HTMLElement>("[data-sonner-toast]"),
    );
    const toastB = toastElements.find(
      (toastElement) => toastElement.textContent === "Stack B",
    );
    const toastC = toastElements.find(
      (toastElement) => toastElement.textContent === "Stack C",
    );
    expect(toastB).toBeDefined();
    expect(toastC).toBeDefined();
    if (toastB === undefined || toastC === undefined) {
      return;
    }

    swipeToast(toastC, 1, 120, 100, 200, 100);
    swipeToast(toastB, 2, 200, 100, 120, 100);

    expect(onDismissC).toHaveBeenCalledOnce();
    expect(onDismissB).toHaveBeenCalledOnce();
    expect(onDismissA).not.toHaveBeenCalled();
  });
});
