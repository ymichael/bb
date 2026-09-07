import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node, Slice } from "@tiptap/pm/model";
import type { PromptTextMention } from "@bb/domain";
import { PromptMentionExtension } from "./prompt-mention-extension";
import {
  promptCommandResourceFromSuggestion,
  promptEditorClipboardTextFromSlice,
  promptEditorContentFromValue,
  promptEditorInlineContentFromValue,
  promptMentionResourceFromSuggestion,
  promptEditorValueFromDoc,
  type PromptEditorValue,
} from "./prompt-editor-serialization";

const schema = getSchema([
  StarterKit.configure({
    blockquote: {},
    bold: {},
    bulletList: {},
    code: {},
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: {},
    horizontalRule: false,
    italic: {},
    link: false,
    listItem: {},
    orderedList: {},
    strike: false,
    underline: false,
  }),
  PromptMentionExtension,
]);

function roundTrip(value: PromptEditorValue): PromptEditorValue {
  const node = Node.fromJSON(schema, promptEditorContentFromValue(value));
  return promptEditorValueFromDoc(node);
}

function roundTripRichMarkdown(value: PromptEditorValue): PromptEditorValue {
  const node = Node.fromJSON(
    schema,
    promptEditorContentFromValue(value, { richTextMarkdown: true }),
  );
  return promptEditorValueFromDoc(node);
}

function threadMentionResource(label = "@thr") {
  return {
    kind: "thread" as const,
    threadId: "thr_1",
    projectId: "proj_1",
    label,
  };
}

describe("prompt editor serialization round-trip", () => {
  it("round-trips plain text with no quotes (regression)", () => {
    const value: PromptEditorValue = {
      text: "hello there\nsecond line",
      mentions: [],
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips a single one-line quote", () => {
    const value: PromptEditorValue = { text: "> hello", mentions: [] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips a multi-line quote", () => {
    const value: PromptEditorValue = { text: "> a\n> b", mentions: [] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("canonicalizes a quote followed by a reply with a separator blank", () => {
    const value: PromptEditorValue = { text: "> a\nmy reply", mentions: [] };
    expect(roundTrip(value)).toEqual({
      text: "> a\n\nmy reply",
      mentions: [],
    });
  });

  it("canonicalizes two quotes each with a reply", () => {
    const value: PromptEditorValue = {
      text: "> q1\nr1\n> q2\nr2",
      mentions: [],
    };
    expect(roundTrip(value)).toEqual({
      text: "> q1\n\nr1\n> q2\n\nr2",
      mentions: [],
    });
  });

  it("round-trips a quote with an internal blank line", () => {
    const value: PromptEditorValue = { text: "> a\n>\n> b", mentions: [] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("round-trips an empty string", () => {
    const value: PromptEditorValue = { text: "", mentions: [] };
    expect(roundTrip(value)).toEqual(value);
  });

  it("preserves a mention's offsets in a reply after a quote", () => {
    const prefix = "> a\n\nhey ";
    const mentionText = "@thread";
    const text = `${prefix}${mentionText} done`;
    const mention: PromptTextMention = {
      start: prefix.length,
      end: prefix.length + mentionText.length,
      resource: {
        kind: "thread",
        threadId: "thr_123",
        projectId: "proj_1",
        label: "@thread",
      },
    };
    const value: PromptEditorValue = { text, mentions: [mention] };

    const result = roundTrip(value);
    expect(result.text).toBe(text);
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]!.start).toBe(mention.start);
    expect(result.mentions[0]!.end).toBe(mention.end);
    expect(result.mentions[0]!.resource).toEqual(mention.resource);
  });
});

describe("prompt editor clipboard serialization", () => {
  function clipboardText(content: unknown[]): string {
    const doc = Node.fromJSON(schema, { type: "doc", content });
    return promptEditorClipboardTextFromSlice(
      new Slice(doc.content, 0, 0),
      schema,
    );
  }

  it("copies separate prompt lines with a single newline", () => {
    expect(
      clipboardText([
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
        { type: "paragraph", content: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("first\nsecond");
  });

  it("copies hard-break prompt lines with the same single newline", () => {
    expect(
      clipboardText([
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first" },
            { type: "hardBreak" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("first\nsecond");
  });

  it("copies a blockquote without adding a trailing blank line", () => {
    expect(
      clipboardText([
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
          ],
        },
      ]),
    ).toBe("> quoted");
  });
});

describe("prompt editor rich markdown restore", () => {
  it("restores heading, list, and inline mark markdown as editor nodes", () => {
    const value: PromptEditorValue = {
      text: "# Title\n- **bold**\n- _italic_\n1. `code`",
      mentions: [],
    };

    const doc = Node.fromJSON(
      schema,
      promptEditorContentFromValue(value, { richTextMarkdown: true }),
    );

    expect(doc.toJSON()).toMatchObject({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 } },
        { type: "bulletList" },
        { type: "orderedList", attrs: { start: 1 } },
      ],
    });
    expect(promptEditorValueFromDoc(doc)).toEqual(value);
  });

  it("keeps mention offsets stable when restoring headings and lists", () => {
    const resource = {
      kind: "thread" as const,
      threadId: "thr_1",
      projectId: "proj_1",
      label: "@thr",
    };
    const text = "## See @thr\n- Ping @thr";
    const firstMentionStart = text.indexOf("@thr");
    const secondMentionStart = text.lastIndexOf("@thr");
    const value: PromptEditorValue = {
      text,
      mentions: [
        {
          start: firstMentionStart,
          end: firstMentionStart + "@thr".length,
          resource,
        },
        {
          start: secondMentionStart,
          end: secondMentionStart + "@thr".length,
          resource,
        },
      ],
    };

    expect(roundTripRichMarkdown(value)).toEqual(value);
  });

  it("does not treat underscores inside words as italic delimiters", () => {
    const value: PromptEditorValue = {
      text: "Open apps/app/src/snake_case_file.ts",
      mentions: [],
    };

    expect(roundTripRichMarkdown(value)).toEqual(value);
  });

  it("treats emphasis markers inside inline code as literal text", () => {
    const value: PromptEditorValue = {
      text: "`**literal**` and `a ** b ** c`",
      mentions: [],
    };

    expect(roundTripRichMarkdown(value)).toEqual(value);
  });

  it("round-trips a large single line with thousands of Markdown delimiters", () => {
    const value: PromptEditorValue = {
      text: Array.from(
        { length: 4_000 },
        (_, index) => `const v${index}=\`value_${index}\`;`,
      ).join(""),
      mentions: [],
    };

    expect(roundTripRichMarkdown(value)).toEqual(value);
  });

  it("keeps marked mention markdown valid when restoring rich text", () => {
    const mentionText = "@thr";
    const text = `**${mentionText} done**`;
    const mentionStart = text.indexOf(mentionText);
    const value: PromptEditorValue = {
      text,
      mentions: [
        {
          start: mentionStart,
          end: mentionStart + mentionText.length,
          resource: threadMentionResource(),
        },
      ],
    };

    const result = roundTripRichMarkdown(value);

    expect(result).toEqual(value);
    expect(
      result.text.slice(result.mentions[0]!.start, result.mentions[0]!.end),
    ).toBe(mentionText);
  });

  it("restores rich markdown blocks inside blockquotes", () => {
    expect(
      roundTripRichMarkdown({
        text: "> ## Head",
        mentions: [],
      }),
    ).toEqual({
      text: "> ## Head",
      mentions: [],
    });
    expect(
      roundTripRichMarkdown({
        text: "> - item",
        mentions: [],
      }),
    ).toEqual({
      text: "> - item",
      mentions: [],
    });
  });
});

describe("prompt editor markdown serialization (doc -> markdown text)", () => {
  function serialize(content: unknown[]): PromptEditorValue {
    const doc = Node.fromJSON(schema, { type: "doc", content });
    return promptEditorValueFromDoc(doc);
  }

  it("serializes bold, italic, and code marks", () => {
    expect(
      serialize([
        {
          type: "paragraph",
          content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
        },
      ]).text,
    ).toBe("**x**");
    expect(
      serialize([
        {
          type: "paragraph",
          content: [{ type: "text", text: "y", marks: [{ type: "italic" }] }],
        },
      ]).text,
    ).toBe("_y_");
    expect(
      serialize([
        {
          type: "paragraph",
          content: [{ type: "text", text: "z", marks: [{ type: "code" }] }],
        },
      ]).text,
    ).toBe("`z`");
  });

  it("nests bold outside italic", () => {
    expect(
      serialize([
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "bold" }, { type: "italic" }],
            },
          ],
        },
      ]).text,
    ).toBe("**_x_**");
  });

  it("serializes headings with the right level", () => {
    expect(
      serialize([
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
      ]).text,
    ).toBe("## Title");
  });

  it("serializes bullet and ordered lists", () => {
    expect(
      serialize([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "b" }] },
              ],
            },
          ],
        },
      ]).text,
    ).toBe("- a\n- b");
    expect(
      serialize([
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "b" }] },
              ],
            },
          ],
        },
      ]).text,
    ).toBe("1. a\n2. b");
    expect(
      serialize([
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "c" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "d" }] },
              ],
            },
          ],
        },
      ]).text,
    ).toBe("3. c\n4. d");
  });

  it("indents nested lists", () => {
    expect(
      serialize([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "a1" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]).text,
    ).toBe("- a\n  - a1");
  });

  it("separates stacked blocks with a single newline", () => {
    expect(
      serialize([
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "H" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "para" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "i" }] },
              ],
            },
          ],
        },
      ]).text,
    ).toBe("# H\npara\n- i");
  });

  it("separates a blockquote from a following paragraph with a blank line", () => {
    expect(
      serialize([
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "reply" }],
        },
      ]).text,
    ).toBe("> quoted\n\nreply");
  });

  it("keeps a mention's offset correct inside a heading", () => {
    const resource = {
      kind: "thread" as const,
      threadId: "thr_1",
      projectId: "proj_1",
      label: "@thr",
    };
    const result = serialize([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [
          { type: "text", text: "see " },
          { type: "mention", attrs: { resource, serializedText: "@thr" } },
        ],
      },
    ]);
    expect(result.text).toBe("## see @thr");
    expect(result.mentions).toHaveLength(1);
    expect(
      result.text.slice(result.mentions[0]!.start, result.mentions[0]!.end),
    ).toBe("@thr");
    expect(result.mentions[0]!.resource).toEqual(resource);
  });

  it("keeps a mention's offset correct inside a list item", () => {
    const resource = {
      kind: "thread" as const,
      threadId: "thr_1",
      projectId: "proj_1",
      label: "@thr",
    };
    const result = serialize([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "first" }] },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "ping " },
                  {
                    type: "mention",
                    attrs: { resource, serializedText: "@thr" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.text).toBe("- first\n- ping @thr");
    expect(result.mentions).toHaveLength(1);
    expect(
      result.text.slice(result.mentions[0]!.start, result.mentions[0]!.end),
    ).toBe("@thr");
  });

  it("keeps a mention's offset correct inside an ordered list with a custom start", () => {
    const resource = {
      kind: "thread" as const,
      threadId: "thr_1",
      projectId: "proj_1",
      label: "@thr",
    };
    const result = serialize([
      {
        type: "orderedList",
        attrs: { start: 10 },
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "ping " },
                  {
                    type: "mention",
                    attrs: { resource, serializedText: "@thr" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(result.text).toBe("10. ping @thr");
    expect(result.mentions).toHaveLength(1);
    expect(
      result.text.slice(result.mentions[0]!.start, result.mentions[0]!.end),
    ).toBe("@thr");
  });
});

describe("prompt editor serialization", () => {
  it("builds a project mention resource from a project suggestion", () => {
    expect(
      promptMentionResourceFromSuggestion({
        kind: "project",
        path: "project:proj_abc",
        replacement: "project:proj_abc",
        projectId: "proj_abc",
        name: "Alpha Service",
      }),
    ).toEqual({
      kind: "project",
      projectId: "proj_abc",
      label: "Alpha Service",
    });
  });

  it("round-trips a project mention through the editor document", () => {
    const value: PromptEditorValue = {
      text: "look at @project:proj_abc please",
      mentions: [
        {
          start: "look at ".length,
          end: "look at @project:proj_abc".length,
          resource: {
            kind: "project",
            projectId: "proj_abc",
            label: "Alpha Service",
          },
        },
      ],
    };

    expect(roundTrip(value)).toEqual(value);
  });

  it("builds a section mention resource from a section suggestion", () => {
    expect(
      promptMentionResourceFromSuggestion({
        kind: "section",
        path: "section:sec_abc",
        replacement: "section:sec_abc",
        sectionId: "sec_abc",
        name: "Release work",
      }),
    ).toEqual({
      kind: "section",
      sectionId: "sec_abc",
      label: "Release work",
    });
  });

  it("builds command mention resources from provider command suggestions", () => {
    expect(
      promptCommandResourceFromSuggestion({
        trigger: "/",
        suggestion: {
          kind: "command",
          name: "review",
          source: "skill",
          origin: "user",
          description: "Review code changes",
          argumentHint: "<files>",
        },
      }),
    ).toEqual({
      kind: "command",
      trigger: "/",
      name: "review",
      source: "skill",
      origin: "user",
      label: "review",
      argumentHint: "<files>",
    });
  });

  it("serializes a selected skill as a pill without materializing argument hint text", () => {
    const text = "/review ";
    const mentions: PromptTextMention[] = [
      {
        start: 0,
        end: "/review".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "review",
          source: "skill",
          origin: "user",
          label: "review",
          argumentHint: "<files>",
        },
      },
    ];

    expect(promptEditorInlineContentFromValue({ text, mentions })).toEqual([
      {
        type: "mention",
        attrs: {
          resource: mentions[0].resource,
          serializedText: "/review",
        },
      },
      { type: "text", text: " " },
    ]);
  });
});
