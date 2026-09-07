// @vitest-environment jsdom

import { vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(navigator, "vendor", {
    configurable: true,
    value: "Apple Computer, Inc.",
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
      "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: 5,
  });
});

import type { PromptTextMention } from "@bb/domain";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@bb/client-core";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";

const IOS_ENTER_REPLAY_MS = 200;

function getPromptEditorElement(): HTMLElement {
  const editorElement = document.querySelector(".ProseMirror");
  if (!(editorElement instanceof HTMLElement)) {
    throw new Error("Prompt editor element was not rendered");
  }
  return editorElement;
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe("PromptBoxInternal on a real iPadOS ProseMirror build", () => {
  it("applies typeahead before submitting a Magic Keyboard Enter", async () => {
    const changes = vi.fn();
    const onSubmit = vi.fn();

    function Harness() {
      const [value, setValue] = useState("/");
      const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>(
        [],
      );
      return (
        <PromptBoxInternal
          value={value}
          mentionRanges={mentionRanges}
          onChange={(nextValue, nextMentions) => {
            changes(nextValue, nextMentions);
            setValue(nextValue);
            setMentionRanges(nextMentions);
          }}
          onSubmit={onSubmit}
          mentionMenuPlacement="bottom"
          typeahead={{
            mention: {
              results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
              isLoading: false,
              isError: false,
              onQueryChange: vi.fn(),
            },
            command: {
              trigger: "/",
              suggestions: [
                {
                  kind: "command",
                  name: "review",
                  source: "skill",
                  origin: "user",
                  description: null,
                  argumentHint: null,
                },
              ],
              isLoading: false,
              isError: false,
              hasMore: false,
              isLoadingMore: false,
              loadMore: vi.fn(),
              onQueryChange: vi.fn(),
            },
          }}
        />
      );
    }

    render(<Harness />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "review" })).toBeTruthy();

    fireEvent.keyDown(getPromptEditorElement(), {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    });

    expect(changes).toHaveBeenLastCalledWith(
      "/review ",
      expect.arrayContaining([
        expect.objectContaining({
          resource: expect.objectContaining({
            kind: "command",
            name: "review",
          }),
        }),
      ]),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a Magic Keyboard Enter once, with no replayed second submit", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <PromptBoxInternal
        value="Run this"
        mentionRanges={[]}
        onChange={onChange}
        onSubmit={onSubmit}
        mentionMenuPlacement="bottom"
        typeahead={{
          mention: {
            results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
            isLoading: false,
            isError: false,
            onQueryChange: vi.fn(),
          },
          command: INERT_TYPEAHEAD_COMMAND_CONFIG,
        }}
      />,
    );

    fireEvent.keyDown(getPromptEditorElement(), {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    });

    expect(onSubmit).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(IOS_ENTER_REPLAY_MS * 2);
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("turns a software-keyboard Return into a newline through the iOS replay", () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <PromptBoxInternal
        value="First line"
        mentionRanges={[]}
        onChange={onChange}
        onSubmit={onSubmit}
        mentionMenuPlacement="bottom"
        typeahead={{
          mention: {
            results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
            isLoading: false,
            isError: false,
            onQueryChange: vi.fn(),
          },
          command: INERT_TYPEAHEAD_COMMAND_CONFIG,
        }}
      />,
    );

    fireEvent.keyDown(getPromptEditorElement(), {
      key: "Enter",
      code: "",
      keyCode: 13,
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(IOS_ENTER_REPLAY_MS + 50);
    });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("First line\n", []);
  });
});
