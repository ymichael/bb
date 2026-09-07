// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadQueuedMessage } from "@bb/domain";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import { QueuedMessagesList } from "./QueuedMessagesList";

const noop = () => {};

function makeQueuedMessage(id: string, text: string): ThreadQueuedMessage {
  return makeThreadQueuedMessage({
    id,
    threadId: "thr_queue",
    content: [{ type: "text", text, mentions: [] }],
  });
}

function rect({ top, bottom }: { top: number; bottom: number }) {
  return new DOMRect(0, top, 100, bottom - top);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("QueuedMessagesList group-handle drag", () => {
  it("drags the zero-height group handle to a measured row stroke", async () => {
    const onSetGroupBoundary = vi.fn();
    const queuedMessages = [
      makeQueuedMessage("q_one", "First queued message"),
      makeQueuedMessage("q_two", "Second queued message"),
      makeQueuedMessage("q_three", "Third queued message"),
    ];
    const { container, getByLabelText } = render(
      <QueuedMessagesList
        attachedToComposer={true}
        queuedMessages={queuedMessages}
        sendAction="send-now"
        sendDisabled={false}
        actionDisabled={false}
        processingMessageId={null}
        processingAction={null}
        onSend={noop}
        onReorder={noop}
        onSetGroupBoundary={onSetGroupBoundary}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    const rows = container.querySelectorAll<HTMLElement>(
      "[data-queued-message-row]",
    );
    const divider = container.querySelector<HTMLElement>(
      "[data-queued-message-group-divider]",
    );
    const list = container.querySelector<HTMLElement>("ul");
    const scroll = container.querySelector<HTMLElement>(
      "[data-queued-messages-scroll]",
    );
    expect(divider).not.toBeNull();
    expect(list).not.toBeNull();
    expect(scroll).not.toBeNull();

    const measuredRects = [
      rect({ top: 0, bottom: 40 }),
      rect({ top: 40, bottom: 72 }),
      rect({ top: 72, bottom: 112 }),
    ];
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => measuredRects[index]!;
    });
    divider!.getBoundingClientRect = () => rect({ top: 40, bottom: 40 });
    list!.getBoundingClientRect = () => rect({ top: 0, bottom: 116 });
    scroll!.getBoundingClientRect = () => rect({ top: 0, bottom: 160 });

    const handle = getByLabelText("Messages above send together");
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 50,
      clientY: 40,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(document, {
      clientX: 50,
      clientY: 46,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerMove(document, {
      clientX: 50,
      clientY: 108,
      isPrimary: true,
      pointerId: 1,
    });
    fireEvent.pointerUp(document, {
      clientX: 50,
      clientY: 108,
      isPrimary: true,
      pointerId: 1,
    });

    await waitFor(() =>
      expect(onSetGroupBoundary).toHaveBeenCalledWith({
        expectedGroupedPrefixQueuedMessageIds: ["q_one", "q_two", "q_three"],
        groupBoundaryQueuedMessageId: "q_three",
      }),
    );
  });
});
