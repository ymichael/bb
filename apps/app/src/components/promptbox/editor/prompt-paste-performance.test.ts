import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Node } from "@tiptap/pm/model";
import { PromptMentionExtension } from "./prompt-mention-extension";
import {
  promptEditorContentFromValue,
  promptEditorInlineContentFromValue,
  promptEditorValueFromDoc,
} from "./prompt-editor-serialization";
import { findUltracodeRanges } from "./prompt-decoration-extension";
import { findActiveTrigger } from "@bb/client-core";
import type { TypeaheadTrigger } from "@bb/client-core";
import { serializePromptDraftStorage } from "@bb/client-core";
import { generateMinifiedJsFixture } from "@/test/fixtures/minified-js-paste-fixture";

const PERF_ENABLED = process.env.PROMPTBOX_PERF === "1";

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

const TRIGGERS: readonly TypeaheadTrigger[] = [
  { char: "@", kind: "mention" },
  { char: "/", kind: "command" },
];

const FIXTURE_SIZES = [128 * 1024, 512 * 1024, 1024 * 1024] as const;

function measureMs(iterations: number, run: () => unknown): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

function formatMs(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

describe.runIf(PERF_ENABLED)("composer large minified-JS paste", () => {
  const fixtureOut = process.env.PROMPTBOX_PERF_FIXTURE_OUT;
  if (fixtureOut) {
    it("writes the manual-repro fixture file", () => {
      const text = generateMinifiedJsFixture({
        approximateLength: 1024 * 1024,
      });
      writeFileSync(fixtureOut, text);
      console.log(
        `fixture written: ${fixtureOut} (${text.length} chars, single line)`,
      );
      expect(text.length).toBeGreaterThan(1024 * 1024);
    });
  }

  for (const size of FIXTURE_SIZES) {
    const label = `${Math.round(size / 1024)}KB`;

    it(`measures paste + per-keystroke hot path at ${label}`, () => {
      const text = generateMinifiedJsFixture({ approximateLength: size });
      const value = { text, mentions: [] };
      const lines: string[] = [`--- fixture ${label} (${text.length} chars)`];

      const plainPasteMs = measureMs(5, () =>
        promptEditorInlineContentFromValue(value),
      );
      lines.push(
        `paste: inline content (plain)          ${formatMs(plainPasteMs)}ms`,
      );

      const richMs = measureMs(3, () =>
        promptEditorContentFromValue(value, { richTextMarkdown: true }),
      );
      lines.push(
        `paste/mount: content (richTextMarkdown) ${formatMs(richMs)}ms`,
      );

      const doc = Node.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: promptEditorInlineContentFromValue(value),
          },
        ],
      });

      const serializeMs = measureMs(7, () => promptEditorValueFromDoc(doc));
      lines.push(
        `keystroke: full-doc serialize (×1)     ${formatMs(serializeMs)}ms`,
      );

      const valueKeyMs = measureMs(7, () => JSON.stringify(value));
      lines.push(
        `value JSON.stringify (2×/keystroke pre-fix; now ref-compare) ${formatMs(valueKeyMs)}ms`,
      );

      const decorationRegexMs = measureMs(7, () => findUltracodeRanges(text));
      lines.push(
        `decoration rule regex (sync/keystroke pre-fix; now deferred on large docs) ${formatMs(decorationRegexMs)}ms`,
      );

      const caretEditor = {
        state: {
          selection: { empty: true, from: doc.content.size - 1 },
          doc,
        },
      };
      const triggerMs = measureMs(7, () =>
        findActiveTrigger(caretEditor, TRIGGERS),
      );
      lines.push(
        `keystroke: findActiveTrigger           ${formatMs(triggerMs)}ms`,
      );

      const draft = { text, mentions: [], attachments: [] };
      const draftSerializeMs = measureMs(7, () =>
        serializePromptDraftStorage(draft),
      );
      lines.push(
        `draft JSON serialize (per keystroke pre-fix; now per 250ms flush) ${formatMs(draftSerializeMs)}ms`,
      );

      console.log(lines.join("\n"));
      expect(text.length).toBeGreaterThanOrEqual(size);
      expect(text).not.toContain("\n");
    });
  }
});

describe.runIf(!PERF_ENABLED)("composer paste perf harness (gated)", () => {
  it("is skipped unless PROMPTBOX_PERF=1", () => {
    expect(PERF_ENABLED).toBe(false);
  });
});
