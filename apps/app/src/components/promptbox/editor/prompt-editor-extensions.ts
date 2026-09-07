import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import type { AnyExtension } from "@tiptap/react";
import {
  PromptDecorationExtension,
  type PromptDecorationExtensionOptions,
} from "./prompt-decoration-extension";
import { PromptMentionExtension } from "./prompt-mention-extension";

interface PromptEditorExtensionsOptions extends PromptDecorationExtensionOptions {
  richTextEditing: boolean;
  getPlaceholder: () => string;
}

export function promptEditorExtensions({
  richTextEditing,
  getPlaceholder,
  getDecorationSources,
  getDraftObservers,
  draftObserverDebounceMs,
  onRuleError,
}: PromptEditorExtensionsOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      blockquote: {},
      bold: richTextEditing ? {} : false,
      bulletList: richTextEditing ? {} : false,
      code: richTextEditing ? {} : false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: richTextEditing ? {} : false,
      horizontalRule: false,
      italic: richTextEditing ? {} : false,
      link: false,
      listItem: richTextEditing ? {} : false,
      orderedList: richTextEditing ? {} : false,
      strike: false,
      underline: false,
    }),
    Placeholder.configure({
      placeholder: () => getPlaceholder(),
    }),
    PromptMentionExtension,
    PromptDecorationExtension.configure({
      ...(getDecorationSources !== undefined ? { getDecorationSources } : {}),
      ...(getDraftObservers !== undefined ? { getDraftObservers } : {}),
      ...(draftObserverDebounceMs !== undefined
        ? { draftObserverDebounceMs }
        : {}),
      ...(onRuleError !== undefined ? { onRuleError } : {}),
    }),
  ];
}
