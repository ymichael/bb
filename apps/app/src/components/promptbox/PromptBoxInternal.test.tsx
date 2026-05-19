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
import type {
  PromptMentionSuggestion,
  ThreadMentionSectionMode,
} from "@/components/promptbox/mentions/types";
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
  threadSectionMode?: ThreadMentionSectionMode;
  resetKey?: string | number;
}

type HistoryArrowKey = "ArrowUp" | "ArrowDown";

interface PressHistoryArrowArgs {
  expectedValue: string;
  key: HistoryArrowKey;
  textarea: HTMLTextAreaElement;
}

interface PressIgnoredHistoryArrowArgs {
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
        threadSectionMode: args.threadSectionMode ?? "threads",
        isLoading: false,
        isError: false,
        onQueryChange: () => {},
      }}
      mentionMenuPlacement="bottom"
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
  expectedValue,
  key,
  textarea,
}: PressIgnoredHistoryArrowArgs): void {
  const wasNotCanceled = fireEvent.keyDown(textarea, {
    key,
  });
  expect(wasNotCanceled).toBe(true);
  expect(textarea.value).toBe(expectedValue);
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

describe("PromptBoxInternal mentions", () => {
  it("hides mention results after applying a mention before existing text", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{
          text: "Please check @readme-file and update tests",
          attachments: [],
        }}
        historyEntries={[]}
        mentionSuggestions={[
          {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "a.md",
            name: "a.md",
            replacement: "a.md",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const mentionEnd = "Please check @readme-file".length;
    textarea.focus();
    textarea.setSelectionRange(mentionEnd, mentionEnd);
    fireEvent.click(textarea);

    const mentionButton = await screen.findByRole("button", {
      name: /a\.md/,
    });
    fireEvent.mouseDown(mentionButton);
    await waitForAnimationFrame();

    await waitFor(() => {
      expect(textarea.value).toBe("Please check @a.md and update tests");
      expect(textarea.selectionStart).toBe("Please check @a.md".length);
      expect(textarea.selectionEnd).toBe("Please check @a.md".length);
    });

    fireEvent.click(textarea);

    expect(screen.queryByRole("button", { name: /a\.md/ })).toBeNull();
  });

  it("renders mixed thread, workspace path, and thread-storage suggestions", async () => {
    const { container } = render(
      <PromptBoxHarness
        initialDraft={{
          text: "Please check @pro",
          attachments: [],
        }}
        historyEntries={[]}
        threadSectionMode="all"
        mentionSuggestions={[
          {
            kind: "thread",
            path: "thread:thr_project",
            replacement: "thread:thr_project",
            threadId: "thr_project",
            title: "Project planning",
            threadType: "manager",
          },
          {
            kind: "thread",
            path: "thread:thr_standard_project",
            replacement: "thread:thr_standard_project",
            threadId: "thr_standard_project",
            title: "Project implementation",
            threadType: "standard",
          },
          {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "src/project.ts",
            name: "project.ts",
            replacement: "src/project.ts",
          },
          {
            kind: "path",
            source: "workspace",
            entryKind: "directory",
            path: "src/projects",
            name: "projects",
            replacement: "src/projects/",
          },
          {
            kind: "path",
            source: "thread-storage",
            entryKind: "file",
            path: "notes/project.md",
            name: "project.md",
            replacement: "thread-storage:notes/project.md",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.click(textarea);

    expect(await screen.findByText("Managers & threads")).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Manager Storage")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Project planning/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Project implementation/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /project\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /projects/ })).toBeTruthy();
    expect(container.querySelector('[data-icon="UserRound"]')).not.toBeNull();
    expect(
      container.querySelector('[data-icon="MessageSquare"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-icon="File"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="Folder"]')).not.toBeNull();
    expect(screen.queryByText("Paths")).toBeNull();
    expect(screen.queryByText("Thread storage")).toBeNull();
    expect(screen.queryByText("Folder")).toBeNull();
  });

  it("inserts workspace folder mentions with trailing slash", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{
          text: "Open @src/com",
          attachments: [],
        }}
        historyEntries={[]}
        mentionSuggestions={[
          {
            kind: "path",
            source: "workspace",
            entryKind: "directory",
            path: "src/components",
            name: "components",
            replacement: "src/components/",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.click(textarea);

    const mentionButton = await screen.findByRole("button", {
      name: /components/,
    });
    fireEvent.mouseDown(mentionButton);
    await waitForAnimationFrame();

    await waitFor(() => {
      expect(textarea.value).toBe("Open @src/components/ ");
      expect(textarea.selectionStart).toBe("Open @src/components/ ".length);
      expect(textarea.selectionEnd).toBe("Open @src/components/ ".length);
    });
  });

  it("inserts thread-storage folder mentions with source-qualified text", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{
          text: "Use @notes",
          attachments: [],
        }}
        historyEntries={[]}
        mentionSuggestions={[
          {
            kind: "path",
            source: "thread-storage",
            entryKind: "directory",
            path: "notes",
            name: "notes",
            replacement: "thread-storage:notes/",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.click(textarea);

    const mentionButton = await screen.findByRole("button", {
      name: /notes/,
    });
    fireEvent.mouseDown(mentionButton);
    await waitForAnimationFrame();

    await waitFor(() => {
      expect(textarea.value).toBe("Use @thread-storage:notes/ ");
      expect(textarea.selectionStart).toBe(
        "Use @thread-storage:notes/ ".length,
      );
      expect(textarea.selectionEnd).toBe("Use @thread-storage:notes/ ".length);
    });
  });
});

describe("PromptBoxInternal history navigation", () => {
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
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "README.md",
            name: "README.md",
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

  it("preserves ordinary mention navigation for typed mention drafts", async () => {
    render(
      <PromptBoxHarness
        initialDraft={{ text: "@rea", attachments: [] }}
        historyEntries={[{ text: "history command", attachments: [] }]}
        mentionSuggestions={[
          {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "README.md",
            name: "README.md",
            replacement: "README.md",
          },
          {
            kind: "path",
            source: "workspace",
            entryKind: "file",
            path: "src/App.tsx",
            name: "App.tsx",
            replacement: "src/App.tsx",
          },
        ]}
      />,
    );

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fireEvent.click(textarea);
    await waitFor(() => {
      expect(screen.queryByText("README.md")).not.toBeNull();
    });

    const wasNotCanceled = fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(wasNotCanceled).toBe(false);

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("@src/App.tsx ");
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
