// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MULTI_CLICK_SELECTION_REPORT_DELAY_MS,
  SelectableMessageProse,
} from "./SelectableMessageProse.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeWindowSelection({
  commonAncestorContainer,
  focusNode,
  intersectsNode,
  node,
  text,
}: {
  commonAncestorContainer?: Node;
  focusNode?: Node;
  intersectsNode?: (node: Node) => boolean;
  node: Node;
  text: string;
}): Selection {
  const rect = new DOMRect(10, 20, 30, 8);
  const range = {
    commonAncestorContainer: commonAncestorContainer ?? node,
    getBoundingClientRect: () => rect,
    getClientRects: () => ({
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
    }),
    intersectsNode: intersectsNode ?? (() => true),
  } as unknown as Range;
  return {
    anchorNode: node,
    commonAncestorContainer: commonAncestorContainer ?? node,
    focusNode: focusNode ?? node,
    getRangeAt: () => range,
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
  } as unknown as Selection;
}

function mockWindowSelection(args: Parameters<typeof makeWindowSelection>[0]) {
  vi.spyOn(window, "getSelection").mockReturnValue(makeWindowSelection(args));
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

const SHARED_DOCUMENT_EVENT_TYPES = [
  "pointerdown",
  "pointerup",
  "pointercancel",
  "mouseup",
  "selectionchange",
  "keyup",
  "copy",
];

function countSharedListenerCalls(spy: {
  mock: { calls: readonly unknown[][] };
}): number {
  return spy.mock.calls.filter(
    ([type]) =>
      typeof type === "string" && SHARED_DOCUMENT_EVENT_TYPES.includes(type),
  ).length;
}

describe("SelectableMessageProse", () => {
  it("shares one set of document listeners across many mounted messages", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { rerender, unmount } = render(
      <SelectableMessageProse>First answer</SelectableMessageProse>,
    );
    const addsAfterFirstMount = countSharedListenerCalls(addSpy);

    rerender(
      <>
        <SelectableMessageProse>First answer</SelectableMessageProse>
        <SelectableMessageProse>Second answer</SelectableMessageProse>
        <SelectableMessageProse>Third answer</SelectableMessageProse>
      </>,
    );
    expect(countSharedListenerCalls(addSpy)).toBe(addsAfterFirstMount);

    unmount();
    expect(countSharedListenerCalls(removeSpy)).toBeGreaterThanOrEqual(
      SHARED_DOCUMENT_EVENT_TYPES.length,
    );
  });

  it("moves the reported selection between messages and clears the previous one", async () => {
    const onSelectFirst = vi.fn();
    const onSelectSecond = vi.fn();
    const { getByText } = render(
      <>
        <SelectableMessageProse onSelect={onSelectFirst}>
          First selectable answer
        </SelectableMessageProse>
        <SelectableMessageProse onSelect={onSelectSecond}>
          Second selectable answer
        </SelectableMessageProse>
      </>,
    );
    const firstTextNode = getByText("First selectable answer").firstChild;
    const secondTextNode = getByText("Second selectable answer").firstChild;
    expect(firstTextNode).not.toBeNull();
    expect(secondTextNode).not.toBeNull();

    mockWindowSelection({ node: firstTextNode!, text: "First selectable" });
    fireEvent.pointerDown(document);
    fireEvent.pointerUp(document);
    await waitFor(() =>
      expect(onSelectFirst).toHaveBeenCalledWith(
        expect.objectContaining({ text: "First selectable" }),
      ),
    );
    expect(onSelectSecond).not.toHaveBeenCalled();

    mockWindowSelection({ node: secondTextNode!, text: "Second selectable" });
    fireEvent.pointerDown(document);
    fireEvent.pointerUp(document);
    await waitFor(() =>
      expect(onSelectSecond).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Second selectable" }),
      ),
    );
    await waitFor(() => expect(onSelectFirst).toHaveBeenLastCalledWith(null));
  });

  it("keeps selectable prose available to the compact sidebar swipe gesture", () => {
    const { getByText } = render(
      <SelectableMessageProse>Selectable answer text</SelectableMessageProse>,
    );

    expect(
      getByText("Selectable answer text").closest(
        "[data-sidebar-swipe-selectable]",
      ),
    ).not.toBeNull();
    expect(
      getByText("Selectable answer text").closest("[data-no-sidebar-swipe]"),
    ).toBeNull();
  });

  it("reports a selection only after pointer release", async () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Selectable answer text
      </SelectableMessageProse>,
    );
    const textNode = getByText("Selectable answer text").firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({
      node: textNode!,
      text: "answer text",
    });

    fireEvent.pointerDown(document);
    fireEvent(document, new Event("selectionchange"));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.pointerUp(document);
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ text: "answer text" }),
      ),
    );
  });

  it("reports a touch long-press selection before pointer release", async () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Long press selectable answer text
      </SelectableMessageProse>,
    );
    const target = getByText("Long press selectable answer text");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({
      node: textNode!,
      text: "selectable",
    });

    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent(document, new Event("selectionchange"));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ text: "selectable" }),
      ),
    );
  });

  it("includes the pointer release point and side when a pointer selection starts in the message", async () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Selectable answer text
      </SelectableMessageProse>,
    );
    const target = getByText("Selectable answer text");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();
    mockWindowSelection({
      node: textNode!,
      text: "answer text",
    });

    fireEvent.pointerDown(target, { clientX: 12, clientY: 24 });
    fireEvent.pointerUp(document, { clientX: 42, clientY: 84 });

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorPoint: { x: 42, y: 84 },
          anchorSide: "bottom",
          text: "answer text",
        }),
      ),
    );
  });

  it("reports a selection that updates after pointer release", async () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Double click selectable answer text
      </SelectableMessageProse>,
    );
    const textNode = getByText(
      "Double click selectable answer text",
    ).firstChild;
    expect(textNode).not.toBeNull();

    fireEvent.pointerDown(document);
    fireEvent.pointerUp(document);
    await waitForAnimationFrame();
    expect(onSelect).not.toHaveBeenCalled();

    mockWindowSelection({
      node: textNode!,
      text: "selectable",
    });
    fireEvent(document, new Event("selectionchange"));

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ text: "selectable" }),
      ),
    );
  });

  it("reports double-click selections from the message click target", async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Double click target paragraph text
      </SelectableMessageProse>,
    );
    const target = getByText("Double click target paragraph text");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();

    mockWindowSelection({
      node: textNode!,
      text: "Double click target paragraph text",
    });
    fireEvent.doubleClick(target, { detail: 2 });

    await vi.advanceTimersByTimeAsync(
      MULTI_CLICK_SELECTION_REPORT_DELAY_MS - 1,
    );
    expect(onSelect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Double click target paragraph text",
      }),
    );
  });

  it("reports triple-click selections from the message click target", async () => {
    const onSelect = vi.fn();
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Triple click selectable paragraph text
      </SelectableMessageProse>,
    );
    const target = getByText("Triple click selectable paragraph text");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();

    mockWindowSelection({
      node: textNode!,
      text: "Triple click selectable paragraph text",
    });
    fireEvent.click(target, { detail: 3 });

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Triple click selectable paragraph text",
        }),
      ),
    );
  });

  it("cancels a delayed double-click report when a third click completes", async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { getByText } = render(
      <SelectableMessageProse onSelect={onSelect}>
        Triple click replaces word selection
      </SelectableMessageProse>,
    );
    const target = getByText("Triple click replaces word selection");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();

    let currentSelection = makeWindowSelection({
      node: textNode!,
      text: "Triple",
    });
    vi.spyOn(window, "getSelection").mockImplementation(() => currentSelection);

    fireEvent.doubleClick(target, { detail: 2 });
    await vi.advanceTimersByTimeAsync(
      MULTI_CLICK_SELECTION_REPORT_DELAY_MS - 1,
    );
    expect(onSelect).not.toHaveBeenCalled();

    currentSelection = makeWindowSelection({
      node: textNode!,
      text: "Triple click replaces word selection",
    });
    fireEvent.click(target, { detail: 3 });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Triple click replaces word selection",
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("accepts triple-click selections that spill only whitespace past the message", async () => {
    const onSelect = vi.fn();
    const { container, getByTestId, getByText } = render(
      <div>
        <SelectableMessageProse onSelect={onSelect}>
          <p>Boundary paragraph in agent message.</p>
        </SelectableMessageProse>
        <div data-testid="message-actions">Actions</div>
      </div>,
    );
    const target = getByText("Boundary paragraph in agent message.");
    const textNode = target.firstChild;
    const messageNode = container.firstChild;
    const outsideNode = getByTestId("message-actions");
    expect(textNode).not.toBeNull();
    expect(messageNode).not.toBeNull();

    mockWindowSelection({
      commonAncestorContainer: messageNode!,
      focusNode: outsideNode,
      intersectsNode: (node) => node.contains(textNode!),
      node: textNode!,
      text: "Boundary paragraph in agent message.\n\n",
    });
    fireEvent.click(target, { detail: 3 });

    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Boundary paragraph in agent message.",
        }),
      ),
    );
  });

  it("clips whitespace-only boundary spill for native copy, then restores it", () => {
    vi.useFakeTimers();
    const { getByTestId, getByText } = render(
      <div>
        <SelectableMessageProse>
          <p>Copy only this message.</p>
        </SelectableMessageProse>
        <div data-testid="message-actions">Actions</div>
      </div>,
    );
    const target = getByText("Copy only this message.");
    const textNode = target.firstChild;
    const outsideNode = getByTestId("message-actions").firstChild;
    const messageNode = target.closest("[data-sidebar-swipe-selectable]");
    expect(textNode).not.toBeNull();
    expect(outsideNode).not.toBeNull();
    expect(messageNode).not.toBeNull();

    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(outsideNode!, 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.copy(target);

    expect(range.endContainer).toBe(messageNode);
    expect(range.endOffset).toBe(messageNode!.childNodes.length);

    vi.runAllTimers();
    expect(selection?.focusNode).toBe(outsideNode);
    expect(selection?.focusOffset).toBe(0);
  });

  it("clips a leading boundary spill when copy starts outside the message", () => {
    vi.useFakeTimers();
    const { getByText } = render(
      <div>
        <div>Earlier row</div>
        <SelectableMessageProse>
          <p>Copy this prefix.</p>
        </SelectableMessageProse>
      </div>,
    );
    const outside = getByText("Earlier row");
    const target = getByText("Copy this prefix.");
    const outsideText = outside.firstChild;
    const targetText = target.firstChild;
    const messageNode = target.closest("[data-sidebar-swipe-selectable]");
    expect(outsideText).not.toBeNull();
    expect(targetText).not.toBeNull();
    expect(messageNode).not.toBeNull();

    const range = document.createRange();
    range.setStart(outsideText!, outsideText!.textContent!.length);
    range.setEnd(targetText!, targetText!.textContent!.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.copy(outside);

    expect(range.startContainer).toBe(messageNode);
    expect(range.startOffset).toBe(0);
    vi.runAllTimers();
  });

  it("does not clip selected text outside the message", () => {
    const { getByTestId, getByText } = render(
      <div>
        <SelectableMessageProse>
          <p>foo bar foo</p>
        </SelectableMessageProse>
        <div data-testid="following-text"> bar</div>
      </div>,
    );
    const target = getByText("foo bar foo");
    const outside = getByTestId("following-text");
    const targetText = target.firstChild;
    const outsideText = outside.firstChild;
    expect(targetText).not.toBeNull();
    expect(outsideText).not.toBeNull();

    const range = document.createRange();
    range.setStart(targetText!, 8);
    range.setEnd(outsideText!, outsideText!.textContent!.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.copy(target);

    expect(range.endContainer).toBe(outsideText);
    expect(range.endOffset).toBe(outsideText!.textContent!.length);
  });

  it("does not clip selected image content outside the message", () => {
    const { getByTestId, getByText } = render(
      <div>
        <SelectableMessageProse>
          <p>Copy text and image</p>
        </SelectableMessageProse>
        <div data-testid="following-image">
          <img alt="Selected attachment" />
        </div>
      </div>,
    );
    const target = getByText("Copy text and image");
    const outside = getByTestId("following-image");
    const targetText = target.firstChild;
    expect(targetText).not.toBeNull();

    const range = document.createRange();
    range.setStart(targetText!, 0);
    range.setEnd(outside, outside.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.copy(target);

    expect(range.endContainer).toBe(outside);
    expect(range.endOffset).toBe(outside.childNodes.length);
  });

  it("leaves multi-range selections untouched", () => {
    const { getByText } = render(
      <SelectableMessageProse>
        <p>Copy one of several ranges.</p>
      </SelectableMessageProse>,
    );
    const target = getByText("Copy one of several ranges.");
    const textNode = target.firstChild;
    expect(textNode).not.toBeNull();

    const range = document.createRange();
    range.selectNodeContents(target);
    const setEnd = vi.spyOn(range, "setEnd");
    const selection = makeWindowSelection({
      node: textNode!,
      text: "Copy one of several ranges.",
    });
    Object.defineProperty(selection, "rangeCount", { value: 2 });
    vi.spyOn(selection, "getRangeAt").mockReturnValue(range);
    vi.spyOn(window, "getSelection").mockReturnValue(selection);

    fireEvent.copy(target);

    expect(setEnd).not.toHaveBeenCalled();
  });

  it("does not restore a copied range over a newer selection", () => {
    vi.useFakeTimers();
    const { getByText } = render(
      <div>
        <SelectableMessageProse>
          <p>Copy this message.</p>
        </SelectableMessageProse>
        <div>New selection</div>
      </div>,
    );
    const target = getByText("Copy this message.");
    const outside = getByText("New selection");
    const targetText = target.firstChild;
    const outsideText = outside.firstChild;
    expect(targetText).not.toBeNull();
    expect(outsideText).not.toBeNull();

    const copiedRange = document.createRange();
    copiedRange.setStart(targetText!, 0);
    copiedRange.setEnd(outsideText!, 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(copiedRange);
    fireEvent.copy(target);

    const newerRange = document.createRange();
    newerRange.selectNodeContents(outside);
    selection?.removeAllRanges();
    selection?.addRange(newerRange);
    vi.runAllTimers();

    expect(selection?.toString()).toBe("New selection");
  });

  it("registers the shared pointer listeners as passive", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const view = render(
      <SelectableMessageProse>Answer prose</SelectableMessageProse>,
    );

    const optionsByType = new Map(
      addSpy.mock.calls.map(([type, , options]) => [type, options]),
    );
    for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
      expect(optionsByType.get(type), type).toEqual({ passive: true });
    }

    view.unmount();
  });
});
