import { mergeAttributes } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { PromptMentionPillNodeView } from "./PromptMentionPillNodeView";
import { parsePromptEditorMentionAttrs } from "./prompt-editor-serialization";
import {
  PROMPT_MENTION_PILL_CLASS,
  promptMentionIconLabel,
  promptMentionTooltipLabel,
} from "@/components/promptbox/mentions/prompt-mention-display";
import { promptMentionClipboardDataAttributes } from "@/components/promptbox/mentions/prompt-mention-clipboard";

interface MentionRenderArgs {
  node: Pick<ProseMirrorNode, "attrs">;
}

type ParsedMentionAttrs = ReturnType<typeof parsePromptEditorMentionAttrs>;

function renderMentionText({ node }: MentionRenderArgs): string {
  const attrs = parsePromptEditorMentionAttrs(node.attrs);
  return attrs?.serializedText ?? "";
}

function renderMentionLabel(attrs: ParsedMentionAttrs): string {
  if (!attrs) return "@mention";
  return `${promptMentionIconLabel(attrs.resource)}: ${attrs.resource.label}`;
}

function renderMentionTitle(attrs: ParsedMentionAttrs): string {
  return attrs ? promptMentionTooltipLabel(attrs.resource) : "@mention";
}

export const PromptMentionExtension = Mention.extend({
  addAttributes() {
    const parentAttributes = this.parent?.() ?? {};
    return {
      ...parentAttributes,
      resource: {
        default: null,
      },
      serializedText: {
        default: null,
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(PromptMentionPillNodeView);
  },
  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? [];
    const mentionName = this.name;
    return [
      ...parentPlugins,
      new Plugin({
        props: {
          decorations(state) {
            const { selection } = state;
            const decorations: Decoration[] = [];
            if (!selection.empty) {
              state.doc.nodesBetween(
                selection.from,
                selection.to,
                (node, pos) => {
                  if (
                    node.type.name === mentionName &&
                    pos >= selection.from &&
                    pos + node.nodeSize <= selection.to
                  ) {
                    decorations.push(
                      Decoration.node(
                        pos,
                        pos + node.nodeSize,
                        {},
                        { mentionSelected: true },
                      ),
                    );
                  }
                },
              );
            }

            return decorations.length > 0
              ? DecorationSet.create(state.doc, decorations)
              : null;
          },
        },
      }),
    ];
  },
}).configure({
  deleteTriggerWithBackspace: true,
  renderText: renderMentionText,
  renderHTML({ node, options }) {
    const attrs = parsePromptEditorMentionAttrs(node.attrs);
    const clipboardAttributes = attrs
      ? promptMentionClipboardDataAttributes(attrs)
      : { "data-prompt-mention": "true" };
    return [
      "span",
      mergeAttributes(options.HTMLAttributes, {
        class: PROMPT_MENTION_PILL_CLASS,
        ...clipboardAttributes,
        title: renderMentionTitle(attrs),
      }),
      renderMentionLabel(attrs),
    ];
  },
  suggestion: {
    char: "@",
    items: () => [],
    render: () => ({
      onStart: () => undefined,
      onUpdate: () => undefined,
      onExit: () => undefined,
    }),
  },
});
