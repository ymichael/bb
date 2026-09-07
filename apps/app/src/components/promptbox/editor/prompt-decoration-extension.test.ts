// @vitest-environment jsdom

import type { ComposerView } from "@get-bb/plugin-sdk";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS,
  PROMPT_DECORATION_LARGE_DOC_SIZE,
  ULTRACODE_HIGHLIGHT_CLASS,
  findUltracodeRanges,
  getPromptDecorationSet,
  refreshPromptDecorations,
  type PromptDecorationExtensionOptions,
} from "./prompt-decoration-extension";
import { promptEditorExtensions } from "./prompt-editor-extensions";
import {
  promptEditorSerializationFromDoc,
  promptEditorValueFromDoc,
} from "./prompt-editor-serialization";

function createEditor(
  richTextEditing: boolean,
  content: object,
  options: PromptDecorationExtensionOptions = {},
): Editor {
  return new Editor({
    extensions: promptEditorExtensions({
      richTextEditing,
      getPlaceholder: () => "",
      ...options,
    }),
    content,
  });
}

function paragraphContent(text: string): object {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function decorationClasses(editor: Editor): string[] {
  return (
    getPromptDecorationSet(editor.state)
      ?.find()
      .map((decoration) => decoration.spec.className)
      .filter(
        (className): className is string => typeof className === "string",
      ) ?? []
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PromptDecorationExtension", () => {
  it("keeps ultracode matching visually compatible with the old host rule", () => {
    expect(findUltracodeRanges("run UltraCode and ultracode now")).toEqual([
      { from: 4, to: 13 },
      { from: 18, to: 27 },
    ]);
    expect(findUltracodeRanges("ultracodes myultracode supercode")).toEqual([]);

    const editor = createEditor(false, paragraphContent("use ultracode now"));
    expect(decorationClasses(editor)).toContain(ULTRACODE_HIGHLIGHT_CLASS);
    editor.destroy();
  });

  it.each([false, true])(
    "paints plugin rules in %s rich-text mode without changing serialization",
    (richTextEditing) => {
      const content = richTextEditing
        ? {
            type: "doc",
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [
                  { type: "text", text: "alpha ", marks: [{ type: "bold" }] },
                  { type: "text", text: "beta" },
                ],
              },
            ],
          }
        : paragraphContent("alpha beta");
      const editor = createEditor(richTextEditing, content, {
        getDecorationSources: () => [
          {
            id: "plugin:test",
            generation: 1,
            effects: [
              {
                id: "beta",
                className: "plugin-beta",
                match(text) {
                  const from = text.indexOf("beta");
                  return from === -1
                    ? []
                    : [{ from, to: from + "beta".length }];
                },
              },
            ],
          },
        ],
      });
      const before = promptEditorValueFromDoc(editor.state.doc);

      expect(decorationClasses(editor)).toContain("plugin-beta");
      expect(promptEditorValueFromDoc(editor.state.doc)).toEqual(before);
      editor.destroy();
    },
  );

  it("maps serialized offsets across an atomic mention", () => {
    const editor = createEditor(
      false,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "pre " },
              {
                type: "mention",
                attrs: {
                  resource: {
                    kind: "plugin",
                    pluginId: "sample",
                    itemId: "people:alice",
                    label: "@alice",
                  },
                  serializedText: "@alice",
                },
              },
              { type: "text", text: " post" },
            ],
          },
        ],
      },
      {
        getDecorationSources: () => [
          {
            id: "plugin:mentions",
            generation: 1,
            effects: [
              {
                id: "mention-through-suffix",
                className: "mention-range",
                match(text) {
                  const from = text.indexOf("@alice");
                  return [{ from, to: text.length }];
                },
              },
            ],
          },
        ],
      },
    );
    const serialization = promptEditorSerializationFromDoc(editor.state.doc);

    expect(serialization.text).toBe("pre @alice post");
    expect(serialization.offsetMapping).toEqual([
      { textFrom: 0, textTo: 4, docFrom: 1, docTo: 5, kind: "text" },
      { textFrom: 4, textTo: 10, docFrom: 5, docTo: 6, kind: "mention" },
      { textFrom: 10, textTo: 15, docFrom: 6, docTo: 11, kind: "text" },
    ]);
    const mentionDecorations = getPromptDecorationSet(editor.state)
      ?.find(5, 6, (spec) => spec.className === "mention-range")
      .filter((decoration) => decoration.from === 5 && decoration.to === 6);
    expect(mentionDecorations).toHaveLength(1);
    expect(
      decorationClasses(editor).filter((name) => name === "mention-range"),
    ).toHaveLength(2);
    editor.destroy();
  });

  it("adds and removes content and whole-draft classes across edits", () => {
    let includeWholeDraftEffect = true;
    const editor = createEditor(false, paragraphContent("tag"), {
      getDecorationSources: () => [
        {
          id: "plugin:tag",
          generation: 1,
          effects: [
            {
              id: "tag",
              className: "tagged",
              match: (text) =>
                text === "tag" ? [{ from: 0, to: text.length }] : [],
            },
          ],
        },
        ...(includeWholeDraftEffect
          ? [
              {
                id: "plugin:imperative",
                generation: 1,
                effects: [
                  {
                    id: "whole-draft",
                    className: "plugin-shimmer",
                    match: (text: string) => [{ from: 0, to: text.length }],
                  },
                ],
              },
            ]
          : []),
      ],
    });

    expect(decorationClasses(editor)).toContain("tagged");
    expect(decorationClasses(editor)).toContain("plugin-shimmer");

    editor.commands.setContent(paragraphContent("other"));
    expect(decorationClasses(editor)).not.toContain("tagged");
    includeWholeDraftEffect = false;
    refreshPromptDecorations(editor);
    expect(decorationClasses(editor)).not.toContain("plugin-shimmer");
    editor.destroy();
  });

  it("stacks overlapping host and plugin classes in composition order", () => {
    const wholeRange = (text: string) => [{ from: 0, to: text.length }];
    const editor = createEditor(false, paragraphContent("ultracode"), {
      getDecorationSources: () => [
        {
          id: "host:extra",
          generation: 1,
          effects: [
            {
              id: "host-extra",
              className: "host-extra",
              match: wholeRange,
            },
          ],
        },
        {
          id: "plugin:a",
          generation: 1,
          effects: [{ id: "a", className: "plugin-a", match: wholeRange }],
        },
        {
          id: "plugin:b",
          generation: 1,
          effects: [{ id: "b", className: "plugin-b", match: wholeRange }],
        },
      ],
    });
    const decorations = getPromptDecorationSet(editor.state)?.find() ?? [];

    expect(decorations.map((decoration) => decoration.spec.className)).toEqual([
      ULTRACODE_HIGHLIGHT_CLASS,
      "host-extra",
      "plugin-a",
      "plugin-b",
    ]);
    expect(
      decorations.map((decoration) => decoration.spec.sourceOrder),
    ).toEqual(["0:0", "1:0", "2:0", "3:0"]);
    editor.destroy();
  });

  it("disables a throwing rule until its source generation changes", () => {
    let generation = 1;
    const match = vi.fn((text: string) => {
      if (generation === 1) throw new Error("bad matcher");
      return [{ from: 0, to: text.length }];
    });
    const onRuleError = vi.fn();
    const editor = createEditor(false, paragraphContent("paint me"), {
      getDecorationSources: () => [
        {
          id: "plugin:thrower",
          generation,
          effects: [{ id: "throws", className: "eventual", match }],
        },
      ],
      onRuleError,
    });

    expect(decorationClasses(editor)).not.toContain("eventual");
    refreshPromptDecorations(editor);
    expect(decorationClasses(editor)).not.toContain("eventual");
    expect(match).toHaveBeenCalledTimes(1);
    expect(onRuleError).toHaveBeenCalledTimes(1);

    generation = 2;
    refreshPromptDecorations(editor);
    expect(decorationClasses(editor)).toContain("eventual");
    expect(match).toHaveBeenCalledTimes(2);
    editor.destroy();
  });

  it("debounces structured draft observation with mention spans and view", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn();
    const composerView: ComposerView = {
      scope: { kind: "thread", threadId: "thr_1" },
      layout: "expanded",
      draft: { text: "", isEmpty: true, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    };
    const editor = createEditor(
      false,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "ask " },
              {
                type: "mention",
                attrs: {
                  resource: {
                    kind: "plugin",
                    pluginId: "sample",
                    itemId: "people:alice",
                    label: "Alice",
                  },
                  serializedText: "Alice",
                },
              },
            ],
          },
        ],
      },
      {
        draftObserverDebounceMs: 25,
        getDraftObservers: () => [
          { id: "sample:observer", getView: () => composerView, onDraftChange },
        ],
      },
    );

    vi.advanceTimersByTime(24);
    expect(onDraftChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDraftChange).toHaveBeenCalledWith(
      {
        text: "ask Alice",
        mentions: [
          { from: 4, to: 9, provider: "people", id: "alice", label: "Alice" },
        ],
      },
      composerView,
    );

    onDraftChange.mockClear();
    editor.commands.setContent(paragraphContent("first"));
    editor.commands.setContent(paragraphContent("second"));
    vi.advanceTimersByTime(25);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0]?.[0].text).toBe("second");
    editor.destroy();
  });

  it("defers rebuilds on large docs while mapping existing decorations", () => {
    vi.useFakeTimers();
    const bulk = "x".repeat(PROMPT_DECORATION_LARGE_DOC_SIZE + 100);
    const editor = createEditor(false, paragraphContent(`ultracode ${bulk}`));
    const ultracodeDecorations = () =>
      (getPromptDecorationSet(editor.state)?.find() ?? []).filter(
        (decoration) => decoration.spec.className === ULTRACODE_HIGHLIGHT_CLASS,
      );

    expect(ultracodeDecorations()).toHaveLength(1);
    const initialFrom = ultracodeDecorations()[0]!.from;

    editor.commands.insertContentAt(1, "pre ");
    editor.commands.insertContentAt(
      editor.state.doc.content.size - 1,
      " ultracode",
    );
    expect(ultracodeDecorations()).toHaveLength(1);
    expect(ultracodeDecorations()[0]!.from).toBe(initialFrom + "pre ".length);

    vi.advanceTimersByTime(PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS);
    expect(ultracodeDecorations()).toHaveLength(2);

    editor.commands.insertContentAt({ from: 10, to: 11 }, "x");
    expect(ultracodeDecorations()).toHaveLength(2);
    vi.advanceTimersByTime(PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS);
    expect(ultracodeDecorations()).toHaveLength(1);
    editor.destroy();
  });

  it("does not re-run draft observers for a deferred large-doc rebuild", () => {
    vi.useFakeTimers();
    const onDraftChange = vi.fn();
    const composerView: ComposerView = {
      scope: { kind: "thread", threadId: "thr_1" },
      layout: "expanded",
      draft: { text: "", isEmpty: true, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    };
    const editor = createEditor(
      false,
      paragraphContent("x".repeat(PROMPT_DECORATION_LARGE_DOC_SIZE + 100)),
      {
        draftObserverDebounceMs: 25,
        getDraftObservers: () => [
          { id: "sample:observer", getView: () => composerView, onDraftChange },
        ],
      },
    );
    vi.advanceTimersByTime(25);
    onDraftChange.mockClear();

    editor.commands.insertContent("y");
    vi.advanceTimersByTime(25);
    expect(onDraftChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS + 25);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    refreshPromptDecorations(editor);
    vi.advanceTimersByTime(25);
    expect(onDraftChange).toHaveBeenCalledTimes(2);
    editor.destroy();
  });

  it("cancels a pending large-doc rebuild after an explicit refresh", () => {
    vi.useFakeTimers();
    const match = vi.fn(() => []);
    const editor = createEditor(
      false,
      paragraphContent("x".repeat(PROMPT_DECORATION_LARGE_DOC_SIZE + 100)),
      {
        getDecorationSources: () => [
          {
            id: "plugin:test",
            generation: 1,
            effects: [{ id: "test", className: "test", match }],
          },
        ],
      },
    );
    expect(match).toHaveBeenCalledTimes(1);

    editor.commands.insertContent("y");
    expect(match).toHaveBeenCalledTimes(1);
    refreshPromptDecorations(editor);
    expect(match).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(PROMPT_DECORATION_LARGE_DOC_REBUILD_DELAY_MS);
    expect(match).toHaveBeenCalledTimes(2);
    editor.destroy();
  });
});
