import type {
  PromptMentionCommandTrigger,
  PromptTextMention,
} from "@bb/domain";
import type { ComposerView } from "@get-bb/plugin-sdk";
import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { useEditor, type Editor } from "@tiptap/react";
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  commandPillDismissedRangeEnd,
  findActiveTrigger,
  orderCommandSuggestions,
  type ActiveTrigger,
  type CommandMenuState,
  type ComposerCommandSuggestion,
  type MentionMenuState,
  type OrderedMentionSuggestions,
  type ProviderCommandSuggestion,
  type PromptMentionSuggestion,
  type TypeaheadMenuState,
  type TypeaheadTrigger,
} from "@bb/client-core";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import {
  useAppCommandKeyDispatch,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { canLoadMoreCommandResults } from "@/components/promptbox/mentions/mention-menu-scroll";
import {
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "@/hooks/voice-input-support";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { ComposerActionsSlot } from "@/components/plugin/PluginComposerActions";
import { useResolvedComposerEditor } from "@/components/plugin/composer-slot-hooks";
import {
  composerScopeIdentity,
  PluginComposerViewProvider,
  useOptionalPluginComposerView,
  usePluginComposerHost,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import { useComposerInputLock } from "@/lib/plugin-sdk-hooks";
import {
  COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
  COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import {
  getMediaQuerySnapshot,
  REDUCED_MOTION_QUERY,
} from "@bb/shared-ui/hooks/use-media-query";
import { blurActiveKeyboardInputWithin } from "@bb/shared-ui/overlay-trigger";
import {
  DEFAULT_PLUGIN_MENTION_TRIGGER,
  type PluginMentionTrigger,
} from "@bb/client-core";
import { useRichTextEditingPreference } from "@/lib/rich-text-editing-preference";
import {
  arePromptDraftStatesEqual,
  isPromptDraftEmpty,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import { cn } from "@bb/shared-ui/lib/utils";
import { PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS } from "./banner/PromptStackCard";
import { AttachmentPreview } from "./AttachmentPreview";
import { VoiceRecordingBar } from "./VoiceRecordingBar";
import {
  ComposerPlusMenuSlot,
  type PromptBoxAction,
} from "./PromptBoxActionsMenu";
import type { PromptMentionLinkResolver } from "./editor/prompt-mention-link";
import {
  refreshPromptDecorations,
  type PromptDecorationSource,
  type PromptDraftObserver,
} from "./editor/prompt-decoration-extension";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { promptEditorExtensions } from "./editor/prompt-editor-extensions";
import {
  promptCommandResourceFromSuggestion,
  promptEditorClipboardTextFromSlice,
  promptEditorContentFromValue,
  promptEditorInlineContentFromValue,
  promptEditorValueFromDoc,
  promptEditorValueFromSlice,
  parsePromptEditorMentionAttrs,
  promptMentionResourceFromSuggestion,
  type PromptEditorValue,
} from "./editor/prompt-editor-serialization";
import {
  exitTrailingBlockquoteBreak,
  insertParagraphBeforeBlockquote,
  removeEmptyBlockquotes,
} from "./editor/prompt-editor-blockquote";
import { exitHeading } from "./editor/prompt-editor-heading";
import { applyPromptListNewline } from "./editor/prompt-editor-list";
import { applyPromptParagraphNewline } from "./editor/prompt-editor-paragraph";
import {
  MentionMenu,
  typeaheadSuggestionKey,
  type TypeaheadSuggestion,
} from "./mentions/MentionMenu";
import { parsePromptMentionClipboardElement } from "./mentions/prompt-mention-clipboard";
import { ComposerEditorSlot } from "./ComposerEditorSlot";
import { QueuedEditorTypeaheadLayoutContext } from "./queued-editor-typeahead-layout";

const PROMPTBOX_MIN_HEIGHT = 68;
const PROMPTBOX_SELECTION_REVEAL_MARGIN = 12;
const COMPACT_PROMPT_ACTION_BUTTON_CLASS =
  "size-8 p-0 transition-all [&_svg]:size-4";
const RICH_PASTE_BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "DD",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "MAIN",
  "NAV",
  "P",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
]);
const RICH_PASTE_IGNORED_TAGS = new Set([
  "HEAD",
  "LINK",
  "META",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "TITLE",
]);

function hasWhitespaceAfterPosition(
  doc: ProseMirrorNode,
  position: number,
): boolean {
  const nextNode = doc.resolve(position).nodeAfter;
  if (!nextNode) {
    return false;
  }
  if (nextNode.isText) {
    return /^\s/u.test(nextNode.text ?? "");
  }
  return nextNode.type.name === "hardBreak";
}

type PromptBoxEditorLayout = "thread" | "root-compose";

const COLLAPSING_GRID_CLASS =
  "grid transition-[grid-template-rows] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none";
const VOICE_ACTION_TRANSITION_MS = 180;
type VoiceActionTransition = "entering" | "active" | "exiting";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function shouldFinishVoiceCompletionTransitionImmediately(): boolean {
  return (
    prefersReducedMotion() ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  );
}

export interface PromptBoxSubmissionConfig {
  isSubmitting?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  title?: string;
  isRunning?: boolean;
  onStop?: () => void;
  onModifierSubmit?: () => void;
}

interface PromptSubmitButtonProps {
  canSubmit: boolean;
  className: string;
  disabledReason: string | undefined;
  isBusy: boolean;
  isCompact: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  title: string;
}

function PromptSubmitButton({
  canSubmit,
  className,
  disabledReason,
  isBusy,
  isCompact,
  onClick,
  onPointerDown,
  title,
}: PromptSubmitButtonProps) {
  const button = (
    <Button
      data-promptbox-submit-action=""
      type="submit"
      size={isCompact ? "icon" : "sm"}
      variant="default"
      aria-label={title}
      aria-busy={isBusy}
      disabled={!canSubmit}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={className}
    >
      {isBusy ? (
        <Icon name="Spinner" className="size-4 animate-spin" />
      ) : (
        <Icon name="CornerDownLeft" className="size-4" />
      )}
    </Button>
  );

  if (!disabledReason) return button;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-promptbox-submit-disabled-reason=""
            className="inline-flex shrink-0"
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface TypeaheadMentionConfig {
  triggers?: readonly PluginMentionTrigger[];
  results: OrderedMentionSuggestions;
  isLoading: boolean;
  isError: boolean;
  onQueryChange: (
    query: string | null,
    trigger: PluginMentionTrigger | null,
  ) => void;
  resolveLink?: PromptMentionLinkResolver;
}

export interface TypeaheadCommandConfig {
  trigger: PromptMentionCommandTrigger | null;
  suggestions: readonly ComposerCommandSuggestion[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  onQueryChange: (query: string | null) => void;
  onEditorFocus?: () => void;
}

export interface TypeaheadConfig {
  mention: TypeaheadMentionConfig;
  command: TypeaheadCommandConfig;
}

export const INERT_TYPEAHEAD_COMMAND_CONFIG: TypeaheadCommandConfig = {
  trigger: null,
  suggestions: [],
  isLoading: false,
  isError: false,
  hasMore: false,
  isLoadingMore: false,
  loadMore: () => {},
  onQueryChange: () => {},
};

export interface AttachmentsConfig {
  items?: PromptDraftAttachment[];
  isAttaching?: boolean;
  error?: string | null;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemove?: (path: string) => void;
  projectId?: string;
}

interface PromptBoxCompactConfig {
  isCompact: boolean;
  placeholder?: string;
}

export interface HistoryConfig {
  currentDraft: PromptDraftState;
  entries: readonly PromptDraftState[];
  onSelectEntry: (draft: PromptDraftState) => void;
  resetKey?: string | number;
}

type PromptVoiceState = "idle" | "recording" | "transcribing" | "error";

export interface PromptVoiceConfig {
  state: PromptVoiceState;
  isSupported: boolean;
  unsupportedReason?: VoiceUnsupportedReason | null;
  stream: MediaStream | null;
  start: () => void | Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export interface PromptBoxHandle {
  focusEnd: () => void;
  captureHeightForLayoutChange: () => void;
  insertTextAtCursor: (text: string) => void;
  getTextBeforeCursor: () => string | undefined;
  playVoiceCompletionTransition: () => Promise<void>;
}

export type { PromptBoxAction } from "./PromptBoxActionsMenu";

type MentionMenuPlacement = "top" | "bottom";

interface PromptBoxInternalProps {
  id?: string;
  value: string;
  mentionRanges: readonly PromptTextMention[];
  onChange: (value: string, mentionRanges: PromptTextMention[]) => void;
  onSubmit: () => void;
  onEscape?: () => void;
  blurOnPointerSubmit?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  allowSoftKeyboardAutoFocus?: boolean;
  className?: string;
  textEffects?: readonly ComposerTextEffectSource[];
  onComposerLayoutChange?: (layout: ComposerView["layout"]) => void;
  header?: ReactNode;
  footerStart?: ReactNode;
  submission?: PromptBoxSubmissionConfig;
  minHeight?: number;
  typeahead: TypeaheadConfig;
  mentionMenuPlacement: MentionMenuPlacement;
  attachments?: AttachmentsConfig;
  promptActions?: readonly PromptBoxAction[];
  suppressPluginComposerCustomizations?: boolean;
  editorLayout?: PromptBoxEditorLayout;
  onCollapse?: () => void;
  compact?: PromptBoxCompactConfig;
  containerCompactPlaceholder?: string;
  heightAnimationKey?: string | number;
  history?: HistoryConfig;
  voice?: PromptVoiceConfig;
  promptBoxRef?: Ref<PromptBoxHandle>;
  focusEndKey?: string | number;
}

interface DismissedTriggerRange {
  start: number;
  end: number;
  hasLeftRange: boolean;
}

interface PromptEditorValueKey {
  text: string;
  mentions: readonly PromptTextMention[];
}

const DEFAULT_TYPEAHEAD_MENTION_TRIGGERS = [
  DEFAULT_PLUGIN_MENTION_TRIGGER,
] as const satisfies readonly PluginMentionTrigger[];

interface PromptEditorSelectionRevealArgs {
  editor: Editor;
  scrollContainer: HTMLElement;
}

interface ParsedRichClipboardValue {
  hasMentions: boolean;
  value: PromptEditorValue;
}

type PromptBoxMouseDownEvent = ReactMouseEvent<HTMLFormElement>;

interface PromptActionInsertionRange {
  from: number;
  to: number;
}

interface PromptActionCommand {
  serializedText: string;
  trailingText: string;
  trigger: PromptMentionCommandTrigger;
  suggestion: ProviderCommandSuggestion;
}

const PROMPTBOX_INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[data-prompt-mention='true']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='option']",
].join(",");

export function arePromptEditorValuesEqual(
  left: PromptEditorValueKey | null,
  right: PromptEditorValueKey,
): boolean {
  if (left === null) return false;
  if (left.text !== right.text) return false;
  if (left.mentions === right.mentions) return true;
  if (left.mentions.length !== right.mentions.length) return false;
  for (let index = 0; index < left.mentions.length; index += 1) {
    const leftMention = left.mentions[index]!;
    const rightMention = right.mentions[index]!;
    if (leftMention === rightMention) continue;
    if (
      leftMention.start !== rightMention.start ||
      leftMention.end !== rightMention.end
    ) {
      return false;
    }
    if (
      leftMention.resource !== rightMention.resource &&
      JSON.stringify(leftMention.resource) !==
        JSON.stringify(rightMention.resource)
    ) {
      return false;
    }
  }
  return true;
}

function normalizePastedPlainText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

function promptActionCommandMentionsFromText(
  text: string,
  actions: readonly PromptBoxAction[] | undefined,
): PromptTextMention[] {
  const mentions: PromptTextMention[] = [];

  for (const action of actions ?? []) {
    const commandAction = promptActionCommandFromAction(action);
    if (commandAction === null) {
      continue;
    }

    let searchStart = 0;
    while (searchStart < text.length) {
      const start = text.indexOf(commandAction.serializedText, searchStart);
      if (start === -1) {
        break;
      }

      const end = start + commandAction.serializedText.length;
      const before = start === 0 ? "" : text[start - 1]!;
      const after = end >= text.length ? "" : text[end]!;
      const hasTokenBoundaryBefore = before === "" || /\s/u.test(before);
      const hasTokenBoundaryAfter = after === "" || /\s/u.test(after);

      if (hasTokenBoundaryBefore && hasTokenBoundaryAfter) {
        mentions.push({
          start,
          end,
          resource: promptCommandResourceFromSuggestion({
            suggestion: commandAction.suggestion,
            trigger: commandAction.trigger,
          }),
        });
      }

      searchStart = end;
    }
  }

  return mentions.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

function mergePromptTextMentions(
  baseMentions: readonly PromptTextMention[],
  additionalMentions: readonly PromptTextMention[],
): PromptTextMention[] {
  const merged = [...baseMentions].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  for (const additionalMention of additionalMentions) {
    const overlapsExisting = merged.some(
      (mention) =>
        additionalMention.start < mention.end &&
        additionalMention.end > mention.start,
    );
    if (!overlapsExisting) {
      merged.push(additionalMention);
    }
  }

  return merged.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

function withPromptActionCommandMentions(
  value: PromptEditorValue,
  promptActions: readonly PromptBoxAction[] | undefined,
): PromptEditorValue {
  const promptActionMentions = promptActionCommandMentionsFromText(
    value.text,
    promptActions,
  );
  if (promptActionMentions.length === 0) {
    return value;
  }

  return {
    ...value,
    mentions: mergePromptTextMentions(value.mentions, promptActionMentions),
  };
}

function promptEditorValueFromPlainText(
  text: string,
  promptActions?: readonly PromptBoxAction[],
): PromptEditorValue {
  const normalizedText = normalizePastedPlainText(text);
  return withPromptActionCommandMentions(
    {
      text: normalizedText,
      mentions: [],
    },
    promptActions,
  );
}

function promptEditorSliceHasBlockquote(slice: Slice): boolean {
  let hasBlockquote = false;
  slice.content.descendants((node) => {
    if (node.type.name === "blockquote") {
      hasBlockquote = true;
      return false;
    }
    return true;
  });
  return hasBlockquote;
}

function plainTextHasQuoteLine(text: string): boolean {
  return normalizePastedPlainText(text)
    .split("\n")
    .some((line) => line === ">" || line.startsWith("> "));
}

function trimTrailingPromptNewlines(
  value: PromptEditorValue,
): PromptEditorValue {
  const text = value.text.replace(/\n+$/u, "");
  if (text.length === value.text.length) {
    return value;
  }

  return {
    text,
    mentions: value.mentions.filter((mention) => mention.end <= text.length),
  };
}

function promptEditorValueFromRichHtml(html: string): ParsedRichClipboardValue {
  const document = new DOMParser().parseFromString(html, "text/html");
  let text = "";
  let hasMentions = false;
  const mentions: PromptTextMention[] = [];

  const appendNewline = () => {
    text = text.replace(/[ \t]+$/u, "");
    if (text.length > 0 && !text.endsWith("\n")) {
      text += "\n";
    }
  };

  const appendCollapsedText = (rawText: string) => {
    const collapsedText = rawText.replace(/\s+/gu, " ");
    if (collapsedText.trim().length === 0) {
      if (text.length > 0 && !/[\s]$/u.test(text)) {
        text += " ";
      }
      return;
    }
    text += collapsedText;
  };

  const appendClipboardMention = (element: Element): boolean => {
    const payload = parsePromptMentionClipboardElement({ element });
    if (!payload) {
      return false;
    }

    const start = text.length;
    text += payload.serializedText;
    mentions.push({
      start,
      end: text.length,
      resource: payload.resource,
    });
    hasMentions = true;
    return true;
  };

  const visitChildren = (node: Node, preserveWhitespace: boolean) => {
    for (const childNode of node.childNodes) {
      visitNode(childNode, preserveWhitespace);
    }
  };

  const visitNode = (node: Node, preserveWhitespace: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent ?? "";
      if (preserveWhitespace) {
        text += normalizePastedPlainText(rawText);
        return;
      }
      appendCollapsedText(rawText);
      return;
    }

    if (!(node instanceof Element)) {
      visitChildren(node, preserveWhitespace);
      return;
    }

    const tagName = node.tagName.toUpperCase();
    if (RICH_PASTE_IGNORED_TAGS.has(tagName)) {
      return;
    }
    if (appendClipboardMention(node)) {
      return;
    }
    if (tagName === "BR") {
      appendNewline();
      return;
    }
    if (tagName === "PRE") {
      appendNewline();
      text += normalizePastedPlainText(node.textContent ?? "");
      appendNewline();
      return;
    }
    if (tagName === "LI") {
      appendNewline();
      text += "- ";
      visitChildren(node, preserveWhitespace);
      appendNewline();
      return;
    }
    if (RICH_PASTE_BLOCK_TAGS.has(tagName)) {
      appendNewline();
      visitChildren(node, preserveWhitespace);
      appendNewline();
      return;
    }

    visitChildren(node, preserveWhitespace);
  };

  visitChildren(document.body, false);

  if (hasMentions) {
    const trimmedText = text.replace(/\n+$/u, "");
    return {
      hasMentions,
      value: {
        text: trimmedText,
        mentions: mentions.filter(
          (mention) =>
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= trimmedText.length,
        ),
      },
    };
  }

  return {
    hasMentions,
    value: {
      text: text
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n")
        .replace(/^\n+/u, "")
        .replace(/\n+$/u, ""),
      mentions: [],
    },
  };
}

function promptEditorValueFromClipboardPaste(
  clipboardData: DataTransfer | null,
  promptActions?: readonly PromptBoxAction[],
): PromptEditorValue | null {
  const html = clipboardData?.getData("text/html") ?? "";
  const hasHtml = html.trim().length > 0;
  if (hasHtml) {
    const richValue = promptEditorValueFromRichHtml(html);
    if (richValue.hasMentions) {
      return withPromptActionCommandMentions(richValue.value, promptActions);
    }
  }

  const plainText = clipboardData?.getData("text/plain") ?? "";
  if (plainText.length > 0) {
    return promptEditorValueFromPlainText(plainText, promptActions);
  }

  if (!hasHtml) {
    return null;
  }

  return promptEditorValueFromRichHtml(html).value;
}

function runAfterClipboardCut(callback: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }

  setTimeout(callback, 0);
}

function revealPromptEditorSelection({
  editor,
  scrollContainer,
}: PromptEditorSelectionRevealArgs): void {
  const scrollContainerRect = scrollContainer.getBoundingClientRect();
  if (scrollContainerRect.height <= 0) return;

  let selectionRect: ReturnType<Editor["view"]["coordsAtPos"]>;
  try {
    selectionRect = editor.view.coordsAtPos(editor.state.selection.head);
  } catch {
    return;
  }

  const topOverflow =
    selectionRect.top -
    scrollContainerRect.top -
    PROMPTBOX_SELECTION_REVEAL_MARGIN;
  if (topOverflow < 0) {
    scrollContainer.scrollTop = Math.max(
      0,
      scrollContainer.scrollTop + topOverflow,
    );
    return;
  }

  const bottomOverflow =
    selectionRect.bottom -
    scrollContainerRect.bottom +
    PROMPTBOX_SELECTION_REVEAL_MARGIN;
  if (bottomOverflow > 0) {
    scrollContainer.scrollTop += bottomOverflow;
  }
}

function isPromptBoxChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  return target.closest(PROMPTBOX_INTERACTIVE_TARGET_SELECTOR) === null;
}

function promptActionTextImmediatelyBeforeCursor(
  editor: Editor,
  actionText: string,
): boolean {
  if (!editor.state.selection.empty) {
    return false;
  }

  const before = editor.state.doc.textBetween(
    0,
    editor.state.selection.from,
    "\n",
    "\n",
  );
  return before.endsWith(actionText);
}

function promptActionCommandSerializedText(action: PromptBoxAction): string {
  if (!action.command) {
    return action.text;
  }
  return `${action.command.trigger}${action.command.name}`;
}

function isPromptActionCommandMention(
  node: ProseMirrorNode,
  actions: readonly PromptBoxAction[],
): boolean {
  if (node.type.name !== "mention") {
    return false;
  }
  const attrs = parsePromptEditorMentionAttrs(node.attrs);
  if (!attrs || attrs.resource.kind !== "command") {
    return false;
  }
  const resource = attrs.resource;
  return actions.some((action) => {
    const command = action.command;
    if (!command) {
      return false;
    }
    return (
      resource.trigger === command.trigger &&
      resource.name === command.name &&
      attrs.serializedText === promptActionCommandSerializedText(action)
    );
  });
}

function findPromptActionTextSuffix(
  text: string,
  actions: readonly PromptBoxAction[],
): PromptBoxAction | null {
  return (
    actions.find(
      (action) =>
        !action.command && action.text.length > 0 && text.endsWith(action.text),
    ) ?? null
  );
}

function getPromptActionRangeImmediatelyBeforeCursor({
  editor,
  actions,
}: {
  editor: Editor;
  actions: readonly PromptBoxAction[];
}): PromptActionInsertionRange | null {
  const selection = editor.state.selection;
  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  const cursorOffset = $from.parentOffset;
  const parentStart = $from.start();
  let searchOffset = cursorOffset;

  while (searchOffset > 0) {
    const previous = $from.parent.childBefore(searchOffset);
    const node = previous.node;
    if (!node) {
      return null;
    }
    const sizeBeforeSearchOffset = searchOffset - previous.offset;
    if (node.isText) {
      const textBeforeCursor = (node.text ?? "").slice(
        0,
        sizeBeforeSearchOffset,
      );
      const textAction = findPromptActionTextSuffix(textBeforeCursor, actions);
      if (textAction) {
        return {
          from:
            parentStart +
            previous.offset +
            textBeforeCursor.length -
            textAction.text.length,
          to: selection.from,
        };
      }
      if (/\S/u.test(textBeforeCursor)) {
        return null;
      }
      searchOffset = previous.offset;
      continue;
    }
    if (
      sizeBeforeSearchOffset === node.nodeSize &&
      isPromptActionCommandMention(node, actions)
    ) {
      return {
        from: parentStart + previous.offset,
        to: selection.from,
      };
    }
    return null;
  }

  return null;
}

function getPromptActionInsertionRange({
  editor,
  action,
  actions,
  triggers,
}: {
  editor: Editor;
  action: PromptBoxAction;
  actions: readonly PromptBoxAction[];
  triggers: readonly TypeaheadTrigger[];
}): PromptActionInsertionRange | null {
  const selection = editor.state.selection;
  if (!selection.empty) {
    return { from: selection.from, to: selection.to };
  }

  const previousPromptActionRange = getPromptActionRangeImmediatelyBeforeCursor(
    {
      editor,
      actions,
    },
  );
  if (previousPromptActionRange !== null) {
    return previousPromptActionRange;
  }

  const activeCommandTrigger = findActiveTrigger(editor, triggers);
  const isActiveCommand =
    activeCommandTrigger !== null && activeCommandTrigger.kind === "command";

  if (action.kind === "skills") {
    if (
      isActiveCommand &&
      activeCommandTrigger.char === action.text &&
      activeCommandTrigger.to === selection.from
    ) {
      return null;
    }
    return { from: selection.from, to: selection.to };
  }

  if (isActiveCommand && activeCommandTrigger.to === selection.from) {
    return {
      from: activeCommandTrigger.from,
      to: activeCommandTrigger.to,
    };
  }

  return { from: selection.from, to: selection.to };
}

function promptActionCommandFromAction(
  action: PromptBoxAction,
): PromptActionCommand | null {
  if (action.kind === "skills" || !action.command) {
    return null;
  }

  const { trigger, name, trailingText } = action.command;
  const serializedText = `${trigger}${name}`;
  return {
    serializedText,
    trailingText,
    trigger,
    suggestion: {
      kind: "command",
      name,
      source: "command",
      origin: "user",
      description: null,
      argumentHint: null,
    },
  };
}

function promptActionTriggers(
  triggers: readonly TypeaheadTrigger[],
  commandAction: PromptActionCommand | null,
): readonly TypeaheadTrigger[] {
  if (commandAction === null) {
    return triggers;
  }
  if (
    triggers.some(
      (trigger) =>
        trigger.kind === "command" && trigger.char === commandAction.trigger,
    )
  ) {
    return triggers;
  }
  return [
    ...triggers,
    { kind: "command", char: commandAction.trigger },
  ] satisfies TypeaheadTrigger[];
}

export function suppressPromptEditorAnchorActivation(event: Event): boolean {
  if (!(event.target instanceof Element)) return false;
  if (event.target.closest("a[href]") === null) return false;

  event.preventDefault();
  event.stopPropagation();
  return true;
}

function blurPromptEditor(editor: Editor | null | undefined): void {
  editor?.view.dom.blur();
  window.getSelection()?.removeAllRanges();
}

function focusEditorAtEnd(editor: Editor): void {
  const transaction = editor.state.tr
    .setSelection(TextSelection.atEnd(editor.state.doc))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.focus();
}

const SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS = 500;

function isIPadOSWebKit(): boolean {
  if (typeof navigator === "undefined") return false;

  const isAppleWebKit =
    /Apple Computer/u.test(navigator.vendor) &&
    /\bAppleWebKit\//u.test(navigator.userAgent);
  const isIPad =
    navigator.platform === "iPad" ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 2);
  return isAppleWebKit && isIPad;
}

function usePostCompositionKeyDownEvents(): WeakSet<KeyboardEvent> {
  const ref = useRef<WeakSet<KeyboardEvent> | null>(null);
  ref.current ??= new WeakSet<KeyboardEvent>();
  return ref.current;
}

function isIPadHardwareEnterCandidate(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.code === "Enter" || event.code === "NumpadEnter")
  );
}

export function PromptBoxInternal({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit,
  onEscape,
  blurOnPointerSubmit = false,
  placeholder = "Ask anything. @ to mention files, folders, or sections",
  autoFocus = true,
  allowSoftKeyboardAutoFocus = false,
  className,
  textEffects,
  onComposerLayoutChange,
  header,
  footerStart,
  submission = {},
  minHeight = PROMPTBOX_MIN_HEIGHT,
  typeahead,
  mentionMenuPlacement,
  attachments: attachmentConfig = {},
  promptActions,
  suppressPluginComposerCustomizations = false,
  editorLayout = "thread",
  onCollapse,
  compact,
  containerCompactPlaceholder,
  heightAnimationKey,
  history,
  voice,
  promptBoxRef,
  focusEndKey,
}: PromptBoxInternalProps) {
  const focusComposerShortcut = useAppCommandShortcut("composer.focus");
  const {
    isSubmitting = false,
    disabled: submitDisabled = false,
    disabledReason: submitDisabledReason,
    title: submitTitle = "Submit (Enter)",
    isRunning = false,
    onStop,
    onModifierSubmit,
  } = submission;
  const {
    triggers: mentionTriggerChars = DEFAULT_TYPEAHEAD_MENTION_TRIGGERS,
    results: mentionResults,
    isLoading: mentionLoading,
    isError: mentionError,
    onQueryChange: onMentionQueryChange,
    resolveLink: mentionResolveLink,
  } = typeahead.mention;
  const {
    trigger: commandTriggerChar,
    suggestions: commandSuggestions,
    isLoading: commandLoading,
    isError: commandError,
    onQueryChange: onCommandQueryChange,
    onEditorFocus: onCommandEditorFocus,
  } = typeahead.command;
  const onCommandEditorFocusRef = useRef(onCommandEditorFocus);
  useEffect(() => {
    onCommandEditorFocusRef.current = onCommandEditorFocus;
  }, [onCommandEditorFocus]);
  const {
    items: attachments = [],
    isAttaching = false,
    error: attachmentError = null,
    onAttachFiles,
    onRemove: onRemoveAttachment,
    projectId: attachmentProjectId,
  } = attachmentConfig;
  const isPointerCoarse = usePointerCoarse();
  const isIPadOSWebKitDevice = useMemo(isIPadOSWebKit, []);
  const editorEnterKeyHint = isPointerCoarse ? "enter" : "send";
  const shouldAvoidSoftKeyboardAutofocus =
    isPointerCoarse && !allowSoftKeyboardAutoFocus;
  const formRef = useRef<HTMLFormElement>(null);
  const typeaheadMenuRef = useRef<HTMLDivElement>(null);
  const reportQueuedEditorTypeaheadLayout = useContext(
    QueuedEditorTypeaheadLayoutContext,
  );
  const blurAfterPointerSubmitRef = useRef(false);
  const heightAnimationFromRef = useRef<number | null>(null);
  const capturePromptBoxHeight = useCallback(() => {
    const formElement = formRef.current;
    heightAnimationFromRef.current =
      formElement?.getBoundingClientRect().height ?? null;
  }, []);
  useLayoutEffect(() => {
    const formElement = formRef.current;
    if (!formElement) return;
    if (containerCompactPlaceholder === undefined) {
      formElement.style.removeProperty(
        "--promptbox-container-compact-placeholder",
      );
      return;
    }
    formElement.style.setProperty(
      "--promptbox-container-compact-placeholder",
      JSON.stringify(containerCompactPlaceholder),
    );
  }, [containerCompactPlaceholder]);
  const editorRef = useRef<Editor | null>(null);
  const editorScrollContainerRef = useRef<HTMLDivElement>(null);
  const revealSelectionFrameRef = useRef<number | null>(null);
  const promptActionFocusFrameRef = useRef<number | null>(null);
  const pendingFocusEndRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const mentionRangesRef = useRef<readonly PromptTextMention[]>(mentionRanges);
  const placeholderRef = useRef(placeholder);
  const skipEditorChangeRef = useRef(false);
  const lastSyncedEditorValueRef = useRef<PromptEditorValueKey | null>(null);
  const triggerKeyRef = useRef("");
  const handleEditorKeyDownRef = useRef<
    (event: KeyboardEvent, isOriginalIPadHardwareEnter?: boolean) => boolean
  >(() => false);
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const postCompositionKeyDownEvents = usePostCompositionKeyDownEvents();
  const dispatchAppCommandKey = useAppCommandKeyDispatch();
  const syncTriggerStateRef = useRef<(editor: Editor) => void>(() => {});
  const onAttachFilesRef = useRef(onAttachFiles);
  const dismissedTriggerRef = useRef<DismissedTriggerRange | null>(null);
  const isRestoringAppliedMentionRef = useRef(false);
  const [activeTrigger, setActiveTrigger] = useState<ActiveTrigger | null>(
    null,
  );
  const [selectedSuggestionKey, setSelectedSuggestionKey] = useState<
    string | null
  >(null);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const [activeHistoryIndex, setActiveHistoryIndex] = useState<number | null>(
    null,
  );
  const [temporaryHistoryDraft, setTemporaryHistoryDraft] =
    useState<PromptDraftState | null>(null);
  const [recalledHistoryDraft, setRecalledHistoryDraft] =
    useState<PromptDraftState | null>(null);
  const hasActiveHistorySessionRef = useRef(false);
  const isVoiceRecording = voice?.state === "recording";
  const isVoiceProcessing = voice?.state === "transcribing";
  const showVoiceActionGroup = isVoiceRecording || isVoiceProcessing;
  const isVoiceBusy = showVoiceActionGroup;
  const voiceActionState = isVoiceRecording
    ? "recording"
    : isVoiceProcessing
      ? "transcribing"
      : null;
  const lastVoiceActionStateRef = useRef<"recording" | "transcribing">(
    voiceActionState ?? "recording",
  );
  const renderedVoiceActionState =
    voiceActionState ?? lastVoiceActionStateRef.current;
  useLayoutEffect(() => {
    if (voiceActionState !== null) {
      lastVoiceActionStateRef.current = voiceActionState;
    }
  }, [voiceActionState]);
  const [isVoiceActionPresent, setIsVoiceActionPresent] =
    useState(showVoiceActionGroup);
  const [voiceActionTransition, setVoiceActionTransition] =
    useState<VoiceActionTransition>(
      showVoiceActionGroup ? "active" : "exiting",
    );
  const isVoiceActionVisible = voiceActionTransition === "active";
  const wasVoiceActionShownRef = useRef(showVoiceActionGroup);
  const voiceActionRevealFrameRef = useRef<number | null>(null);
  const voiceActionRemovalTimeoutRef = useRef<number | null>(null);
  const voiceCompletionTimeoutRef = useRef<number | null>(null);
  const voiceCompletionPromiseRef = useRef<Promise<void> | null>(null);
  const voiceCompletionResolveRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const wasVoiceActionShown = wasVoiceActionShownRef.current;
    wasVoiceActionShownRef.current = showVoiceActionGroup;
    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }
    if (voiceActionRemovalTimeoutRef.current !== null) {
      window.clearTimeout(voiceActionRemovalTimeoutRef.current);
      voiceActionRemovalTimeoutRef.current = null;
    }

    if (showVoiceActionGroup) {
      setIsVoiceActionPresent(true);
      if (wasVoiceActionShown || prefersReducedMotion()) {
        setVoiceActionTransition("active");
        return;
      }
      setVoiceActionTransition("entering");
      voiceActionRevealFrameRef.current = window.requestAnimationFrame(() => {
        voiceActionRevealFrameRef.current = null;
        setVoiceActionTransition("active");
      });
      return;
    }

    setVoiceActionTransition("exiting");
    if (!wasVoiceActionShown) {
      setIsVoiceActionPresent(false);
      return;
    }
    if (prefersReducedMotion()) {
      setIsVoiceActionPresent(false);
      return;
    }
    voiceActionRemovalTimeoutRef.current = window.setTimeout(() => {
      voiceActionRemovalTimeoutRef.current = null;
      setIsVoiceActionPresent(false);
    }, VOICE_ACTION_TRANSITION_MS);
  }, [showVoiceActionGroup]);

  useEffect(
    () => () => {
      if (voiceActionRevealFrameRef.current !== null) {
        window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      }
      if (voiceActionRemovalTimeoutRef.current !== null) {
        window.clearTimeout(voiceActionRemovalTimeoutRef.current);
      }
      if (voiceCompletionTimeoutRef.current !== null) {
        window.clearTimeout(voiceCompletionTimeoutRef.current);
      }
      voiceCompletionResolveRef.current?.();
    },
    [],
  );

  const playVoiceCompletionTransition = useCallback((): Promise<void> => {
    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }
    setVoiceActionTransition("exiting");
    if (shouldFinishVoiceCompletionTransitionImmediately()) {
      if (voiceCompletionTimeoutRef.current !== null) {
        window.clearTimeout(voiceCompletionTimeoutRef.current);
        voiceCompletionTimeoutRef.current = null;
      }
      const resolvePendingTransition = voiceCompletionResolveRef.current;
      voiceCompletionPromiseRef.current = null;
      voiceCompletionResolveRef.current = null;
      resolvePendingTransition?.();
      return Promise.resolve();
    }
    if (voiceCompletionPromiseRef.current) {
      return voiceCompletionPromiseRef.current;
    }

    const transition = new Promise<void>((resolve) => {
      voiceCompletionResolveRef.current = resolve;
      voiceCompletionTimeoutRef.current = window.setTimeout(() => {
        voiceCompletionTimeoutRef.current = null;
        voiceCompletionPromiseRef.current = null;
        voiceCompletionResolveRef.current = null;
        resolve();
      }, VOICE_ACTION_TRANSITION_MS);
    });
    voiceCompletionPromiseRef.current = transition;
    return transition;
  }, []);
  const showCompactLayout =
    compact?.isCompact === true && !showVoiceActionGroup;
  const effectivePlaceholder = showCompactLayout
    ? (compact.placeholder ?? placeholder)
    : placeholder;
  const pluginComposerHost = usePluginComposerHost();
  const composerInputLocked = useComposerInputLock(
    pluginComposerHost?.textEffectKey ?? null,
  );
  const composerLayout = showCompactLayout ? "compact" : "expanded";
  const localComposerView = usePluginComposerViewModel({
    scope: pluginComposerHost?.scope ?? {
      kind: "new-thread",
      projectId: null,
    },
    layout: composerLayout,
    text: value,
    attachmentCount: attachments.length,
    isRunning,
    isSubmitting,
  });
  const composerView = useOptionalPluginComposerView() ?? localComposerView;
  const composerViewRef = useRef(composerView);
  composerViewRef.current = composerView;
  const composerScopeKey = composerScopeIdentity(composerView.scope);
  const resolvedComposerEditor = useResolvedComposerEditor(
    suppressPluginComposerCustomizations ? null : composerView.scope.kind,
  );
  useEffect(() => {
    onComposerLayoutChange?.(composerLayout);
  }, [composerLayout, onComposerLayoutChange]);
  const pluginRichTextContributions = useMemo(() => {
    const sources: PromptDecorationSource[] = [];
    const observers: PromptDraftObserver[] = [];
    for (const contribution of resolvedComposerEditor.effects) {
      sources.push({
        id: `${contribution.pluginId}/${contribution.customizationId}`,
        generation: contribution.generation,
        pluginId: contribution.pluginId,
        effects: contribution.effects,
      });
    }
    for (const contribution of resolvedComposerEditor.observers) {
      observers.push({
        id: `${contribution.pluginId}/${contribution.customizationId}`,
        getView: () => composerViewRef.current,
        onDraftChange: contribution.onDraftChange,
      });
    }
    for (const effectSource of textEffects ?? []) {
      const className = effectSource.effect.className;
      if (className.length === 0) continue;
      sources.push({
        id: `plugin-imperative:${effectSource.pluginId}:${effectSource.order}`,
        generation: effectSource.order,
        pluginId: effectSource.pluginId,
        effects: [
          {
            id: "whole-draft",
            className,
            match: (text) =>
              text.length === 0 ? [] : [{ from: 0, to: text.length }],
          },
        ],
      });
    }
    return { sources, observers };
  }, [resolvedComposerEditor, textEffects]);
  const pluginDecorationSourcesRef = useRef(
    pluginRichTextContributions.sources,
  );
  pluginDecorationSourcesRef.current = pluginRichTextContributions.sources;
  const pluginDraftObserversRef = useRef(pluginRichTextContributions.observers);
  pluginDraftObserversRef.current = pluginRichTextContributions.observers;
  const focusScopeKey = history?.resetKey;
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onAttachFilesRef.current = onAttachFiles;
  }, [onAttachFiles]);

  const revealEditorSelection = useCallback(() => {
    const currentEditor = editorRef.current;
    const scrollContainer = editorScrollContainerRef.current;
    if (!currentEditor || currentEditor.isDestroyed || !scrollContainer) return;

    revealPromptEditorSelection({
      editor: currentEditor,
      scrollContainer,
    });
  }, []);

  const scheduleRevealEditorSelection = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      revealEditorSelection();
      return;
    }

    if (revealSelectionFrameRef.current !== null) {
      cancelAnimationFrame(revealSelectionFrameRef.current);
    }

    revealSelectionFrameRef.current = requestAnimationFrame(() => {
      revealSelectionFrameRef.current = null;
      revealEditorSelection();
    });
  }, [revealEditorSelection]);

  useEffect(() => {
    return () => {
      if (revealSelectionFrameRef.current === null) return;
      cancelAnimationFrame(revealSelectionFrameRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (promptActionFocusFrameRef.current === null) return;
      cancelAnimationFrame(promptActionFocusFrameRef.current);
    };
  }, []);

  const triggers = useMemo<TypeaheadTrigger[]>(() => {
    const mentionTriggers = mentionTriggerChars.map((char) => ({
      char,
      kind: "mention" as const,
    }));
    if (commandTriggerChar === null) {
      return mentionTriggers;
    }
    return [...mentionTriggers, { char: commandTriggerChar, kind: "command" }];
  }, [commandTriggerChar, mentionTriggerChars]);

  const dispatchTriggerQuery = useCallback(
    (active: ActiveTrigger | null) => {
      if (active?.kind === "mention") {
        onMentionQueryChange(active.query, active.char);
        onCommandQueryChange(null);
        return;
      }
      if (active?.kind === "command") {
        onCommandQueryChange(active.query);
        onMentionQueryChange(null, null);
        return;
      }
      onMentionQueryChange(null, null);
      onCommandQueryChange(null);
    },
    [onCommandQueryChange, onMentionQueryChange],
  );

  const syncTriggerState = useCallback(
    (editor: Editor) => {
      const caretPosition = editor.state.selection.from;
      let dismissedTrigger = dismissedTriggerRef.current;
      const isRestoringAppliedMention =
        isRestoringAppliedMentionRef.current && dismissedTrigger !== null;
      const detectedTrigger = findActiveTrigger(editor, triggers);
      if (dismissedTrigger && !isRestoringAppliedMention) {
        if (
          !dismissedTrigger.hasLeftRange &&
          detectedTrigger?.from === dismissedTrigger.start
        ) {
          dismissedTrigger = {
            ...dismissedTrigger,
            end: Math.max(dismissedTrigger.end, caretPosition),
          };
          dismissedTriggerRef.current = dismissedTrigger;
        }
        const isWithinDismissedRange =
          caretPosition >= dismissedTrigger.start &&
          caretPosition <= dismissedTrigger.end;

        if (!isWithinDismissedRange) {
          dismissedTriggerRef.current = {
            ...dismissedTrigger,
            hasLeftRange: true,
          };
        } else if (dismissedTrigger.hasLeftRange) {
          dismissedTriggerRef.current = null;
        }
      }

      const shouldSuppressTrigger = Boolean(
        dismissedTriggerRef.current &&
        !dismissedTriggerRef.current.hasLeftRange &&
        (isRestoringAppliedMention ||
          (caretPosition >= dismissedTriggerRef.current.start &&
            caretPosition <= dismissedTriggerRef.current.end)),
      );

      const nextTrigger = shouldSuppressTrigger ? null : detectedTrigger;
      const nextKey = nextTrigger
        ? `${nextTrigger.kind}:${nextTrigger.from}:${nextTrigger.to}:${nextTrigger.query}`
        : "";
      if (nextKey !== triggerKeyRef.current) {
        triggerKeyRef.current = nextKey;
        setSelectedSuggestionKey(null);
      }
      setActiveTrigger(nextTrigger);

      dispatchTriggerQuery(nextTrigger);
    },
    [dispatchTriggerQuery, triggers],
  );

  useEffect(() => {
    syncTriggerStateRef.current = syncTriggerState;
  }, [syncTriggerState]);

  const [richTextEditing] = useRichTextEditingPreference();
  const editorExtensions = useMemo(
    () =>
      promptEditorExtensions({
        richTextEditing,
        getPlaceholder: () => placeholderRef.current,
        getDecorationSources: () => pluginDecorationSourcesRef.current,
        getDraftObservers: () => pluginDraftObserversRef.current,
      }),
    [richTextEditing],
  );

  const initialEditorContent = useMemo(() => {
    const initialValue: PromptEditorValueKey = {
      text: value,
      mentions: mentionRanges,
    };
    return {
      value: initialValue,
      content: promptEditorContentFromValue(initialValue, {
        richTextMarkdown: richTextEditing,
      }),
    };
    // oxlint-disable-next-line react/exhaustive-deps -- value/mentionRanges are read once per editor instance on purpose (see above).
  }, [richTextEditing]);

  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: initialEditorContent.content,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          "aria-label": effectivePlaceholder,
          "data-placeholder": effectivePlaceholder,
          ...(onModifierSubmit ? { "aria-keyshortcuts": "Meta+Enter" } : {}),
          autocomplete: "off",
          class: cn(
            "min-h-full whitespace-pre-wrap break-words outline-none",
            "placeholder:select-none placeholder:text-subtle-foreground",
          ),
          enterkeyhint: editorEnterKeyHint,
          ...(id ? { id } : {}),
          role: "textbox",
        },
        clipboardTextSerializer: (slice, view) =>
          promptEditorClipboardTextFromSlice(slice, view.state.schema),
        handleDOMEvents: {
          auxclick: (_view, event) => {
            return suppressPromptEditorAnchorActivation(event);
          },
          focus: () => {
            onCommandEditorFocusRef.current?.();
            return false;
          },
          blur: () => {
            triggerKeyRef.current = "";
            if (dismissedTriggerRef.current) {
              dismissedTriggerRef.current = {
                ...dismissedTriggerRef.current,
                hasLeftRange: true,
              };
            }
            setActiveTrigger(null);
            onMentionQueryChange(null, null);
            onCommandQueryChange(null);
            return false;
          },
          cut: () => {
            runAfterClipboardCut(() => {
              const currentEditor = editorRef.current;
              if (!currentEditor || currentEditor.isDestroyed) return;
              removeEmptyBlockquotes(currentEditor);
            });
            return false;
          },
          compositionend: (_view, event) => {
            if (!_view.composing) return false;
            compositionEndedAtRef.current = event.timeStamp;
            return false;
          },
          keydown: (_view, event) => {
            if (
              !_view.editable ||
              !isIPadOSWebKitDevice ||
              !isIPadHardwareEnterCandidate(event) ||
              _view.composing ||
              event.isComposing ||
              event.keyCode === 229
            ) {
              return false;
            }

            if (
              Math.abs(event.timeStamp - compositionEndedAtRef.current) <
              SAFARI_POST_COMPOSITION_KEYDOWN_WINDOW_MS
            ) {
              compositionEndedAtRef.current = Number.NEGATIVE_INFINITY;
              postCompositionKeyDownEvents.add(event);
              return false;
            }

            return handleEditorKeyDownRef.current(event, true);
          },
          click: (_view, event) => {
            return suppressPromptEditorAnchorActivation(event);
          },
        },
        handleClick: () => {
          const currentEditor = editorRef.current;
          if (!currentEditor) return false;
          syncTriggerStateRef.current(currentEditor);
          return false;
        },
        handleKeyDown: (_view, event) => {
          return handleEditorKeyDownRef.current(event);
        },
        handlePaste: (view, event, slice) => {
          const attachFiles = onAttachFilesRef.current;
          const clipboardItems = Array.from(event.clipboardData?.items ?? []);
          const pastedFiles = clipboardItems
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);

          if (attachFiles && pastedFiles.length > 0) {
            event.preventDefault();
            void attachFiles(pastedFiles);
          }

          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          const sliceHasBlockquote = promptEditorSliceHasBlockquote(slice);
          if (sliceHasBlockquote || plainTextHasQuoteLine(plainText)) {
            event.preventDefault();
            const pastedValue = trimTrailingPromptNewlines(
              sliceHasBlockquote
                ? promptEditorValueFromSlice(slice, view.state.schema)
                : promptEditorValueFromPlainText(plainText, promptActions),
            );
            if (pastedValue.text.length === 0) return true;

            const currentEditor = editorRef.current;
            const pastedContent =
              promptEditorContentFromValue(pastedValue, {
                richTextMarkdown: richTextEditing,
              }).content ?? [];
            currentEditor
              ?.chain()
              .focus()
              .insertContent(pastedContent)
              .setMeta("uiEvent", "paste")
              .run();
            if (currentEditor && !currentEditor.isDestroyed) {
              const nextValue = trimTrailingPromptNewlines(
                promptEditorValueFromDoc(currentEditor.state.doc),
              );
              lastSyncedEditorValueRef.current = nextValue;
              onChangeRef.current(nextValue.text, nextValue.mentions);
            }
            return true;
          }

          const pastedValue = promptEditorValueFromClipboardPaste(
            event.clipboardData ?? null,
            promptActions,
          );
          if (pastedValue === null) {
            return attachFiles !== undefined && pastedFiles.length > 0;
          }

          event.preventDefault();
          if (pastedValue.text.length === 0) return true;

          editorRef.current
            ?.chain()
            .focus()
            .insertContent(promptEditorInlineContentFromValue(pastedValue))
            .setMeta("uiEvent", "paste")
            .run();
          return true;
        },
      },
      onCreate({ editor: createdEditor }) {
        editorRef.current = createdEditor;
        lastSyncedEditorValueRef.current = initialEditorContent.value;
      },
      onSelectionUpdate({ editor: updatedEditor, transaction }) {
        if (transaction.docChanged) return;
        syncTriggerStateRef.current(updatedEditor);
        scheduleRevealEditorSelection();
      },
      onUpdate({ editor: updatedEditor, transaction }) {
        if (skipEditorChangeRef.current) return;
        const dismissedTrigger = dismissedTriggerRef.current;
        if (
          dismissedTrigger !== null &&
          transaction.docChanged &&
          !isRestoringAppliedMentionRef.current
        ) {
          const mappedStart = transaction.mapping.mapResult(
            dismissedTrigger.start,
            1,
          );
          dismissedTriggerRef.current = mappedStart.deleted
            ? null
            : {
                ...dismissedTrigger,
                start: mappedStart.pos,
                end: transaction.mapping.map(dismissedTrigger.end, -1),
              };
        }
        const nextValue = promptEditorValueFromDoc(updatedEditor.state.doc);
        lastSyncedEditorValueRef.current = nextValue;
        onChangeRef.current(nextValue.text, nextValue.mentions);
        syncTriggerStateRef.current(updatedEditor);
        if (transaction.getMeta("uiEvent") !== undefined) {
          scheduleRevealEditorSelection();
        }
      },
    },
    [richTextEditing],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const editable = !composerInputLocked && !isVoiceBusy;
    if (editor.isEditable !== editable) editor.setEditable(editable);
    editor.view.dom.tabIndex = editable ? 0 : -1;
    if (editable) {
      editor.view.dom.removeAttribute("aria-readonly");
    } else {
      editor.view.dom.setAttribute("aria-readonly", "true");
    }
  }, [composerInputLocked, editor, isVoiceBusy]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    refreshPromptDecorations(editor);
  }, [composerScopeKey, editor, pluginRichTextContributions]);

  useLayoutEffect(() => {
    if (!pendingFocusEndRef.current) return;

    if (isPointerCoarse) {
      pendingFocusEndRef.current = false;
      return;
    }
    if (!editor) return;
    pendingFocusEndRef.current = false;
    focusEditorAtEnd(editor);
    scheduleRevealEditorSelection();
  }, [editor, isPointerCoarse, scheduleRevealEditorSelection]);

  useLayoutEffect(() => {
    placeholderRef.current = effectivePlaceholder;
    if (!editor) return;

    editor.view.dom.setAttribute("aria-label", effectivePlaceholder);
    editor.view.dom.setAttribute("data-placeholder", effectivePlaceholder);
    editor.view.dom.setAttribute("enterkeyhint", editorEnterKeyHint);
    editor.view.dispatch(editor.state.tr);
  }, [editor, editorEnterKeyHint, effectivePlaceholder]);

  useEffect(() => {
    if (!editor) return;
    if (!autoFocus) {
      if (editor.view.dom.contains(document.activeElement)) {
        blurPromptEditor(editor);
      }
      return;
    }
    if (shouldAvoidSoftKeyboardAutofocus) return;

    const focusEditor = () => {
      if (editor.isDestroyed) return;
      focusEditorAtEnd(editor);
      scheduleRevealEditorSelection();
    };

    if (typeof window.requestAnimationFrame !== "function") {
      focusEditor();
      return;
    }

    const handle = window.requestAnimationFrame(focusEditor);
    return () => window.cancelAnimationFrame(handle);
  }, [
    autoFocus,
    editor,
    focusScopeKey,
    scheduleRevealEditorSelection,
    shouldAvoidSoftKeyboardAutofocus,
  ]);

  useEffect(() => {
    mentionRangesRef.current = mentionRanges;
  }, [mentionRanges]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useLayoutEffect(() => {
    if (!editor) return;
    const nextValue = {
      text: value,
      mentions: mentionRanges,
    };
    if (
      arePromptEditorValuesEqual(lastSyncedEditorValueRef.current, nextValue)
    ) {
      return;
    }

    dismissedTriggerRef.current = null;
    triggerKeyRef.current = "";

    try {
      skipEditorChangeRef.current = true;
      editor.commands.setContent(
        promptEditorContentFromValue(nextValue, {
          richTextMarkdown: richTextEditing,
        }),
      );
      lastSyncedEditorValueRef.current = nextValue;
    } finally {
      skipEditorChangeRef.current = false;
    }
    syncTriggerState(editor);
    scheduleRevealEditorSelection();
  }, [
    editor,
    mentionRanges,
    richTextEditing,
    scheduleRevealEditorSelection,
    syncTriggerState,
    value,
  ]);

  const lastFocusEndKeyRef = useRef(focusEndKey);
  useLayoutEffect(() => {
    if (focusEndKey === undefined) return;
    if (focusEndKey === lastFocusEndKeyRef.current) return;
    if (isPointerCoarse) {
      lastFocusEndKeyRef.current = focusEndKey;
      return;
    }
    if (!editor) return;
    lastFocusEndKeyRef.current = focusEndKey;
    focusEditorAtEnd(editor);
    scheduleRevealEditorSelection();
  }, [editor, focusEndKey, isPointerCoarse, scheduleRevealEditorSelection]);

  useLayoutEffect(() => {
    scheduleRevealEditorSelection();
  }, [minHeight, scheduleRevealEditorSelection]);

  const resetHistorySession = useCallback(() => {
    if (!hasActiveHistorySessionRef.current) return;
    hasActiveHistorySessionRef.current = false;
    setActiveHistoryIndex(null);
    setTemporaryHistoryDraft(null);
    setRecalledHistoryDraft(null);
  }, []);

  useEffect(() => {
    if (!history) {
      resetHistorySession();
      return;
    }
    if (history.entries.length === 0) {
      resetHistorySession();
      return;
    }
    if (
      activeHistoryIndex !== null &&
      activeHistoryIndex >= history.entries.length
    ) {
      resetHistorySession();
    }
  }, [activeHistoryIndex, history, resetHistorySession]);

  useEffect(() => {
    resetHistorySession();
  }, [history?.resetKey, resetHistorySession]);

  useEffect(() => {
    if (!history || activeHistoryIndex === null || !recalledHistoryDraft) {
      return;
    }
    const activeHistoryEntry = history.entries[activeHistoryIndex];
    if (
      !activeHistoryEntry ||
      !arePromptDraftStatesEqual(activeHistoryEntry, recalledHistoryDraft)
    ) {
      resetHistorySession();
      return;
    }
    if (arePromptDraftStatesEqual(history.currentDraft, recalledHistoryDraft)) {
      return;
    }
    resetHistorySession();
  }, [activeHistoryIndex, history, recalledHistoryDraft, resetHistorySession]);

  useLayoutEffect(() => {
    const fromHeight = heightAnimationFromRef.current;
    const formElement = formRef.current;
    if (fromHeight === null || !formElement) return;
    heightAnimationFromRef.current = null;
    if (getMediaQuerySnapshot(REDUCED_MOTION_QUERY)) return;

    const previousTransition = formElement.style.transition;
    const previousWillChange = formElement.style.willChange;
    const previousOverflow = formElement.style.overflow;

    formElement.style.transition = "none";
    formElement.style.height = "";
    const toHeight = formElement.getBoundingClientRect().height;
    if (Math.abs(toHeight - fromHeight) < 0.5) {
      formElement.style.transition = previousTransition;
      return;
    }
    formElement.style.height = `${fromHeight}px`;
    formElement.getBoundingClientRect();
    formElement.style.overflow = "hidden";
    formElement.style.willChange = "height";
    formElement.style.transition =
      "height 240ms cubic-bezier(0.22, 1, 0.36, 1)";
    formElement.style.height = `${toHeight}px`;

    let isCleanedUp = false;
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      formElement.style.transition = previousTransition;
      formElement.style.willChange = previousWillChange;
      formElement.style.overflow = previousOverflow;
      formElement.style.height = "";
      formElement.removeEventListener("transitionend", handleTransitionEnd);
      window.clearTimeout(fallbackTimeout);
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== "height") return;
      cleanup();
    };
    const fallbackTimeout = window.setTimeout(cleanup, 320);
    formElement.addEventListener("transitionend", handleTransitionEnd);

    return cleanup;
  }, [heightAnimationKey, showCompactLayout]);

  const trimmedValue = value.trim();
  const hasAttachments = attachments.length > 0;
  const hasSubmittableInput = trimmedValue.length > 0 || hasAttachments;

  const activeTriggerKind = activeTrigger?.kind ?? null;
  const commandHasMore = typeahead.command.hasMore;
  const commandIsLoadingMore = typeahead.command.isLoadingMore;
  const loadMoreCommands = typeahead.command.loadMore;
  const canLoadMoreCommands =
    activeTriggerKind === "command" &&
    canLoadMoreCommandResults({
      hasMore: commandHasMore,
      isError: commandError,
      isLoadingMore: commandIsLoadingMore,
    });
  const activeCommandQuery =
    activeTrigger?.kind === "command" ? activeTrigger.query : "";
  const orderedCommandSuggestions = useMemo(
    () => orderCommandSuggestions(commandSuggestions, activeCommandQuery),
    [activeCommandQuery, commandSuggestions],
  );
  const activeSuggestions = useMemo<readonly TypeaheadSuggestion[]>(
    () =>
      activeTriggerKind === "command"
        ? orderedCommandSuggestions
        : activeTriggerKind === "mention"
          ? mentionResults.suggestions
          : [],
    [activeTriggerKind, mentionResults.suggestions, orderedCommandSuggestions],
  );
  const selectedSuggestionIndex = useMemo(() => {
    if (selectedSuggestionKey === null) return -1;
    return activeSuggestions.findIndex(
      (suggestion) =>
        typeaheadSuggestionKey(suggestion) === selectedSuggestionKey,
    );
  }, [activeSuggestions, selectedSuggestionKey]);
  const selectedIndex = Math.max(0, selectedSuggestionIndex);

  const activeMentionQuery =
    activeTrigger?.kind === "mention" ? activeTrigger.query.trim() : "";
  const mentionMenuState: MentionMenuState =
    activeMentionQuery.length === 0
      ? { kind: "hint" }
      : mentionLoading
        ? { kind: "loading" }
        : mentionError
          ? { kind: "error" }
          : { kind: "results", results: mentionResults };

  const commandMenuState: CommandMenuState = commandLoading
    ? { kind: "loading" }
    : commandError
      ? { kind: "error" }
      : { kind: "results", suggestions: orderedCommandSuggestions };

  const isCommandTriggerLiteral =
    activeTriggerKind === "command" &&
    !commandLoading &&
    !commandError &&
    commandSuggestions.length === 0;
  const isBareNonDefaultMentionTrigger =
    activeTrigger?.kind === "mention" &&
    activeTrigger.char !== DEFAULT_PLUGIN_MENTION_TRIGGER &&
    activeMentionQuery.length === 0;
  const showTypeaheadMenu =
    !isVoiceBusy &&
    activeTrigger !== null &&
    !isCommandTriggerLiteral &&
    !isBareNonDefaultMentionTrigger;

  const typeaheadMenuState: TypeaheadMenuState =
    activeTriggerKind === "command"
      ? { trigger: "command", state: commandMenuState }
      : { trigger: "mention", state: mentionMenuState };

  useLayoutEffect(() => {
    if (reportQueuedEditorTypeaheadLayout === null) return;
    const menu = typeaheadMenuRef.current;
    if (!showTypeaheadMenu || menu === null) {
      reportQueuedEditorTypeaheadLayout({ height: 0, isOpen: false });
      return;
    }

    const reportOpenLayout = () => {
      reportQueuedEditorTypeaheadLayout({
        height: menu.getBoundingClientRect().height,
        isOpen: true,
      });
    };
    reportOpenLayout();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(reportOpenLayout);
    resizeObserver?.observe(menu);
    return () => {
      resizeObserver?.disconnect();
      reportQueuedEditorTypeaheadLayout({ height: 0, isOpen: false });
    };
  }, [reportQueuedEditorTypeaheadLayout, showTypeaheadMenu]);

  useEffect(() => {
    if (selectedSuggestionKey !== null && selectedSuggestionIndex === -1) {
      setSelectedSuggestionKey(null);
    }
  }, [selectedSuggestionIndex, selectedSuggestionKey]);

  useEffect(() => {
    if (
      activeTriggerKind !== "command" ||
      !canLoadMoreCommands ||
      activeSuggestions.length === 0
    ) {
      return;
    }
    const prefetchIndex = Math.max(0, activeSuggestions.length - 3);
    if (selectedIndex >= prefetchIndex) {
      loadMoreCommands();
    }
  }, [
    activeSuggestions.length,
    activeTriggerKind,
    canLoadMoreCommands,
    loadMoreCommands,
    selectedIndex,
  ]);

  const finishApply = useCallback(
    (appliedEditor: Editor) => {
      const nextValue = promptEditorValueFromDoc(appliedEditor.state.doc);
      lastSyncedEditorValueRef.current = nextValue;
      onChangeRef.current(nextValue.text, nextValue.mentions);

      requestAnimationFrame(() => {
        const nextEditor = editorRef.current;
        if (!nextEditor || nextEditor.isDestroyed) {
          isRestoringAppliedMentionRef.current = false;
          return;
        }
        nextEditor.commands.focus();
        syncTriggerState(nextEditor);
        scheduleRevealEditorSelection();
        isRestoringAppliedMentionRef.current = false;
      });
    },
    [scheduleRevealEditorSelection, syncTriggerState],
  );

  const applyMentionSuggestion = useCallback(
    (item: PromptMentionSuggestion) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || activeTrigger?.kind !== "mention") return;

      const replacement = item.replacement.trim();
      const serializedText = replacement.startsWith(activeTrigger.char)
        ? replacement
        : `${activeTrigger.char}${replacement}`;
      const resource = promptMentionResourceFromSuggestion(item);
      const trailingText = hasWhitespaceAfterPosition(
        currentEditor.state.doc,
        activeTrigger.to,
      )
        ? ""
        : " ";
      triggerKeyRef.current = "";
      dismissedTriggerRef.current = {
        start: activeTrigger.from,
        end: activeTrigger.from + 2,
        hasLeftRange: false,
      };
      isRestoringAppliedMentionRef.current = true;
      setActiveTrigger(null);
      setSelectedSuggestionKey(null);
      onMentionQueryChange(null, null);

      try {
        skipEditorChangeRef.current = true;
        currentEditor
          .chain()
          .focus()
          .deleteRange({ from: activeTrigger.from, to: activeTrigger.to })
          .insertContent([
            {
              type: "mention",
              attrs: {
                resource,
                serializedText,
              },
            },
            ...(trailingText ? [{ type: "text", text: trailingText }] : []),
          ])
          .run();
      } finally {
        skipEditorChangeRef.current = false;
      }
      finishApply(currentEditor);
    },
    [activeTrigger, finishApply, onMentionQueryChange],
  );

  const applyCommandSuggestion = useCallback(
    (item: ProviderCommandSuggestion) => {
      const currentEditor = editorRef.current;
      if (!currentEditor || activeTrigger === null) return;
      if (activeTrigger.char !== "/") return;

      const serializedText = `${activeTrigger.char}${item.name}`;
      const resource = promptCommandResourceFromSuggestion({
        suggestion: item,
        trigger: activeTrigger.char,
      });
      const trailingText = hasWhitespaceAfterPosition(
        currentEditor.state.doc,
        activeTrigger.to,
      )
        ? ""
        : " ";
      triggerKeyRef.current = "";
      dismissedTriggerRef.current = {
        start: activeTrigger.from,
        end: commandPillDismissedRangeEnd({
          triggerPosition: activeTrigger.from,
          trailingText,
        }),
        hasLeftRange: false,
      };
      isRestoringAppliedMentionRef.current = true;
      setActiveTrigger(null);
      setSelectedSuggestionKey(null);
      onCommandQueryChange(null);

      try {
        skipEditorChangeRef.current = true;
        currentEditor
          .chain()
          .focus()
          .deleteRange({ from: activeTrigger.from, to: activeTrigger.to })
          .insertContent([
            {
              type: "mention",
              attrs: {
                resource,
                serializedText,
              },
            },
            ...(trailingText ? [{ type: "text", text: trailingText }] : []),
          ])
          .run();
      } finally {
        skipEditorChangeRef.current = false;
      }
      finishApply(currentEditor);
    },
    [activeTrigger, finishApply, onCommandQueryChange],
  );

  const applyTrigger = useCallback(
    (item: TypeaheadSuggestion) => {
      if (item.kind === "command") {
        applyCommandSuggestion(item);
        return;
      }
      applyMentionSuggestion(item);
    },
    [applyCommandSuggestion, applyMentionSuggestion],
  );

  const dismissActiveTrigger = useCallback(() => {
    triggerKeyRef.current = "";
    if (activeTrigger) {
      dismissedTriggerRef.current = {
        start: activeTrigger.from,
        end: activeTrigger.to,
        hasLeftRange: false,
      };
    }
    setActiveTrigger(null);
    onMentionQueryChange(null, null);
    onCommandQueryChange(null);
  }, [activeTrigger, onCommandQueryChange, onMentionQueryChange]);

  const focusEnd = useCallback(() => {
    if (isPointerCoarse) {
      pendingFocusEndRef.current = false;
      return;
    }
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed) {
      pendingFocusEndRef.current = true;
      return;
    }
    pendingFocusEndRef.current = false;
    focusEditorAtEnd(currentEditor);
    scheduleRevealEditorSelection();
  }, [isPointerCoarse, scheduleRevealEditorSelection]);

  const insertTextAtCursor = useCallback(
    (rawText: string) => {
      const normalizedText = rawText.replace(/\s+/g, " ").trim();
      if (normalizedText.length === 0) return;

      const currentEditor = editorRef.current;
      const currentValue = valueRef.current;
      if (!currentEditor) {
        const nextValue =
          currentValue.length === 0 || /\s$/.test(currentValue)
            ? `${currentValue}${normalizedText}`
            : `${currentValue} ${normalizedText}`;
        onChangeRef.current(nextValue, [...mentionRangesRef.current]);
        return;
      }

      const selection = currentEditor.state.selection;
      const before = currentEditor.state.doc.textBetween(
        0,
        selection.from,
        "\n",
        "\n",
      );
      const after = currentEditor.state.doc.textBetween(
        selection.to,
        currentEditor.state.doc.content.size,
        "\n",
        "\n",
      );
      const needsLeadingWhitespace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingWhitespace = after.length > 0 && !/^\s/.test(after);
      const insertedText = `${needsLeadingWhitespace ? " " : ""}${normalizedText}${needsTrailingWhitespace ? " " : ""}`;

      const insertion = currentEditor.chain();
      if (!isPointerCoarse) insertion.focus();
      insertion.insertContent(insertedText).run();
      if (!isPointerCoarse) scheduleRevealEditorSelection();
    },
    [isPointerCoarse, scheduleRevealEditorSelection],
  );

  const focusAfterPromptAction = useCallback(
    (currentEditor: Editor) => {
      const focusEditor = () => {
        promptActionFocusFrameRef.current = null;
        if (currentEditor.isDestroyed) return;
        currentEditor.commands.focus();
        syncTriggerState(currentEditor);
        scheduleRevealEditorSelection();
      };

      if (typeof requestAnimationFrame !== "function") {
        focusEditor();
        return;
      }

      if (promptActionFocusFrameRef.current !== null) {
        cancelAnimationFrame(promptActionFocusFrameRef.current);
      }
      promptActionFocusFrameRef.current = requestAnimationFrame(focusEditor);
    },
    [scheduleRevealEditorSelection, syncTriggerState],
  );

  const applyPromptAction = useCallback(
    (action: PromptBoxAction) => {
      if (action.text.length === 0) return;
      const commandAction = promptActionCommandFromAction(action);

      const currentEditor = editorRef.current;
      if (!currentEditor || currentEditor.isDestroyed) {
        const currentValue = valueRef.current;
        if (currentValue.endsWith(action.text)) return;
        if (commandAction) {
          const start = currentValue.length;
          const nextValue = `${currentValue}${commandAction.serializedText}${commandAction.trailingText}`;
          onChangeRef.current(nextValue, [
            ...mentionRangesRef.current,
            {
              start,
              end: start + commandAction.serializedText.length,
              resource: promptCommandResourceFromSuggestion({
                suggestion: commandAction.suggestion,
                trigger: commandAction.trigger,
              }),
            },
          ]);
        } else {
          onChangeRef.current(`${currentValue}${action.text}`, [
            ...mentionRangesRef.current,
          ]);
        }
        return;
      }

      if (promptActionTextImmediatelyBeforeCursor(currentEditor, action.text)) {
        focusAfterPromptAction(currentEditor);
        return;
      }

      const insertionRange = getPromptActionInsertionRange({
        editor: currentEditor,
        action,
        actions: promptActions ?? [],
        triggers: promptActionTriggers(triggers, commandAction),
      });
      if (insertionRange === null) {
        focusAfterPromptAction(currentEditor);
        return;
      }

      if (commandAction) {
        triggerKeyRef.current = "";
        dismissedTriggerRef.current = null;
        isRestoringAppliedMentionRef.current = true;
        setActiveTrigger(null);
        setSelectedSuggestionKey(null);
        onCommandQueryChange(null);

        try {
          skipEditorChangeRef.current = true;
          currentEditor
            .chain()
            .focus()
            .deleteRange({ from: insertionRange.from, to: insertionRange.to })
            .insertContent([
              {
                type: "mention",
                attrs: {
                  resource: promptCommandResourceFromSuggestion({
                    suggestion: commandAction.suggestion,
                    trigger: commandAction.trigger,
                  }),
                  serializedText: commandAction.serializedText,
                },
              },
              ...(commandAction.trailingText
                ? [{ type: "text", text: commandAction.trailingText }]
                : []),
            ])
            .run();
        } finally {
          skipEditorChangeRef.current = false;
        }
        finishApply(currentEditor);
        return;
      }

      triggerKeyRef.current = "";
      dismissedTriggerRef.current = null;
      setSelectedSuggestionKey(null);
      currentEditor
        .chain()
        .focus()
        .deleteRange({ from: insertionRange.from, to: insertionRange.to })
        .insertContent(action.text)
        .run();
      finishApply(currentEditor);
    },
    [
      finishApply,
      focusAfterPromptAction,
      onCommandQueryChange,
      promptActions,
      triggers,
    ],
  );

  const getTextBeforeCursor = useCallback((): string | undefined => {
    const currentValue = valueRef.current;
    const currentEditor = editorRef.current;
    if (!currentEditor) {
      const trimmed = currentValue.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    const beforeCursor = currentEditor.state.doc
      .textBetween(0, currentEditor.state.selection.from, "\n", "\n")
      .trim();
    return beforeCursor.length > 0 ? beforeCursor : undefined;
  }, []);

  useImperativeHandle(
    promptBoxRef,
    () => ({
      captureHeightForLayoutChange: capturePromptBoxHeight,
      focusEnd,
      insertTextAtCursor,
      getTextBeforeCursor,
      playVoiceCompletionTransition,
    }),
    [
      capturePromptBoxHeight,
      focusEnd,
      getTextBeforeCursor,
      insertTextAtCursor,
      playVoiceCompletionTransition,
    ],
  );

  const canSubmit =
    hasSubmittableInput &&
    !isAttaching &&
    !isSubmitting &&
    !submitDisabled &&
    !isVoiceBusy;
  const canModifierSubmit =
    onModifierSubmit !== undefined &&
    !isAttaching &&
    !isSubmitting &&
    !submitDisabled &&
    !isVoiceBusy;
  const showStop = Boolean(
    isRunning && onStop && !canSubmit && !isAttaching && !isVoiceBusy,
  );
  const canStartVoiceInput =
    voice !== undefined && voice.isSupported && !isSubmitting;
  const showVoiceAsPrimaryAction =
    isPointerCoarse &&
    !isAttaching &&
    !hasSubmittableInput &&
    canStartVoiceInput;
  const handleVoicePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isPointerCoarse || event.button !== 0) return;

      event.preventDefault();
    },
    [isPointerCoarse],
  );
  const startVoiceInput = useCallback(() => {
    if (isPointerCoarse) {
      const currentEditor = editorRef.current;
      if (currentEditor && !currentEditor.isDestroyed) {
        blurActiveKeyboardInputWithin(currentEditor.view.dom);
      }
    }
    void voice?.start();
  }, [isPointerCoarse, voice]);
  const cancelVoiceInput = useCallback(() => {
    if (voiceActionRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceActionRevealFrameRef.current);
      voiceActionRevealFrameRef.current = null;
    }
    setVoiceActionTransition("exiting");
    voice?.cancel();
  }, [voice]);
  const attachmentUploadTitle = "Uploading attachments...";
  const effectiveSubmitTitle = isAttaching
    ? attachmentUploadTitle
    : !canSubmit && submitDisabledReason
      ? submitDisabledReason
      : submitTitle;

  const emitAttachmentFiles = useCallback(
    (files: File[]) => {
      if (!onAttachFiles || files.length === 0) return;
      void onAttachFiles(files);
    },
    [onAttachFiles],
  );

  const submitPrompt = useCallback(() => {
    const shouldBlurAfterSubmit = blurAfterPointerSubmitRef.current;
    blurAfterPointerSubmitRef.current = false;
    if (!canSubmit) return;
    onSubmit();
    if (shouldBlurAfterSubmit) {
      blurPromptEditor(editorRef.current);
    }
  }, [canSubmit, onSubmit]);

  const handleSubmitClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      blurAfterPointerSubmitRef.current =
        blurOnPointerSubmit && event.detail > 0;
    },
    [blurOnPointerSubmit],
  );

  const handleSubmitPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      if (isPointerCoarse) {
        event.preventDefault();
        return;
      }
      const currentEditor = editorRef.current;
      const editorElement = currentEditor?.view.dom;
      const activeElement = editorElement?.ownerDocument.activeElement;
      if (
        !currentEditor ||
        currentEditor.isDestroyed ||
        !editorElement?.contains(activeElement ?? null)
      ) {
        return;
      }

      event.preventDefault();
    },
    [isPointerCoarse],
  );

  const [pendingCommandSubmit, setPendingCommandSubmit] = useState(false);
  useEffect(() => {
    if (!pendingCommandSubmit) return;
    setPendingCommandSubmit(false);
    submitPrompt();
  }, [pendingCommandSubmit, submitPrompt]);

  const submitModifierPrompt = useCallback(() => {
    if (!canModifierSubmit || !onModifierSubmit) return;
    onModifierSubmit();
  }, [canModifierSubmit, onModifierSubmit]);

  const applyHistoryDraft = useCallback(
    (draft: PromptDraftState) => {
      if (!history) {
        return;
      }

      history.onSelectEntry(draft);
      requestAnimationFrame(() => {
        const currentEditor = editorRef.current;
        if (!currentEditor || currentEditor.isDestroyed) {
          return;
        }

        focusEditorAtEnd(currentEditor);
        syncTriggerState(currentEditor);
        scheduleRevealEditorSelection();
      });
    },
    [history, scheduleRevealEditorSelection, syncTriggerState],
  );

  const collapsePromptBox = useCallback(() => {
    if (!onCollapse) return;
    capturePromptBoxHeight();
    blurPromptEditor(editorRef.current);
    onCollapse();
  }, [capturePromptBoxHeight, onCollapse]);

  const handleAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;
      emitAttachmentFiles(Array.from(fileList));
      event.target.value = "";
    },
    [emitAttachmentFiles],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitPrompt();
  };

  const handlePromptBoxMouseDown = useCallback(
    (event: PromptBoxMouseDownEvent) => {
      if (!isPromptBoxChromeTarget(event.target)) return;

      const currentEditor = editorRef.current;
      if (!currentEditor || currentEditor.isDestroyed) return;

      event.preventDefault();
      focusEditorAtEnd(currentEditor);
      scheduleRevealEditorSelection();
    },
    [scheduleRevealEditorSelection],
  );

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent, isOriginalIPadHardwareEnter = false): boolean => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        postCompositionKeyDownEvents.has(event)
      ) {
        return false;
      }
      if (dispatchAppCommandKey(event)) {
        return true;
      }
      const canSubmitWithEnterKey =
        !isPointerCoarse || isOriginalIPadHardwareEnter;
      const currentEditor = editorRef.current;
      const selection = currentEditor?.state.selection;
      const hasCollapsedSelection = Boolean(selection?.empty);
      const hasArrowNavigationModifier =
        event.shiftKey || event.altKey || event.metaKey || event.ctrlKey;
      const hasCursorAtEnd =
        hasCollapsedSelection &&
        currentEditor !== null &&
        currentEditor !== undefined &&
        selection !== undefined &&
        selection.from >= currentEditor.state.doc.content.size - 1;
      const activeHistoryEntry =
        history && activeHistoryIndex !== null
          ? history.entries[activeHistoryIndex]
          : null;
      const hasSelectedHistoryEntry = Boolean(
        history &&
        activeHistoryEntry !== null &&
        activeHistoryEntry !== undefined &&
        arePromptDraftStatesEqual(history.currentDraft, activeHistoryEntry),
      );
      const canNavigateHistory =
        history !== undefined &&
        !hasArrowNavigationModifier &&
        hasCursorAtEnd &&
        (isPromptDraftEmpty(history.currentDraft) || hasSelectedHistoryEntry);
      const canNavigateTypeahead =
        showTypeaheadMenu && !hasArrowNavigationModifier && !canNavigateHistory;

      if (showTypeaheadMenu) {
        if (
          event.key === "ArrowDown" &&
          canNavigateTypeahead &&
          activeSuggestions.length > 0
        ) {
          event.preventDefault();
          if (
            activeTriggerKind === "command" &&
            !commandError &&
            selectedIndex >= activeSuggestions.length - 1 &&
            (commandHasMore || commandIsLoadingMore)
          ) {
            if (canLoadMoreCommands) {
              loadMoreCommands();
            }
            return true;
          }
          const nextIndex = (selectedIndex + 1) % activeSuggestions.length;
          const nextSuggestion = activeSuggestions[nextIndex];
          if (nextSuggestion) {
            setSelectedSuggestionKey(typeaheadSuggestionKey(nextSuggestion));
          }
          return true;
        }
        if (
          event.key === "ArrowUp" &&
          canNavigateTypeahead &&
          activeSuggestions.length > 0
        ) {
          event.preventDefault();
          const nextIndex =
            (selectedIndex + activeSuggestions.length - 1) %
            activeSuggestions.length;
          const nextSuggestion = activeSuggestions[nextIndex];
          if (nextSuggestion) {
            setSelectedSuggestionKey(typeaheadSuggestionKey(nextSuggestion));
          }
          return true;
        }
        if (
          (event.key === "Enter" || event.key === "Tab") &&
          activeSuggestions.length > 0
        ) {
          event.preventDefault();
          const selected =
            activeSuggestions[selectedIndex] ?? activeSuggestions[0];
          if (selected) {
            applyTrigger(selected);
            if (
              event.key === "Enter" &&
              selected.kind === "command" &&
              selected.origin === "builtin"
            ) {
              setPendingCommandSubmit(true);
            }
          }
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          dismissActiveTrigger();
          return true;
        }
      }

      if (event.key === "Escape") {
        if (onEscape) {
          onEscape();
          return true;
        }
        blurPromptEditor(currentEditor);
        return true;
      }

      if (history) {
        if (
          event.key === "ArrowUp" &&
          canNavigateHistory &&
          history.entries.length > 0
        ) {
          event.preventDefault();
          const nextHistoryIndex =
            activeHistoryIndex === null
              ? 0
              : Math.min(activeHistoryIndex + 1, history.entries.length - 1);
          hasActiveHistorySessionRef.current = true;
          if (activeHistoryIndex === null) {
            setTemporaryHistoryDraft(history.currentDraft);
          }
          setActiveHistoryIndex(nextHistoryIndex);
          const nextDraft = history.entries[nextHistoryIndex];
          setRecalledHistoryDraft(nextDraft);
          applyHistoryDraft(nextDraft);
          return true;
        }

        if (
          event.key === "ArrowDown" &&
          canNavigateHistory &&
          activeHistoryIndex !== null
        ) {
          event.preventDefault();
          if (activeHistoryIndex === 0) {
            if (temporaryHistoryDraft) {
              applyHistoryDraft(temporaryHistoryDraft);
            }
            resetHistorySession();
            return true;
          }

          const nextHistoryIndex = activeHistoryIndex - 1;
          setActiveHistoryIndex(nextHistoryIndex);
          const nextDraft = history.entries[nextHistoryIndex];
          setRecalledHistoryDraft(nextDraft);
          applyHistoryDraft(nextDraft);
          return true;
        }
      }

      const isModifierSubmitKey =
        event.key === "Enter" &&
        event.metaKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey;
      if (isModifierSubmitKey && onModifierSubmit) {
        event.preventDefault();
        submitModifierPrompt();
        return true;
      }

      const isBlockquoteExitKey =
        event.key === "Enter" &&
        event.shiftKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey;
      if (
        isBlockquoteExitKey &&
        currentEditor &&
        applyPromptListNewline(currentEditor)
      ) {
        event.preventDefault();
        return true;
      }

      if (
        isBlockquoteExitKey &&
        currentEditor &&
        (insertParagraphBeforeBlockquote(currentEditor) ||
          exitTrailingBlockquoteBreak(currentEditor))
      ) {
        event.preventDefault();
        return true;
      }

      const isPromptNewlineKey =
        event.key === "Enter" &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey &&
        (event.shiftKey || !canSubmitWithEnterKey);
      if (isPromptNewlineKey && currentEditor && exitHeading(currentEditor)) {
        event.preventDefault();
        return true;
      }

      if (
        isPromptNewlineKey &&
        currentEditor &&
        applyPromptParagraphNewline(currentEditor)
      ) {
        event.preventDefault();
        return true;
      }

      if (!canSubmitWithEnterKey) return false;
      const isSubmitKey = event.key === "Enter" && !event.shiftKey;

      if (!isSubmitKey) return false;
      event.preventDefault();
      submitPrompt();
      return true;
    },
    [
      activeHistoryIndex,
      activeSuggestions,
      activeTriggerKind,
      applyHistoryDraft,
      applyTrigger,
      canLoadMoreCommands,
      commandError,
      commandHasMore,
      commandIsLoadingMore,
      dispatchAppCommandKey,
      dismissActiveTrigger,
      history,
      isPointerCoarse,
      loadMoreCommands,
      onEscape,
      onModifierSubmit,
      postCompositionKeyDownEvents,
      resetHistorySession,
      selectedIndex,
      setPendingCommandSubmit,
      showTypeaheadMenu,
      submitModifierPrompt,
      submitPrompt,
      temporaryHistoryDraft,
    ],
  );

  useLayoutEffect(() => {
    handleEditorKeyDownRef.current = handleEditorKeyDown;
  }, [handleEditorKeyDown]);

  useEffect(() => {
    if (!showVoiceActionGroup || !voice) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoiceInput();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelVoiceInput, showVoiceActionGroup, voice]);

  return (
    <form
      ref={formRef}
      data-promptbox=""
      data-promptbox-compact={showCompactLayout ? "" : undefined}
      data-promptbox-voice-active={showVoiceActionGroup ? "" : undefined}
      onSubmit={handleSubmit}
      onMouseDown={handlePromptBoxMouseDown}
      onDragOver={(event) => {
        if (!onAttachFiles) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (!onAttachFiles) return;
        event.preventDefault();
        if (!event.dataTransfer?.files || event.dataTransfer.files.length === 0)
          return;
        emitAttachmentFiles(Array.from(event.dataTransfer.files));
      }}
      className={cn(
        "group/promptbox relative w-full rounded-xl border border-border bg-background shadow-lift",
        showCompactLayout && "overflow-hidden",
        className,
      )}
    >
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentInputChange}
      />
      <div
        data-promptbox-layout=""
        className={COLLAPSING_GRID_CLASS}
        style={{ gridTemplateRows: "1fr" }}
      >
        <div
          data-promptbox-main=""
          className={cn(
            "min-h-0 overflow-hidden transition-opacity duration-[180ms] motion-reduce:transition-none",
            showCompactLayout && "relative h-12",
            showVoiceActionGroup && "pointer-events-none",
          )}
        >
          {header && !showCompactLayout ? (
            <div
              data-promptbox-expanded-only=""
              inert={showVoiceActionGroup ? true : undefined}
              className="pl-4 pr-14 pt-3"
            >
              {header}
            </div>
          ) : null}
          <div data-promptbox-input-region="" className="relative">
            {!showCompactLayout ? (
              <>
                <div data-promptbox-expanded-only="">
                  <AppCommandShortcutHint
                    shortcut={focusComposerShortcut}
                    className={cn(
                      "absolute top-2 z-20 group-focus-within/promptbox:hidden",
                      onCollapse ? "right-10" : "right-2",
                    )}
                  />
                </div>
                {onCollapse ? (
                  <div
                    data-promptbox-expanded-only=""
                    data-promptbox-standard-actions=""
                    inert={showVoiceActionGroup ? true : undefined}
                    className="absolute right-[13px] top-2 z-20 flex items-center"
                  >
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={collapsePromptBox}
                      aria-label="Collapse prompt box"
                      className={cn(
                        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
                        COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
                        PROMPT_STACK_EDGE_CARET_BUTTON_WIDTH_CLASS,
                      )}
                    >
                      <Icon name="ChevronDown" className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            <ComposerEditorSlot
              editor={editor}
              scrollContainerRef={editorScrollContainerRef}
              inputLocked={composerInputLocked}
              isCompactLayout={showCompactLayout}
              minHeight={minHeight}
              layout={editorLayout}
              resolveMentionLink={mentionResolveLink}
            />
          </div>

          {showTypeaheadMenu ? (
            <div
              ref={typeaheadMenuRef}
              data-promptbox-typeahead-menu=""
              className={cn(
                "absolute -left-px -right-px z-20",
                mentionMenuPlacement === "top"
                  ? "bottom-full mb-2"
                  : "top-full mt-2",
              )}
            >
              <MentionMenu
                state={typeaheadMenuState}
                selectedIndex={selectedIndex}
                onApply={applyTrigger}
                onDismiss={isPointerCoarse ? dismissActiveTrigger : undefined}
                onCommandLoadMore={
                  canLoadMoreCommands ? loadMoreCommands : undefined
                }
              />
            </div>
          ) : null}

          {!showCompactLayout ? (
            <>
              <div
                data-promptbox-expanded-only=""
                inert={showVoiceActionGroup ? true : undefined}
              >
                <AttachmentPreview
                  attachments={attachments}
                  attachmentProjectId={attachmentProjectId}
                  expandedImageIndex={expandedImageIndex}
                  onExpandedImageIndexChange={setExpandedImageIndex}
                  onRemoveAttachment={onRemoveAttachment}
                />

                {attachmentError ? (
                  <div className="mx-3 mb-1 mt-1 text-xs text-destructive">
                    {attachmentError}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <PluginComposerViewProvider value={composerView}>
            <div
              data-promptbox-action-row=""
              className={cn(
                "relative flex shrink-0 select-none flex-row items-center gap-3 pb-2 pl-3.5 pr-2 pt-1.5",
                showCompactLayout && "absolute inset-y-0 right-2 gap-0 p-0",
              )}
            >
              {voice && isVoiceActionPresent ? (
                <div
                  data-promptbox-voice-controls=""
                  data-voice-transition={voiceActionTransition}
                  inert={isVoiceActionVisible ? undefined : true}
                  aria-hidden={isVoiceActionVisible ? undefined : true}
                  className={cn(
                    "absolute inset-0 z-10 min-w-0 origin-center transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[opacity,transform] motion-reduce:transition-none",
                    isVoiceActionVisible
                      ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
                      : "pointer-events-none translate-y-1 scale-[0.985] opacity-0",
                  )}
                >
                  <VoiceRecordingBar
                    state={renderedVoiceActionState}
                    stream={voice.stream}
                    onConfirm={voice.stop}
                    onCancel={cancelVoiceInput}
                  />
                </div>
              ) : null}
              {!showCompactLayout ? (
                <div
                  data-promptbox-expanded-only=""
                  data-promptbox-standard-actions=""
                  className={cn(
                    "flex min-w-0 flex-1 flex-row items-center gap-1 transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                    showVoiceActionGroup
                      ? "pointer-events-none translate-y-1 opacity-0"
                      : "translate-y-0 opacity-100",
                  )}
                  inert={showVoiceActionGroup ? true : undefined}
                  aria-live="polite"
                >
                  <ComposerPlusMenuSlot
                    actions={promptActions}
                    isAttaching={isAttaching}
                    onAttach={
                      onAttachFiles
                        ? () => attachmentInputRef.current?.click()
                        : undefined
                    }
                    onAction={applyPromptAction}
                    includePluginContributions={
                      !suppressPluginComposerCustomizations
                    }
                  />
                  {footerStart}
                </div>
              ) : null}
              <div
                data-promptbox-standard-actions=""
                className={cn(
                  "flex shrink-0 flex-row items-center gap-1 transition-[opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
                  showVoiceActionGroup
                    ? "pointer-events-none translate-y-1 opacity-0"
                    : "translate-y-0 opacity-100",
                )}
                inert={showVoiceActionGroup ? true : undefined}
              >
                <ComposerActionsSlot
                  includePluginContributions={
                    !showCompactLayout && !suppressPluginComposerCustomizations
                  }
                >
                  {!showCompactLayout ? (
                    <>
                      {voice &&
                      !showVoiceActionGroup &&
                      (!showVoiceAsPrimaryAction || showStop) ? (
                        <Button
                          data-promptbox-expanded-only=""
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={
                            !voice.isSupported
                              ? voiceUnsupportedMessage(
                                  voice.unsupportedReason ?? null,
                                )
                              : "Start voice input"
                          }
                          disabled={!canStartVoiceInput}
                          onPointerDown={handleVoicePointerDown}
                          onClick={startVoiceInput}
                          className={
                            COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS
                          }
                        >
                          <Icon name="Mic" className="size-4" />
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  <div
                    data-promptbox-submit-group=""
                    className="flex shrink-0 flex-row items-center"
                  >
                    {showStop ? (
                      <Button
                        data-promptbox-submit-action=""
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label="Stop run"
                        onClick={onStop}
                        className={
                          showCompactLayout
                            ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
                            : COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS
                        }
                      >
                        <Icon
                          name="Square"
                          className="size-3.5 fill-current [&_*]:stroke-0"
                        />
                      </Button>
                    ) : showVoiceAsPrimaryAction ? (
                      <Button
                        data-promptbox-submit-action=""
                        type="button"
                        size={showCompactLayout ? "icon" : "sm"}
                        variant="default"
                        aria-label="Start voice input"
                        onPointerDown={handleVoicePointerDown}
                        onClick={startVoiceInput}
                        className={cn(
                          showCompactLayout
                            ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
                            : [
                                "ml-1",
                                COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                              ],
                          "transition-colors",
                        )}
                      >
                        <Icon name="Mic" className="size-4" />
                      </Button>
                    ) : (
                      <PromptSubmitButton
                        canSubmit={canSubmit}
                        className={cn(
                          showCompactLayout
                            ? COMPACT_PROMPT_ACTION_BUTTON_CLASS
                            : [
                                "ml-1",
                                COARSE_POINTER_PROMPT_ACTION_BUTTON_CLASS,
                              ],
                          "transition-colors",
                        )}
                        disabledReason={
                          !canSubmit
                            ? isAttaching
                              ? attachmentUploadTitle
                              : submitDisabledReason
                            : undefined
                        }
                        isBusy={isSubmitting || isAttaching}
                        isCompact={showCompactLayout}
                        onPointerDown={handleSubmitPointerDown}
                        onClick={handleSubmitClick}
                        title={effectiveSubmitTitle}
                      />
                    )}
                  </div>
                </ComposerActionsSlot>
              </div>
            </div>
          </PluginComposerViewProvider>
        </div>
      </div>
    </form>
  );
}
