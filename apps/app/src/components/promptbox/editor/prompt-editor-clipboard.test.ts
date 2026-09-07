// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { PromptMentionExtension } from "./prompt-mention-extension";
import { promptEditorClipboardSerializer } from "./prompt-editor-clipboard";

const schema = getSchema([StarterKit, PromptMentionExtension]);

describe("prompt editor clipboard HTML serialization", () => {
  it("copies prompt lines as single-line-break blocks", () => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        schema.text("first", [schema.mark("bold")]),
      ),
      schema.node("paragraph", null, schema.text("second")),
      schema.node("paragraph", null, schema.text("third")),
    ]);
    const container = document.createElement("div");

    container.append(
      promptEditorClipboardSerializer.serializeFragment(doc.content, {
        document,
      }),
    );

    expect(
      [...container.children].map((child) => [
        child.tagName,
        child.textContent,
      ]),
    ).toEqual([
      ["DIV", "first"],
      ["DIV", "second"],
      ["DIV", "third"],
    ]);
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("first");
  });
});
