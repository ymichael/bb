// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useContext, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadQueuedMessage } from "@bb/domain";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import type { Active, DroppableContainer } from "@dnd-kit/core";
import {
  QueuedMessagesList as QueuedMessagesListComponent,
  clampQueuedMessageDragTransform,
  getInlineEditorSurfaceMaxHeight,
  queuedMessageCollisionDetection,
  queuedMessageSortingStrategy,
  resolveQueuedMessageDrag,
  snapGroupBoundaryDragTransform,
  type QueuedMessagesListProps,
} from "./QueuedMessagesList";
import {
  QueuedEditorTypeaheadLayoutContext,
  type QueuedEditorTypeaheadLayout,
} from "@/components/promptbox/queued-editor-typeahead-layout";

const bottomAnchorMocks = vi.hoisted(() => ({
  scrollElement: null as HTMLElement | null,
}));

function QueuedMessagesList({
  attachedToComposer = true,
  sendAction = "send-now",
  ...props
}: Omit<QueuedMessagesListProps, "attachedToComposer" | "sendAction"> & {
  attachedToComposer?: boolean;
  sendAction?: QueuedMessagesListProps["sendAction"];
}) {
  return (
    <QueuedMessagesListComponent
      {...props}
      attachedToComposer={attachedToComposer}
      sendAction={sendAction}
    />
  );
}

vi.mock("@/components/ui/bottom-anchored-scroll-body", () => ({
  useBottomAnchoredScroll: () =>
    bottomAnchorMocks.scrollElement === null
      ? null
      : {
          getScrollElement: () => bottomAnchorMocks.scrollElement,
        },
}));

const noop = () => {};

function TypeaheadLayoutFixture({
  layout,
}: {
  layout: QueuedEditorTypeaheadLayout;
}) {
  const reportLayout = useContext(QueuedEditorTypeaheadLayoutContext);
  useLayoutEffect(() => {
    reportLayout?.(layout);
  }, [layout, reportLayout]);
  return <div>Inline editor</div>;
}

function makeQueuedMessage(id: string, text: string): ThreadQueuedMessage {
  return makeThreadQueuedMessage({
    id,
    threadId: "thr_prompt_pills",
    content: [{ type: "text", text, mentions: [] }],
  });
}

function makeQueuedFileMessage(id: string, name: string): ThreadQueuedMessage {
  return {
    ...makeQueuedMessage(id, ""),
    content: [
      {
        type: "localFile",
        path: `/tmp/${name}`,
        name,
      },
    ],
  };
}

function makeGroupedQueuedMessages(): ThreadQueuedMessage[] {
  return [
    {
      ...makeQueuedMessage("q_one", "First queued message"),
      groupWithNext: true,
    },
    makeQueuedMessage("q_two", "Second queued message"),
    makeQueuedMessage("q_three", "Third queued message"),
  ];
}

function rect({ top, bottom }: { top: number; bottom: number }) {
  return new DOMRect(0, top, 100, bottom - top);
}

function renderQueuedMessages(
  queuedMessages: readonly ThreadQueuedMessage[],
  attachedToComposer = true,
) {
  return render(
    <QueuedMessagesList
      attachedToComposer={attachedToComposer}
      queuedMessages={queuedMessages}
      sendDisabled={false}
      actionDisabled={false}
      processingMessageId={null}
      processingAction={null}
      onSend={noop}
      onReorder={noop}
      onSetGroupBoundary={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
}

function renderQueuedMessagesWithOptions(
  queuedMessages: readonly ThreadQueuedMessage[],
  options: Pick<Parameters<typeof QueuedMessagesList>[0], "resolveMentionLink">,
) {
  return render(
    <QueuedMessagesList
      attachedToComposer={true}
      queuedMessages={queuedMessages}
      resolveMentionLink={options.resolveMentionLink}
      sendDisabled={false}
      actionDisabled={false}
      processingMessageId={null}
      processingAction={null}
      onSend={noop}
      onReorder={noop}
      onSetGroupBoundary={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
}

afterEach(() => {
  cleanup();
  bottomAnchorMocks.scrollElement = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("QueuedMessagesList", () => {
  it("renders as a standalone card when it is not attached to the composer", () => {
    const { container } = renderQueuedMessages(
      [makeQueuedMessage("q_one", "First queued message")],
      false,
    );
    const surface = container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    );

    expect(surface?.classList.contains("mb-0")).toBe(true);
    expect(surface?.classList.contains("-mb-5")).toBe(false);
    expect(surface?.classList.contains("rounded-b-none")).toBe(false);
    expect(surface?.classList.contains("border-b-0")).toBe(false);
  });

  it("toggles a few messages between the fitted drawer and collapsed modes", () => {
    const { container, getByRole, getByText } = renderQueuedMessages([
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
    ]);
    const header = container.querySelector<HTMLElement>(
      "[data-queued-messages-mode]",
    );
    const surface = container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    );

    expect(getByText("Queue")).not.toBeNull();
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("drawer");
    expect(surface?.style.height).toBe("121px");
    expect(
      getByRole("button", { name: "Collapse queued messages" }).querySelector(
        '[data-icon="ChevronDown"]',
      ),
    ).not.toBeNull();

    fireEvent.click(getByRole("button", { name: "Collapse queued messages" }));
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("collapsed");
    expect(
      getByRole("button", { name: "Show queued messages" }).querySelector(
        '[data-icon="ChevronUp"]',
      ),
    ).not.toBeNull();
    expect(surface?.style.height).toBe("44px");

    fireEvent.click(getByRole("button", { name: "Show queued messages" }));
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("drawer");
    expect(surface?.style.height).toBe("121px");
  });

  it("gives a row that renders a wait line room for it", () => {
    const plain = renderQueuedMessages([
      makeQueuedMessage("q_one", "First queued message"),
    ]);
    const plainHeight = plain.container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    )?.style.height;
    cleanup();

    const waiting = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_one", "First queued message"),
        waitingOn: {
          kind: "plugin",
          pluginId: "provider-retry",
          reason: "Rate limited",
        },
        sendAt: Date.now() + 60_000,
      },
    ]);
    const waitingHeight = waiting.container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    )?.style.height;

    expect(plainHeight).toBe("88px");
    expect(waitingHeight).toBe("104px");
  });

  it("toggles an overflowing queue between the workspace and collapsed modes", () => {
    const { container, getByRole } = renderQueuedMessages(
      Array.from({ length: 5 }, (_, index) =>
        makeQueuedMessage(`q_${index}`, `Queued message ${index + 1}`),
      ),
    );
    const header = container.querySelector<HTMLElement>(
      "[data-queued-messages-mode]",
    );

    expect(header?.getAttribute("data-queued-messages-mode")).toBe("drawer");
    fireEvent.click(getByRole("button", { name: "Expand queued messages" }));
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("workspace");
    fireEvent.click(getByRole("button", { name: "Collapse queued messages" }));
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("collapsed");
    fireEvent.click(getByRole("button", { name: "Expand queued messages" }));
    expect(header?.getAttribute("data-queued-messages-mode")).toBe("workspace");
  });

  it("opens the fitted drawer when a queued message arrives while collapsed", async () => {
    const sharedProps = {
      sendDisabled: false,
      actionDisabled: false,
      processingMessageId: null,
      processingAction: null,
      onSend: noop,
      onReorder: noop,
      onSetGroupBoundary: noop,
      onEdit: noop,
      onDelete: noop,
    } as const;
    const firstMessage = makeQueuedMessage("q_one", "First queued message");
    const { container, getByRole, rerender } = render(
      <QueuedMessagesList {...sharedProps} queuedMessages={[firstMessage]} />,
    );

    fireEvent.click(getByRole("button", { name: "Collapse queued messages" }));
    expect(
      container
        .querySelector("[data-queued-messages-mode]")
        ?.getAttribute("data-queued-messages-mode"),
    ).toBe("collapsed");

    rerender(
      <QueuedMessagesList
        {...sharedProps}
        queuedMessages={[
          firstMessage,
          makeQueuedMessage("q_two", "Second queued message"),
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        container
          .querySelector("[data-queued-messages-mode]")
          ?.getAttribute("data-queued-messages-mode"),
      ).toBe("drawer");
    });
  });

  it("moves through all three modes with the header drag handle", () => {
    const { container, getByRole } = renderQueuedMessages([
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
    ]);
    const handle = getByRole("button", {
      name: "Drag up to open the queue workspace",
    });
    Object.defineProperty(handle, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });

    fireEvent.pointerDown(handle, {
      button: 0,
      clientY: 200,
      pointerId: 1,
    });
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 100, pointerId: 1 });

    expect(
      container
        .querySelector("[data-queued-messages-mode]")
        ?.getAttribute("data-queued-messages-mode"),
    ).toBe("workspace");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientY: 100,
      pointerId: 2,
    });
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(handle, { clientY: 200, pointerId: 2 });

    expect(
      container
        .querySelector("[data-queued-messages-mode]")
        ?.getAttribute("data-queued-messages-mode"),
    ).toBe("drawer");

    fireEvent.pointerDown(handle, {
      button: 0,
      clientY: 100,
      pointerId: 3,
    });
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 3 });
    fireEvent.pointerUp(handle, { clientY: 200, pointerId: 3 });

    expect(
      container
        .querySelector("[data-queued-messages-mode]")
        ?.getAttribute("data-queued-messages-mode"),
    ).toBe("collapsed");
  });

  it("uses labeled hover-revealed icon actions on desktop and an overflow menu on mobile widths", async () => {
    const { container, findByRole, getByRole, queryByRole } =
      renderQueuedMessages([
        makeQueuedMessage("q_one", "First queued message"),
      ]);

    const sendButton = getByRole("button", {
      name: "Send queued message 1 now",
    });
    const editButton = getByRole("button", {
      name: "Edit queued message 1",
    });
    const deleteButton = getByRole("button", {
      name: "Delete queued message 1",
    });

    expect(
      getByRole("button", { name: "Queued message 1 actions" }),
    ).toBeTruthy();
    expect(editButton).toBeTruthy();
    expect(deleteButton).toBeTruthy();
    expect(container.querySelector('[data-icon="Sent"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="Edit"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="Trash2"]')).not.toBeNull();
    expect(
      container.querySelector('[data-icon="MoreHorizontal"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-icon="DragDropVertical"]'),
    ).not.toBeNull();

    for (const [button, label] of [
      [sendButton, "Send now"],
      [editButton, "Edit"],
      [deleteButton, "Delete"],
    ] as const) {
      fireEvent.focus(button);
      expect((await findByRole("tooltip")).textContent).toBe(label);
      fireEvent.blur(button);
      await waitFor(() => {
        expect(queryByRole("tooltip")).toBeNull();
      });
    }
  });

  it("replaces the edited row with the real inline composer", () => {
    const onDismiss = vi.fn();
    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
    ];

    const { container, getByRole, getByText, getByTestId } = render(
      <QueuedMessagesList
        queuedMessages={queuedMessages}
        inlineEditor={{
          queuedMessageId: "q_two",
          queuedMessageIndex: 0,
          content: <div data-testid="inline-queue-editor">Inline editor</div>,
          onDismiss,
        }}
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(
      container.querySelector("[data-queued-message-inline-editor]"),
    ).not.toBeNull();
    const inlineEditorSlot = container.querySelector(
      "[data-queued-message-inline-editor]",
    );
    expect(
      inlineEditorSlot?.querySelector(
        '[data-overflow-fade="above"][data-overflow-fade-tone="surface-raised"]',
      ),
    ).not.toBeNull();
    expect(
      inlineEditorSlot?.querySelector(
        '[data-overflow-fade="below"][data-overflow-fade-tone="surface-raised"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("First queued message");
    expect(container.textContent).not.toContain("Second queued message");
    const queueItems = container.querySelectorAll("ul > li");
    expect(queueItems[0]?.textContent).toContain("First queued message");
    expect(
      Array.from(queueItems).some((item) =>
        item.hasAttribute("data-queued-message-inline-editor"),
      ),
    ).toBe(true);
    const editingLabel = getByText(/Editing queued message/u);
    expect(
      editingLabel.closest('[data-inline-message-editor-frame="embedded"]'),
    ).not.toBeNull();
    expect(getByTestId("inline-queue-editor")).toBeTruthy();

    fireEvent.click(
      getByRole("button", { name: "Stop editing queued message" }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps an active inline editor usable when the queue is empty", async () => {
    const { container } = render(
      <QueuedMessagesList
        queuedMessages={[]}
        inlineEditor={{
          queuedMessageId: "q_missing",
          queuedMessageIndex: 0,
          content: <div>Inline editor</div>,
          onDismiss: noop,
        }}
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    await waitFor(() => {
      expect(
        container
          .querySelector("[data-queued-messages-mode]")
          ?.getAttribute("data-queued-messages-mode"),
      ).toBe("workspace");
    });

    const scrollFrame = container.querySelector(
      "[data-queued-messages-scroll-frame]",
    );
    expect(scrollFrame?.hasAttribute("inert")).toBe(false);
    expect(scrollFrame?.getAttribute("aria-hidden")).not.toBe("true");
  });

  it("returns to the fitted drawer height after inline editing ends", async () => {
    const queuedMessages = Array.from({ length: 4 }, (_, index) =>
      makeQueuedMessage(`q_${index}`, `Queued message ${index + 1}`),
    );
    const sharedProps = {
      queuedMessages,
      sendDisabled: false,
      actionDisabled: false,
      processingMessageId: null,
      processingAction: null,
      onSend: noop,
      onReorder: noop,
      onSetGroupBoundary: noop,
      onEdit: noop,
      onDelete: noop,
    } as const;
    const { container, rerender } = render(
      <QueuedMessagesList
        {...sharedProps}
        inlineEditor={{
          queuedMessageId: "q_0",
          queuedMessageIndex: 0,
          content: <div>Inline editor</div>,
          onDismiss: noop,
        }}
      />,
    );
    const surface = container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    );

    expect(surface?.style.height).toBe("240px");

    rerender(<QueuedMessagesList {...sharedProps} />);

    await waitFor(() => {
      expect(
        container
          .querySelector("[data-queued-messages-mode]")
          ?.getAttribute("data-queued-messages-mode"),
      ).toBe("drawer");
      expect(surface?.style.height).toBe("174px");
    });
  });

  it("keeps an explicitly collapsed inline editor collapsed after dismissal", async () => {
    const onDismiss = vi.fn();
    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
    ];
    const sharedProps = {
      queuedMessages,
      sendDisabled: false,
      actionDisabled: false,
      processingMessageId: null,
      processingAction: null,
      onSend: noop,
      onReorder: noop,
      onSetGroupBoundary: noop,
      onEdit: noop,
      onDelete: noop,
    } as const;
    const { container, getByRole, rerender } = render(
      <QueuedMessagesList
        {...sharedProps}
        inlineEditor={{
          queuedMessageId: "q_one",
          queuedMessageIndex: 0,
          content: <div>Inline editor</div>,
          onDismiss,
        }}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Collapse queued messages" }));
    expect(onDismiss).toHaveBeenCalledOnce();

    rerender(<QueuedMessagesList {...sharedProps} />);

    await waitFor(() => {
      expect(
        container
          .querySelector("[data-queued-messages-mode]")
          ?.getAttribute("data-queued-messages-mode"),
      ).toBe("collapsed");
    });
  });

  it("fits edit mode above the real composer at constrained heights and restores the drawer", async () => {
    const viewport = document.createElement("div");
    Object.defineProperty(viewport, "clientHeight", { value: 320 });
    bottomAnchorMocks.scrollElement = viewport;

    const nativeGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-queue-test-footer")) {
          return new DOMRect(0, 0, 600, 420);
        }
        if (this.getAttribute("aria-label") === "Queued messages") {
          return new DOMRect(0, 0, 600, 240);
        }
        return nativeGetBoundingClientRect.call(this);
      },
    );

    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
    ];
    const sharedProps = {
      queuedMessages,
      sendDisabled: false,
      actionDisabled: false,
      processingMessageId: null,
      processingAction: null,
      onSend: noop,
      onReorder: noop,
      onSetGroupBoundary: noop,
      onEdit: noop,
      onDelete: noop,
    } as const;
    const renderSurface = (editing: boolean) => (
      <div data-queue-test-footer="">
        <div data-app-composer="">
          <QueuedMessagesList
            {...sharedProps}
            inlineEditor={
              editing
                ? {
                    queuedMessageId: "q_one",
                    queuedMessageIndex: 0,
                    content: <div>Inline editor</div>,
                    onDismiss: noop,
                  }
                : undefined
            }
          />
          <div data-test-bottom-composer="">Bottom composer</div>
        </div>
      </div>
    );
    const { container, rerender } = render(renderSurface(true));
    const surface = container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    );
    const composer = container.querySelector("[data-test-bottom-composer]");

    await waitFor(() => expect(surface?.style.height).toBe("140px"));
    expect(surface?.compareDocumentPosition(composer as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    rerender(renderSurface(false));

    await waitFor(() => {
      expect(surface?.style.height).toBe("121px");
      expect(
        container
          .querySelector("[data-queued-messages-mode]")
          ?.getAttribute("data-queued-messages-mode"),
      ).toBe("drawer");
    });
  });

  it("grows edit mode to fit the measured editor and its immediate neighbors", async () => {
    const viewport = document.createElement("div");
    Object.defineProperty(viewport, "clientHeight", { value: 500 });
    bottomAnchorMocks.scrollElement = viewport;

    const nativeGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-queue-test-footer")) {
          return new DOMRect(0, 0, 600, 340);
        }
        if (this.getAttribute("aria-label") === "Queued messages") {
          return new DOMRect(0, 0, 600, 240);
        }
        if (this.hasAttribute("data-queued-messages-scroll")) {
          return new DOMRect(0, 32, 600, 180);
        }
        if (this.hasAttribute("data-queued-message-inline-editor")) {
          return new DOMRect(0, 112, 600, 130);
        }
        if (this.hasAttribute("data-queued-message-row")) {
          if (this.textContent?.includes("Previous queued message")) {
            return new DOMRect(0, 32, 600, 80);
          }
          if (this.textContent?.includes("Following queued message")) {
            return new DOMRect(0, 242, 600, 90);
          }
        }
        return nativeGetBoundingClientRect.call(this);
      },
    );

    const queuedMessages = [
      makeQueuedMessage("q_previous", "Previous queued message"),
      makeQueuedMessage("q_editing", "Edited queued message"),
      makeQueuedMessage("q_following", "Following queued message"),
    ];
    const { container } = render(
      <div data-queue-test-footer="">
        <div data-app-composer="">
          <QueuedMessagesList
            queuedMessages={queuedMessages}
            inlineEditor={{
              queuedMessageId: "q_editing",
              queuedMessageIndex: 1,
              content: <div>Inline editor</div>,
              onDismiss: noop,
            }}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            processingAction={null}
            onSend={noop}
            onReorder={noop}
            onSetGroupBoundary={noop}
            onEdit={noop}
            onDelete={noop}
          />
          <div>Bottom composer</div>
        </div>
      </div>,
    );
    const surface = container.querySelector<HTMLElement>(
      'section[aria-label="Queued messages"]',
    );

    await waitFor(() => expect(surface?.style.height).toBe("360px"));
  });

  it("realigns both neighbors as the edit surface finishes growing", async () => {
    let notifyResize = noop;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const viewport = document.createElement("div");
    Object.defineProperty(viewport, "clientHeight", { value: 500 });
    bottomAnchorMocks.scrollElement = viewport;

    let queueViewportBottom = 180;
    const nativeGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-queue-test-footer")) {
          return new DOMRect(0, 0, 600, 340);
        }
        if (this.getAttribute("aria-label") === "Queued messages") {
          return new DOMRect(0, 0, 600, 240);
        }
        if (this.hasAttribute("data-queued-messages-scroll")) {
          return new DOMRect(0, 32, 600, queueViewportBottom - 32);
        }
        const queueScrollTop =
          this.closest<HTMLElement>("[data-queued-messages-scroll]")
            ?.scrollTop ?? 0;
        if (this.hasAttribute("data-queued-message-inline-editor")) {
          return new DOMRect(0, 132 - queueScrollTop, 600, 180);
        }
        if (this.hasAttribute("data-queued-message-row")) {
          if (this.textContent?.includes("Previous queued message")) {
            return new DOMRect(0, 92 - queueScrollTop, 600, 40);
          }
          if (this.textContent?.includes("Following queued message")) {
            return new DOMRect(0, 312 - queueScrollTop, 600, 30);
          }
        }
        return nativeGetBoundingClientRect.call(this);
      },
    );

    const queuedMessages = [
      makeQueuedMessage("q_previous", "Previous queued message"),
      makeQueuedMessage("q_editing", "Edited queued message"),
      makeQueuedMessage("q_following", "Following queued message"),
    ];
    const { container } = render(
      <div data-queue-test-footer="">
        <div data-app-composer="">
          <QueuedMessagesList
            queuedMessages={queuedMessages}
            inlineEditor={{
              queuedMessageId: "q_editing",
              queuedMessageIndex: 1,
              content: <div>Inline editor</div>,
              onDismiss: noop,
            }}
            sendDisabled={false}
            actionDisabled={false}
            processingMessageId={null}
            processingAction={null}
            onSend={noop}
            onReorder={noop}
            onSetGroupBoundary={noop}
            onEdit={noop}
            onDelete={noop}
          />
          <div>Bottom composer</div>
        </div>
      </div>,
    );
    const scroll = container.querySelector<HTMLElement>(
      "[data-queued-messages-scroll]",
    );
    expect(scroll).not.toBeNull();
    if (!scroll) return;
    scroll.scrollTop = 100;

    act(() => notifyResize());
    expect(scroll.scrollTop).toBe(100);

    queueViewportBottom = 300;
    act(() => notifyResize());
    expect(scroll.scrollTop).toBe(60);
  });

  it.each([
    {
      label: "first",
      expectedScrollTop: 0,
      messages: [
        makeQueuedMessage("q_editing", "Edited queued message"),
        makeQueuedMessage("q_neighbor", "Following queued message"),
      ],
      editorTop: 32,
      neighborTop: 310,
    },
    {
      label: "last",
      expectedScrollTop: 80,
      messages: [
        makeQueuedMessage("q_neighbor", "Previous queued message"),
        makeQueuedMessage("q_editing", "Edited queued message"),
      ],
      editorTop: 112,
      neighborTop: 32,
    },
  ])(
    "reserves and scroll-aligns a $label queued editor in a constrained drawer",
    async ({ editorTop, expectedScrollTop, messages, neighborTop }) => {
      const viewport = document.createElement("div");
      Object.defineProperty(viewport, "clientHeight", { value: 500 });
      bottomAnchorMocks.scrollElement = viewport;

      const nativeGetBoundingClientRect =
        HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-queue-test-footer")) {
          return new DOMRect(0, 0, 600, 340);
        }
        if (this.getAttribute("aria-label") === "Queued messages") {
          return new DOMRect(0, 0, 600, 240);
        }
        if (this.hasAttribute("data-queued-messages-scroll")) {
          return new DOMRect(0, 32, 600, 180);
        }
        if (this.hasAttribute("data-queued-message-inline-editor")) {
          const scrollTop =
            this.closest<HTMLElement>("[data-queued-messages-scroll]")
              ?.scrollTop ?? 0;
          return new DOMRect(0, editorTop - scrollTop, 600, 278);
        }
        if (this.getAttribute("data-queued-message-id") === "q_neighbor") {
          const scrollTop =
            this.closest<HTMLElement>("[data-queued-messages-scroll]")
              ?.scrollTop ?? 0;
          return new DOMRect(0, neighborTop - scrollTop, 600, 80);
        }
        return nativeGetBoundingClientRect.call(this);
      });

      const { container } = render(
        <div data-queue-test-footer="">
          <div data-app-composer="">
            <QueuedMessagesList
              queuedMessages={messages}
              inlineEditor={{
                queuedMessageId: "q_editing",
                queuedMessageIndex: messages.findIndex(
                  (message) => message.id === "q_editing",
                ),
                content: (
                  <TypeaheadLayoutFixture
                    layout={{ height: 120, isOpen: true }}
                  />
                ),
                onDismiss: noop,
              }}
              sendDisabled={false}
              actionDisabled={false}
              processingMessageId={null}
              processingAction={null}
              onSend={noop}
              onReorder={noop}
              onSetGroupBoundary={noop}
              onEdit={noop}
              onDelete={noop}
            />
            <div>Bottom composer</div>
          </div>
        </div>,
      );
      const surface = container.querySelector<HTMLElement>(
        'section[aria-label="Queued messages"]',
      );
      const scroll = container.querySelector<HTMLElement>(
        "[data-queued-messages-scroll]",
      );

      await waitFor(() => expect(surface?.style.height).toBe("400px"));
      const reservation = container.querySelector<HTMLElement>(
        "[data-queued-editor-typeahead-reservation]",
      );
      if (!reservation) throw new Error("Expected typeahead reservation");
      expect(reservation?.style.paddingTop).toBe("128px");
      const editorFrame = reservation.closest(
        '[data-inline-message-editor-frame="embedded"]',
      );
      expect(editorFrame?.firstElementChild?.textContent).toContain(
        "Editing queued message",
      );
      expect(scroll?.scrollTop).toBe(expectedScrollTop);
    },
  );

  it("reserves the actual occupied composer and footer height", () => {
    expect(
      getInlineEditorSurfaceMaxHeight({
        containerHeight: 420,
        surfaceHeight: 240,
        viewportHeight: 320,
      }),
    ).toBe(140);
    expect(
      getInlineEditorSurfaceMaxHeight({
        containerHeight: 420,
        surfaceHeight: 240,
        viewportHeight: 200,
      }),
    ).toBe(44);
  });

  it("renders queued blockquote markdown as a compact quote preview", () => {
    const { container } = renderQueuedMessages([
      makeQueuedMessage(
        "q_quote",
        "> first quoted line\n> second quoted line\nreply underneath",
      ),
    ]);

    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("br")).toBeNull();
    expect(container.textContent?.replace(/\s+/gu, " ")).toContain(
      "first quoted line second quoted line reply underneath",
    );
    expect(container.textContent).not.toContain("> first quoted line");
  });

  it("renders queued markdown formatting instead of raw delimiters", () => {
    const { container } = renderQueuedMessages([
      makeQueuedMessage(
        "q_markdown",
        "## Heading\nReview **bold** and `code`.",
      ),
    ]);

    expect(container.querySelector("h2")).toBeNull();
    expect(container.textContent).toContain("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.textContent).not.toContain("## Heading");
    expect(container.textContent).not.toContain("**bold**");
    expect(container.textContent).not.toContain("`code`");
  });

  it("does not add hard-break elements for multi-line queued markdown", () => {
    const { container } = renderQueuedMessages([
      makeQueuedMessage("q_multiline", "first line\nsecond line"),
    ]);

    expect(container.querySelector("br")).toBeNull();
    expect(container.textContent?.replace(/\s+/gu, " ")).toContain(
      "first line second line",
    );
  });

  it("does not render full markdown preview controls in queued rows", () => {
    const { container, queryByLabelText } = renderQueuedMessages([
      makeQueuedMessage("q_code_block", "```ts\nconst value = 1;\n```"),
    ]);

    expect(queryByLabelText("Copy code")).toBeNull();
    expect(queryByLabelText("Wrap long lines")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain(
      "const value = 1;",
    );
  });

  it("flattens images and links in queued markdown previews", () => {
    const { container } = renderQueuedMessages([
      makeQueuedMessage(
        "q_media",
        "![Diagram](https://example.test/a.png) [docs](https://example.test)",
      ),
    ]);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a[href]")).toBeNull();
    expect(container.textContent).toContain("Diagram");
    expect(container.textContent).toContain("docs");
  });

  it("renders attachment-only fallback text literally", () => {
    const { container } = renderQueuedMessages([
      makeQueuedFileMessage("q_attachment", "[notes](https://example.test).md"),
    ]);

    expect(container.querySelector("a[href]")).toBeNull();
    expect(container.textContent).toContain(
      "Attachment only ([notes](https://example.test).md)",
    );
  });

  it("keeps attachment state visible while processing and counts multiple files", () => {
    const queuedMessage = makeQueuedMessage(
      "q_multiple_attachments",
      "Review both attached screenshots",
    );
    queuedMessage.content.push(
      {
        type: "localFile",
        path: "/tmp/first.png",
        name: "first.png",
      },
      {
        type: "localFile",
        path: "/tmp/second.png",
        name: "second.png",
      },
    );

    const { getByRole, getByText } = render(
      <QueuedMessagesList
        queuedMessages={[queuedMessage]}
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={queuedMessage.id}
        processingAction="send"
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    const attachment = getByRole("img", { name: "2 attachments" });
    expect(attachment.textContent).toBe("2");
    expect(getByText("Sending…")).not.toBeNull();
  });

  it("renders prompt mentions as pills in queued previews", () => {
    const text =
      "Run /goal and open @apps/app/src/foo.ts from @thread:thr_prompt_pills";
    const commandToken = "/goal";
    const pathToken = "@apps/app/src/foo.ts";
    const threadToken = "@thread:thr_prompt_pills";
    const commandStart = text.indexOf(commandToken);
    const pathStart = text.indexOf(pathToken);
    const threadStart = text.indexOf(threadToken);
    const openPath = vi.fn();

    const { container, getByText } = renderQueuedMessagesWithOptions(
      [
        {
          ...makeQueuedMessage("q_mentions", text),
          content: [
            {
              type: "text",
              text,
              mentions: [
                {
                  start: commandStart,
                  end: commandStart + commandToken.length,
                  resource: {
                    kind: "command",
                    trigger: "/",
                    name: "goal",
                    source: "command",
                    origin: "user",
                    label: "goal",
                    argumentHint: null,
                  },
                },
                {
                  start: pathStart,
                  end: pathStart + pathToken.length,
                  resource: {
                    kind: "path",
                    source: "workspace",
                    entryKind: "file",
                    path: "apps/app/src/foo.ts",
                    label: "foo.ts",
                  },
                },
                {
                  start: threadStart,
                  end: threadStart + threadToken.length,
                  resource: {
                    kind: "thread",
                    threadId: "thr_prompt_pills",
                    label: "Prompt pills QA",
                  },
                },
              ],
            },
          ],
        },
      ],
      {
        resolveMentionLink: (resource) =>
          resource.kind === "path" ? openPath : null,
      },
    );

    expect(container.querySelectorAll(".prompt-mention-pill")).toHaveLength(3);
    expect(container.querySelector('[data-icon="Target"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="File"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="UserRound"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="MessageSquare"]')).toBeNull();
    expect(container.textContent).toContain(
      "Run goal and open foo.ts from Prompt pills QA",
    );
    expect(container.textContent).not.toContain(commandToken);
    expect(container.textContent).not.toContain(pathToken);
    expect(container.textContent).not.toContain(threadToken);

    fireEvent.click(getByText("foo.ts"));

    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it("shows a bottom fade when the expanded queue overflows", async () => {
    const { container } = renderQueuedMessages(
      Array.from({ length: 8 }, (_, index) =>
        makeQueuedMessage(
          `q_${index}`,
          `Queued follow-up ${index}: check the compact scroll fade.`,
        ),
      ),
    );
    const scroll = container.querySelector<HTMLDivElement>(
      "[data-queued-messages-scroll]",
    );
    expect(scroll).not.toBeNull();
    if (!scroll) return;

    Object.defineProperty(scroll, "clientHeight", {
      configurable: true,
      value: 96,
    });
    Object.defineProperty(scroll, "scrollHeight", {
      configurable: true,
      value: 240,
    });
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    fireEvent.scroll(scroll);

    await waitFor(() => {
      const fade = container.querySelector(
        '[data-overflow-fade="below"][data-overflow-fade-tone="surface-raised"][data-overflow-fade-inset]',
      );
      expect(fade).not.toBeNull();
    });
  });

  it("renders the draggable group divider without filling grouped rows", () => {
    const { container, getByLabelText } = renderQueuedMessages(
      makeGroupedQueuedMessages(),
    );

    expect(getByLabelText("Messages above send together")).not.toBeNull();
    expect(container.textContent).not.toContain("grouped");
    expect(
      container.querySelectorAll("[data-queued-message-row]"),
    ).toHaveLength(3);
    expect(
      container.querySelector("[data-queued-message-group-fill]"),
    ).toBeNull();
    const divider = container.querySelector(
      "[data-queued-message-group-divider]",
    );
    expect(divider?.tagName).toBe("LI");
    expect(divider?.parentElement?.tagName).toBe("UL");
  });

  it("anchors a zero-height sortable handle sibling to the existing row border", () => {
    const { container } = renderQueuedMessages([
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
      makeQueuedMessage("q_three", "Third queued message"),
    ]);
    const rows = container.querySelectorAll("[data-queued-message-row]");

    const divider = container.querySelector(
      "ul > [data-queued-message-group-divider]",
    );
    expect(divider).not.toBeNull();
    expect(divider?.previousElementSibling).toBe(rows[0]);
    expect(rows[0]?.querySelector("[data-queued-message-group-divider]")).toBe(
      null,
    );
    expect(rows[1]?.querySelector("[data-queued-message-group-divider]")).toBe(
      null,
    );
    expect(container.querySelector("[data-queued-message-group-line]")).toBe(
      null,
    );
  });

  it("preserves grouping when reordering a row across the divider", () => {
    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
      makeQueuedMessage("q_three", "Third queued message"),
    ];

    const result = resolveQueuedMessageDrag({
      activeId: "q_three",
      overId: "q_one",
      combinedIds: [
        "q_one",
        "__queued_message_group_divider__",
        "q_two",
        "q_three",
      ],
      orderedMessages: queuedMessages,
    });

    expect(result).toMatchObject({
      kind: "row",
      request: {
        queuedMessageId: "q_three",
        previousQueuedMessageId: null,
        nextQueuedMessageId: "q_one",
      },
      orderedMessages: [
        { id: "q_three", groupWithNext: false },
        { id: "q_one", groupWithNext: false },
        { id: "q_two", groupWithNext: false },
      ],
    });
    if (result?.kind !== "row") {
      throw new Error("Expected row drag result");
    }
    expect(result.request.groupBoundaryQueuedMessageId).toBeUndefined();
  });

  it("updates grouping when dragging the divider", () => {
    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
      makeQueuedMessage("q_three", "Third queued message"),
    ];

    expect(
      resolveQueuedMessageDrag({
        activeId: "__queued_message_group_divider__",
        overId: "q_three",
        combinedIds: [
          "q_one",
          "__queued_message_group_divider__",
          "q_two",
          "q_three",
        ],
        orderedMessages: queuedMessages,
      }),
    ).toMatchObject({
      kind: "divider",
      request: {
        expectedGroupedPrefixQueuedMessageIds: ["q_one", "q_two", "q_three"],
        groupBoundaryQueuedMessageId: "q_three",
      },
      orderedMessages: [
        { id: "q_one", groupWithNext: true },
        { id: "q_two", groupWithNext: true },
        { id: "q_three", groupWithNext: false },
      ],
    });
  });

  it("clamps queued-message drags to the rendered list bottom", () => {
    expect(
      clampQueuedMessageDragTransform({
        draggingNodeRect: rect({ top: 24, bottom: 40 }),
        listRect: rect({ top: 0, bottom: 72 }),
        scrollRect: rect({ top: 0, bottom: 128 }),
        transform: { x: 12, y: 96, scaleX: 1, scaleY: 1 },
      }),
    ).toEqual({ x: 0, y: 32, scaleX: 1, scaleY: 1 });
  });

  it("snaps the group handle center to the hovered row stroke", () => {
    expect(
      snapGroupBoundaryDragTransform({
        activeId: "__queued_message_group_divider__",
        activeNodeRect: rect({ top: 28, bottom: 52 }),
        overId: "q_three",
        overRect: rect({ top: 72, bottom: 112 }),
        transform: { x: 8, y: 51, scaleX: 1, scaleY: 1 },
      }),
    ).toEqual({ x: 0, y: 72, scaleX: 1, scaleY: 1 });
  });

  it("keeps ordinary row drags continuous", () => {
    const transform = { x: 8, y: 51, scaleX: 1, scaleY: 1 };

    expect(
      snapGroupBoundaryDragTransform({
        activeId: "q_two",
        activeNodeRect: rect({ top: 28, bottom: 52 }),
        overId: "q_three",
        overRect: rect({ top: 72, bottom: 112 }),
        transform,
      }),
    ).toBe(transform);
  });

  it("lets the group handle leave its own collision target before snapping", () => {
    expect(
      snapGroupBoundaryDragTransform({
        activeId: "__queued_message_group_divider__",
        activeNodeRect: rect({ top: 28, bottom: 52 }),
        overId: "__queued_message_group_divider__",
        overRect: rect({ top: 28, bottom: 52 }),
        transform: { x: 8, y: 18, scaleX: 1, scaleY: 1 },
      }),
    ).toEqual({ x: 0, y: 18, scaleX: 1, scaleY: 1 });
  });

  it("chooses group-boundary targets from pointer distance to row strokes", () => {
    const makeContainer = (id: string): DroppableContainer => ({
      data: { current: undefined },
      disabled: false,
      id,
      key: id,
      node: { current: null },
      rect: { current: null },
    });
    const containers = [
      makeContainer("q_one"),
      makeContainer("__queued_message_group_divider__"),
      makeContainer("q_two"),
      makeContainer("q_three"),
    ];
    const collisions = queuedMessageCollisionDetection({
      active: {
        data: { current: undefined },
        id: "__queued_message_group_divider__",
        rect: { current: { initial: null, translated: null } },
      } satisfies Active,
      collisionRect: rect({ top: 28, bottom: 52 }),
      droppableContainers: containers,
      droppableRects: new Map([
        ["q_one", rect({ top: 0, bottom: 40 })],
        ["__queued_message_group_divider__", rect({ top: 28, bottom: 52 })],
        ["q_two", rect({ top: 40, bottom: 72 })],
        ["q_three", rect({ top: 72, bottom: 112 })],
      ]),
      pointerCoordinates: { x: 50, y: 75 },
    });

    expect(collisions.map((collision) => collision.id)).toEqual([
      "q_two",
      "q_one",
      "q_three",
    ]);
  });

  it("keeps message row geometry fixed while dragging the group handle", () => {
    const rects = [
      rect({ top: 0, bottom: 40 }),
      rect({ top: 40, bottom: 64 }),
      rect({ top: 64, bottom: 104 }),
    ];

    expect(
      queuedMessageSortingStrategy(
        ["q_one", "__queued_message_group_divider__", "q_two"],
        {
          activeNodeRect: rects[1]!,
          activeIndex: 1,
          index: 2,
          overIndex: 2,
          rects,
        },
      ),
    ).toBeNull();

    expect(
      queuedMessageSortingStrategy(
        ["q_one", "__queued_message_group_divider__", "q_two"],
        {
          activeNodeRect: rects[0]!,
          activeIndex: 0,
          index: 1,
          overIndex: 1,
          rects,
        },
      ),
    ).not.toBeNull();
  });

  it("re-adopts queued-message order from props when the same rows are restored", () => {
    const originalMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
      makeQueuedMessage("q_three", "Third queued message"),
    ];
    const { container, rerender } = renderQueuedMessages(originalMessages);

    rerender(
      <QueuedMessagesList
        queuedMessages={[
          originalMessages[1]!,
          originalMessages[0]!,
          originalMessages[2]!,
        ]}
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    expect(
      Array.from(container.querySelectorAll("[data-queued-message-row]")).map(
        (row) => row.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Second queued message"),
      expect.stringContaining("First queued message"),
      expect.stringContaining("Third queued message"),
    ]);

    rerender(
      <QueuedMessagesList
        queuedMessages={originalMessages}
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(
      Array.from(container.querySelectorAll("[data-queued-message-row]")).map(
        (row) => row.textContent,
      ),
    ).toEqual([
      expect.stringContaining("First queued message"),
      expect.stringContaining("Second queued message"),
      expect.stringContaining("Third queued message"),
    ]);
  });

  it("does not show a fade when stale observer entries report hidden sentinels without overflow", async () => {
    interface ObserverControl {
      targets: Element[];
      trigger(entries: readonly Partial<IntersectionObserverEntry>[]): void;
    }

    const observers: ObserverControl[] = [];

    class IntersectionObserverMock implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly scrollMargin = "";
      readonly thresholds = [0];
      readonly targets: Element[] = [];

      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }

      disconnect() {}

      observe(target: Element) {
        this.targets.push(target);
      }

      takeRecords() {
        return [];
      }

      trigger(entries: readonly Partial<IntersectionObserverEntry>[]) {
        this.callback(entries as IntersectionObserverEntry[], this);
      }

      unobserve() {}
    }

    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const { container } = renderQueuedMessages([
      makeQueuedMessage("q_one", "single queued message"),
    ]);
    const scroll = container.querySelector<HTMLDivElement>(
      "[data-queued-messages-scroll]",
    );
    expect(scroll).not.toBeNull();
    if (!scroll) return;

    Object.defineProperty(scroll, "clientHeight", {
      configurable: true,
      value: 48,
    });
    Object.defineProperty(scroll, "scrollHeight", {
      configurable: true,
      value: 48,
    });

    await waitFor(() => {
      expect(observers[0]?.targets).toHaveLength(2);
    });

    const currentObserver = observers[0];
    expect(currentObserver).toBeDefined();
    if (!currentObserver) return;

    const [topSentinel, bottomSentinel] = currentObserver.targets;
    expect(topSentinel).toBeDefined();
    expect(bottomSentinel).toBeDefined();
    if (!topSentinel || !bottomSentinel) return;

    act(() => {
      currentObserver.trigger([
        { target: topSentinel, isIntersecting: false },
        { target: bottomSentinel, isIntersecting: false },
      ]);
    });

    expect(container.querySelector('[data-overflow-fade="above"]')).toBeNull();
    expect(container.querySelector('[data-overflow-fade="below"]')).toBeNull();
  });
});

describe("queued row affordances", () => {
  it("explains the waits a reader cannot infer, and stays quiet otherwise", () => {
    const { getByText, queryByText, container } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_busy", "Ordinary queued"),
        waitingOn: { kind: "thread-busy" },
      },
      {
        ...makeQueuedMessage("q_prov", "Behind provisioning"),
        waitingOn: { kind: "provisioning" },
      },
      {
        ...makeQueuedMessage("q_plugin", "Held by a limiter"),
        waitingOn: {
          kind: "plugin",
          pluginId: "concurrency-limit",
          reason: "4 of 4 running",
        },
      },
    ]);

    expect(getByText("Waiting for workspace")).toBeDefined();
    expect(
      getByText("Held by concurrency-limit · 4 of 4 running"),
    ).toBeDefined();
    expect(queryByText("Waiting for the current turn")).toBeNull();
    expect(
      container.querySelectorAll("[data-queued-message-wait]"),
    ).toHaveLength(2);
  });

  it("hides Send now only where a re-attempt could not clear the wait", () => {
    const { queryByLabelText } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_busy", "Ordinary queued"),
        waitingOn: { kind: "thread-busy" },
      },
    ]);
    expect(queryByLabelText("Send queued message 1 now")).not.toBeNull();

    cleanup();
    const queued = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_wait", "Waiting on a reply"),
        waitingOn: { kind: "interaction" },
      },
    ]);
    expect(queued.queryByLabelText("Send queued message 1 now")).toBeNull();
  });

  it("offers to steer a provisioning row when the thread is ready", () => {
    const onSend = vi.fn();
    const { getByLabelText } = render(
      <QueuedMessagesList
        queuedMessages={[
          {
            ...makeQueuedMessage("q_provisioning", "Steer after startup"),
            waitingOn: { kind: "provisioning" },
          },
        ]}
        sendAction="steer-when-ready"
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={onSend}
        onReorder={noop}
        onSetGroupBoundary={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    fireEvent.click(getByLabelText("Steer queued message 1 when ready"));
    expect(onSend).toHaveBeenCalledWith("q_provisioning");
  });

  it("names the absent machine on a host-offline row and hides Send now", () => {
    const { getByText, queryByLabelText } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_offline", "Capture the Safari trace"),
        waitingOn: { kind: "host-offline", hostName: "M4" },
      },
    ]);
    expect(getByText("Waiting for M4 to reconnect")).toBeDefined();
    expect(queryByLabelText("Send queued message 1 now")).toBeNull();
  });

  it("lets a drain failure take over the line the wait would have used", () => {
    const { getByText, queryByText, container } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_failed", "Post the summary"),
        waitingOn: { kind: "provisioning" },
        failureReason: "Thread stopped before the message could dispatch",
      },
    ]);
    expect(
      getByText("Thread stopped before the message could dispatch"),
    ).toBeDefined();
    expect(queryByText("Waiting for workspace")).toBeNull();
    expect(
      container.querySelector("[data-queued-message-failed]"),
    ).not.toBeNull();
  });

  it("gives a retry row a title of its own when it has no message to show", () => {
    const { getByText } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_retry_title", ""),
        content: [
          {
            type: "text",
            text: "The original question",
            mentions: [],
            visibility: "agent-only",
          },
        ],
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req_1",
          attempt: 2,
          reason: "Rate limited",
        },
        editable: false,
        waitingOn: { kind: "time" },
        sendAt: 0,
      },
    ]);
    expect(getByText(/^Retry failed turn from /u)).toBeDefined();
    expect(
      getByText(/^Rate limited · retrying at .* · attempt 2$/u),
    ).toBeDefined();
  });

  it("offers no edit on a row the server says is not editable", () => {
    const { queryByLabelText } = renderQueuedMessages([
      {
        ...makeQueuedMessage("q_retry", ""),
        payload: {
          kind: "retry",
          retryOfTurnRequestId: "req_1",
          attempt: 2,
          reason: "Rate limited",
        },
        editable: false,
        waitingOn: { kind: "time" },
        sendAt: 0,
      },
    ]);
    expect(queryByLabelText("Edit queued message 1")).toBeNull();
    expect(queryByLabelText("Delete queued message 1")).not.toBeNull();
  });
});
