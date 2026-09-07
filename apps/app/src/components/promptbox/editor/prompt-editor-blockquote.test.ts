import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { promptEditorValueFromDoc } from "./prompt-editor-serialization";
import {
  createExitTrailingBlockquoteBreakTransaction,
  createInsertParagraphBeforeBlockquoteTransaction,
  createRemoveEmptyBlockquotesTransaction,
} from "./prompt-editor-blockquote";

const schema = getSchema([
  StarterKit.configure({
    blockquote: {},
    bold: false,
    bulletList: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: false,
    horizontalRule: false,
    italic: false,
    listItem: false,
    orderedList: false,
    strike: false,
  }),
]);

function stateFromJson(docJson: unknown, selectionPosition: number) {
  const doc = Node.fromJSON(schema, docJson);
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, selectionPosition),
  });
}

describe("createExitTrailingBlockquoteBreakTransaction", () => {
  it("turns a second Shift+Enter after a blockquote into a paragraph below it", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "quote" },
                  { type: "hardBreak" },
                ],
              },
            ],
          },
        ],
      },
      8,
    );

    const transaction = createExitTrailingBlockquoteBreakTransaction(state);
    expect(transaction).not.toBeNull();
    const nextState = state.apply(transaction!);

    expect(nextState.doc.toString()).toBe(
      'doc(blockquote(paragraph("quote")), paragraph)',
    );
    expect(nextState.selection.from).toBe(10);
    expect(promptEditorValueFromDoc(nextState.doc).text).toBe("> quote\n\n");
  });

  it("does not exit a blockquote before the first trailing hard break exists", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "quote" }],
              },
            ],
          },
        ],
      },
      7,
    );

    expect(createExitTrailingBlockquoteBreakTransaction(state)).toBeNull();
  });

  it("does not exit when the hard break is inside the quote content", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "quote" },
                  { type: "hardBreak" },
                  { type: "text", text: "more" },
                ],
              },
            ],
          },
        ],
      },
      8,
    );

    expect(createExitTrailingBlockquoteBreakTransaction(state)).toBeNull();
  });
});

describe("createInsertParagraphBeforeBlockquoteTransaction", () => {
  it("turns Shift+Enter at the start of a blockquote into a paragraph above it", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "quote" }],
              },
            ],
          },
        ],
      },
      2,
    );

    const transaction = createInsertParagraphBeforeBlockquoteTransaction(state);
    expect(transaction).not.toBeNull();
    const nextState = state.apply(transaction!);

    expect(nextState.doc.toString()).toBe(
      'doc(paragraph, blockquote(paragraph("quote")))',
    );
    expect(nextState.selection.from).toBe(1);
    expect(promptEditorValueFromDoc(nextState.doc).text).toBe("\n> quote");
  });

  it("does not insert above when the caret is inside quote text", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "quote" }],
              },
            ],
          },
        ],
      },
      4,
    );

    expect(createInsertParagraphBeforeBlockquoteTransaction(state)).toBeNull();
  });
});

describe("createRemoveEmptyBlockquotesTransaction", () => {
  it("removes an empty blockquote left after cutting quote text", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [{ type: "paragraph" }],
          },
        ],
      },
      2,
    );

    const transaction = createRemoveEmptyBlockquotesTransaction(state);
    expect(transaction).not.toBeNull();
    const nextState = state.apply(transaction!);

    expect(nextState.doc.toString()).toBe("doc(paragraph)");
    expect(promptEditorValueFromDoc(nextState.doc).text).toBe("");
  });

  it("keeps non-empty blockquotes", () => {
    const state = stateFromJson(
      {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "quote" }],
              },
            ],
          },
        ],
      },
      2,
    );

    expect(createRemoveEmptyBlockquotesTransaction(state)).toBeNull();
  });
});
