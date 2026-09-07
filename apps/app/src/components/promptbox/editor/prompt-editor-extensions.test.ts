import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { promptEditorExtensions } from "./prompt-editor-extensions";

function schemaFor(richTextEditing: boolean) {
  return getSchema(
    promptEditorExtensions({ richTextEditing, getPlaceholder: () => "" }),
  );
}

const GATED_NODES = ["heading", "bulletList", "orderedList", "listItem"];
const GATED_MARKS = ["bold", "italic", "code"];

describe("promptEditorExtensions", () => {
  it("enables the Markdown nodes and marks when rich text is on", () => {
    const schema = schemaFor(true);
    for (const node of GATED_NODES) {
      expect(schema.nodes[node]).toBeDefined();
    }
    for (const mark of GATED_MARKS) {
      expect(schema.marks[mark]).toBeDefined();
    }
  });

  it("disables the Markdown nodes and marks when rich text is off", () => {
    const schema = schemaFor(false);
    for (const node of GATED_NODES) {
      expect(schema.nodes[node]).toBeUndefined();
    }
    for (const mark of GATED_MARKS) {
      expect(schema.marks[mark]).toBeUndefined();
    }
  });

  it("keeps paragraph, blockquote, and mention available in both modes", () => {
    for (const richTextEditing of [true, false]) {
      const schema = schemaFor(richTextEditing);
      expect(schema.nodes.paragraph).toBeDefined();
      expect(schema.nodes.blockquote).toBeDefined();
      expect(schema.nodes.mention).toBeDefined();
    }
  });

  it("keeps code blocks, links, strike, and underline disabled in both modes", () => {
    for (const richTextEditing of [true, false]) {
      const schema = schemaFor(richTextEditing);
      expect(schema.nodes.codeBlock).toBeUndefined();
      expect(schema.marks.link).toBeUndefined();
      expect(schema.marks.strike).toBeUndefined();
      expect(schema.marks.underline).toBeUndefined();
    }
  });
});
