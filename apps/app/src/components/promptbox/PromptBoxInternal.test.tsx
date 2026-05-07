// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PromptDraftState } from "@/lib/prompt-draft";
import type { PromptMentionSuggestion } from "@/components/promptbox/mentions/types";
import { PromptBoxInternal } from "./PromptBoxInternal";

vi.mock("@/hooks/useAutoGrow", () => ({
  useAutoGrow: () => () => {},
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

interface PromptBoxHarnessProps {
  autoFocus?: boolean;
  historyEntries: PromptDraftState[];
  initialDraft: PromptDraftState;
  mentionSuggestions?: PromptMentionSuggestion[];
  resetKey?: string | number;
}

type HistoryArrowKey = "ArrowUp" | "ArrowDown";
type HistoryArrowModifierInit = Pick<
  KeyboardEventInit,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

interface ModifiedHistoryArrowCase {
  eventInit: HistoryArrowModifierInit;
  key: HistoryArrowKey;
}

interface PressHistoryArrowArgs {
  expectedValue: string;
  key: HistoryArrowKey;
  textarea: HTMLTextAreaElement;
}

interface PressIgnoredHistoryArrowArgs {
  eventInit?: HistoryArrowModifierInit;
  expectedValue: string;
  key: HistoryArrowKey;
  textarea: HTMLTextAreaElement;
}

function PromptBoxHarness(args: PromptBoxHarnessProps) {
  const [draft, setDraft] = useState(args.initialDraft);

  return (
    <PromptBoxInternal
      value={draft.text}
      onChange={(nextText) => {
        setDraft((currentDraft) => ({
          ...currentDraft,
          text: nextText,
        }));
      }}
      onSubmit={() => {}}
      autoFocus={args.autoFocus ?? false}
      attachments={{
        items: draft.attachments,
        onRemove: () => {},
      }}
      mentions={{
        suggestions: args.mentionSuggestions ?? [],
        onQueryChange: () => {},
      }}
      history={{
        currentDraft: draft,
        entries: args.historyEntries,
        onSelectEntry: setDraft,
        resetKey: args.resetKey ?? "scope-1",
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function pressHistoryArrow({
  expectedValue,
  key,
  textarea,
}: PressHistoryArrowArgs): Promise<void> {
  const wasNotCanceled = fireEvent.keyDown(textarea, { key });
  expect(wasNotCanceled).toBe(false);

  await waitFor(() => {
    expect(textarea.value).toBe(expectedValue);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });
}

function pressIgnoredHistoryArrow({
  eventInit,
  expectedValue,
  key,
  textarea,
}: PressIgnoredHistoryArrowArgs): void {
  const wasNotCanceled = fireEvent.keyDown(textarea, {
    key,
    ...eventInit,
  });
  expect(wasNotCanceled).toBe(true);
  expect(textarea.value).toBe(expectedValue);
}

describe("PromptBoxInternal history navigation", () => {
  it("places an autofocused existing draft caret at the end", () => {
    render(
      <PromptBoxHarness
        autoFocus
        initialDraft={{ text: "working draft", attachments: [] }}
        historyEntries={[]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it("recalls the newest history entry when the input is empty", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[
          { text: "latest command", attachments: [] },
          { text: "older command", attachments: [] },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowUp",
      textarea,
    });
  });

  it("navigates selected history entries at the absolute end and restores the empty draft", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[
          { text: "latest command", attachments: [] },
          { text: "older command", attachments: [] },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);

    await pressHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowUp",
      textarea,
    });

    await pressHistoryArrow({
      expectedValue: "older command",
      key: "ArrowUp",
      textarea,
    });

    await pressHistoryArrow({
      expectedValue: "older command",
      key: "ArrowUp",
      textarea,
    });

    await pressHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowDown",
      textarea,
    });

    await pressHistoryArrow({
      expectedValue: "",
      key: "ArrowDown",
      textarea,
    });
  });

  it("does not intercept ArrowUp for an unselected non-empty draft at the absolute end", () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "working draft", attachments: [] }}
        historyEntries={[{ text: "latest command", attachments: [] }]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pressIgnoredHistoryArrow({
      expectedValue: "working draft",
      key: "ArrowUp",
      textarea,
    });
  });

  it("does not intercept ArrowUp or ArrowDown for a selected entry unless the caret is at the end", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[{ text: "latest command", attachments: [] }]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowUp",
      textarea,
    });

    textarea.setSelectionRange(3, 3);
    pressIgnoredHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowUp",
      textarea,
    });

    textarea.setSelectionRange(3, 3);
    pressIgnoredHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowDown",
      textarea,
    });
  });

  it("does not intercept ArrowUp when there is no history to recall", () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    pressIgnoredHistoryArrow({
      expectedValue: "",
      key: "ArrowUp",
      textarea,
    });
  });

  it("does not navigate when the draft only matches a history entry without being selected", () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "latest command", attachments: [] }}
        historyEntries={[
          { text: "latest command", attachments: [] },
          { text: "older command", attachments: [] },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pressIgnoredHistoryArrow({
      expectedValue: "latest command",
      key: "ArrowUp",
      textarea,
    });
  });

  it("does not intercept an unselected multiline draft at the absolute end", () => {
    const draftText = "first line\nsecond line";

    render(
      <PromptBoxHarness
        initialDraft={{ text: draftText, attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pressIgnoredHistoryArrow({
      expectedValue: draftText,
      key: "ArrowUp",
      textarea,
    });
  });

  it("navigates from a selected multiline history entry only at the absolute end", async () => {
    const multilineHistoryEntry = "first line\nsecond line";

    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[
          { text: multilineHistoryEntry, attachments: [] },
          { text: "older command", attachments: [] },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: multilineHistoryEntry,
      key: "ArrowUp",
      textarea,
    });

    textarea.setSelectionRange(3, 3);
    pressIgnoredHistoryArrow({
      expectedValue: multilineHistoryEntry,
      key: "ArrowUp",
      textarea,
    });

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await pressHistoryArrow({
      expectedValue: "older command",
      key: "ArrowUp",
      textarea,
    });
  });

  it("does not intercept modified arrows for a selected multiline history entry at the absolute end", async () => {
    const multilineHistoryEntry = "first line\nsecond line";
    const modifierCases: HistoryArrowModifierInit[] = [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { ctrlKey: true },
    ];

    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[
          { text: multilineHistoryEntry, attachments: [] },
          { text: "older command", attachments: [] },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: multilineHistoryEntry,
      key: "ArrowUp",
      textarea,
    });

    for (const eventInit of modifierCases) {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      pressIgnoredHistoryArrow({
        eventInit,
        expectedValue: multilineHistoryEntry,
        key: "ArrowUp",
        textarea,
      });

      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      pressIgnoredHistoryArrow({
        eventInit,
        expectedValue: multilineHistoryEntry,
        key: "ArrowDown",
        textarea,
      });
    }
  });

  it("does not overwrite an attachment-only draft", () => {
    render(
      <PromptBoxHarness
        initialDraft={{
          text: "",
          attachments: [
            {
              type: "localFile",
              path: "/tmp/spec.md",
              name: "spec.md",
              sizeBytes: 42,
              mimeType: "text/markdown",
            },
          ],
        }}
        historyEntries={[{ text: "history command", attachments: [] }]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(screen.queryByText("spec.md")).not.toBeNull();

    textarea.setSelectionRange(0, 0);
    pressIgnoredHistoryArrow({
      expectedValue: "",
      key: "ArrowUp",
      textarea,
    });

    expect(screen.queryByText("spec.md")).not.toBeNull();
  });

  it("does not intercept ArrowDown without an active history selection", () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pressIgnoredHistoryArrow({
      expectedValue: "",
      key: "ArrowDown",
      textarea,
    });
  });

  it("gives selected mention-like history entries precedence over mention navigation", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[
          { text: "@rea", attachments: [] },
          { text: "older command", attachments: [] },
        ]}
        mentionSuggestions={[
          {
            kind: "file",
            path: "README.md",
            replacement: "README.md",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: "@rea",
      key: "ArrowUp",
      textarea,
    });
    await waitFor(() => {
      expect(screen.queryByText("README.md")).not.toBeNull();
    });

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await pressHistoryArrow({
      expectedValue: "",
      key: "ArrowDown",
      textarea,
    });

    textarea.setSelectionRange(0, 0);
    await pressHistoryArrow({
      expectedValue: "@rea",
      key: "ArrowUp",
      textarea,
    });
    await waitFor(() => {
      expect(screen.queryByText("README.md")).not.toBeNull();
    });

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await pressHistoryArrow({
      expectedValue: "older command",
      key: "ArrowUp",
      textarea,
    });
  });

  it("does not intercept modified arrows while a selected mention-like history entry has mention suggestions", async () => {
    const modifiedArrowCases: ModifiedHistoryArrowCase[] = [
      { eventInit: { shiftKey: true }, key: "ArrowUp" },
      { eventInit: { shiftKey: true }, key: "ArrowDown" },
      { eventInit: { altKey: true }, key: "ArrowUp" },
      { eventInit: { altKey: true }, key: "ArrowDown" },
      { eventInit: { metaKey: true }, key: "ArrowUp" },
      { eventInit: { metaKey: true }, key: "ArrowDown" },
      { eventInit: { ctrlKey: true }, key: "ArrowUp" },
      { eventInit: { ctrlKey: true }, key: "ArrowDown" },
    ];

    for (const modifiedArrowCase of modifiedArrowCases) {
      cleanup();
      render(
        <PromptBoxHarness
          initialDraft={{ text: "", attachments: [] }}
          historyEntries={[
            { text: "@rea", attachments: [] },
            { text: "older command", attachments: [] },
          ]}
          mentionSuggestions={[
            {
              kind: "file",
              path: "README.md",
              replacement: "README.md",
            },
            {
              kind: "file",
              path: "src/App.tsx",
              replacement: "src/App.tsx",
            },
          ]}
        />,
      );

      const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
      textarea.setSelectionRange(0, 0);
      await pressHistoryArrow({
        expectedValue: "@rea",
        key: "ArrowUp",
        textarea,
      });
      await waitFor(() => {
        expect(screen.queryByText("README.md")).not.toBeNull();
      });

      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      pressIgnoredHistoryArrow({
        eventInit: modifiedArrowCase.eventInit,
        expectedValue: "@rea",
        key: modifiedArrowCase.key,
        textarea,
      });

      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => {
        expect(textarea.value).toBe("@README.md");
        expect(textarea.selectionStart).toBe(textarea.value.length);
        expect(textarea.selectionEnd).toBe(textarea.value.length);
      });
    }
  });

  it("preserves ordinary mention navigation for typed mention drafts", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "@rea", attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
        mentionSuggestions={[
          {
            kind: "file",
            path: "README.md",
            replacement: "README.md",
          },
          {
            kind: "file",
            path: "src/App.tsx",
            replacement: "src/App.tsx",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.select(textarea);
    await waitFor(() => {
      expect(screen.queryByText("README.md")).not.toBeNull();
    });

    const wasNotCanceled = fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(wasNotCanceled).toBe(false);

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("@src/App.tsx");
      expect(textarea.selectionStart).toBe(textarea.value.length);
      expect(textarea.selectionEnd).toBe(textarea.value.length);
    });
  });

  it("clears the active history session when the reset key changes", async () => {
    const { rerender } = render(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
        resetKey="scope-1"
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    await pressHistoryArrow({
      expectedValue: "history command",
      key: "ArrowUp",
      textarea,
    });

    rerender(
      <PromptBoxHarness
        initialDraft={{ text: "", attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
        resetKey="scope-2"
      />,
    );

    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pressIgnoredHistoryArrow({
      expectedValue: "history command",
      key: "ArrowDown",
      textarea,
    });
  });
});
