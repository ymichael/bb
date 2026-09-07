import { useEffect, useRef, useState } from "react";
import { Editor, isNodeSelection, type ChainedCommands } from "@tiptap/core";
import { BubbleMenuPlugin } from "@tiptap/extension-bubble-menu";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BubbleChatIcon,
  CheckListIcon,
  CodeIcon,
  Heading02Icon,
  LeftToRightBlockQuoteIcon,
  LeftToRightListBulletIcon,
  SourceCodeIcon,
  TextBoldIcon,
  TextItalicIcon,
} from "@hugeicons/core-free-icons";
import type { SuggestionProps } from "@tiptap/suggestion";
import { Button } from "@bb/shared-ui/button";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  createEditorExtensions,
  type MentionItem,
  type MentionSuggestionHandle,
} from "./extensions.js";

function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

const STYLE_MARKER = "data-bb-tasks-editor-styles";
const EDITOR_CSS = `
.bb-tasks-editor .tiptap {
  outline: none; width: 100%; font-size: 14px; line-height: 1.65;
  color: var(--foreground); caret-color: var(--foreground);
  overflow-wrap: break-word; -webkit-font-smoothing: antialiased;
}
.bb-tasks-editor[data-variant="comment"] .tiptap { font-size: 13px; line-height: 1.55; }
/* Doc variant: let the ProseMirror surface fill the wrapper's min-height so
   the whole area is editable. Otherwise a short document (e.g. a single block
   image) leaves a non-editable dead zone below it that swallows clicks, and a
   lone image atom offers no text caret — the description looks unfocusable. */
.bb-tasks-editor[data-variant="doc"] { display: flex; flex-direction: column; }
.bb-tasks-editor[data-variant="doc"] .bb-tasks-editor-surface { display: flex; flex: 1 1 auto; flex-direction: column; }
.bb-tasks-editor[data-variant="doc"] .bb-tasks-editor-surface .tiptap { flex: 1 1 auto; }
.bb-tasks-editor .tiptap > :first-child,
.bb-tasks-editor .tiptap li > :first-child,
.bb-tasks-editor .tiptap blockquote > :first-child { margin-top: 0; }
.bb-tasks-editor .tiptap p { margin: 0.75em 0 0; }
.bb-tasks-editor[data-variant="comment"] .tiptap p { margin: 0.5em 0 0; }
.bb-tasks-editor .tiptap h1,
.bb-tasks-editor .tiptap h2,
.bb-tasks-editor .tiptap h3,
.bb-tasks-editor .tiptap h4,
.bb-tasks-editor .tiptap h5,
.bb-tasks-editor .tiptap h6 { margin: 1.25em 0 0; color: var(--foreground); font-weight: 600; }
.bb-tasks-editor .tiptap h1 { font-size: 1.45em; line-height: 1.3; }
.bb-tasks-editor .tiptap h2 { font-size: 1.2em; line-height: 1.4; }
.bb-tasks-editor .tiptap h3 { font-size: 1.08em; line-height: 1.45; }
.bb-tasks-editor .tiptap :is(h1, h2, h3, h4, h5, h6) + * { margin-top: 0.5em; }
.bb-tasks-editor .tiptap ul, .bb-tasks-editor .tiptap ol { margin: 0.75em 0 0; padding-left: 1.5em; }
.bb-tasks-editor .tiptap ul { list-style: disc; }
.bb-tasks-editor .tiptap ol { list-style: decimal; }
.bb-tasks-editor .tiptap li { margin-top: 0.3em; padding-left: 0.3em; }
.bb-tasks-editor .tiptap li > p, .bb-tasks-editor .tiptap li > ul, .bb-tasks-editor .tiptap li > ol { margin-top: 0.3em; }
.bb-tasks-editor .tiptap li::marker { color: var(--muted-foreground); }
.bb-tasks-editor .tiptap a { color: inherit; font-weight: 500; text-decoration: underline; text-decoration-color: color-mix(in oklab, currentColor 30%, transparent); cursor: pointer; }
.bb-tasks-editor .tiptap a:hover { text-decoration-color: currentColor; }
.bb-tasks-editor .tiptap strong { font-weight: 600; }
.bb-tasks-editor .tiptap code { background: var(--muted); border-radius: min(calc(var(--radius) * 0.6), 0.35em); padding: 0.125em 0.3em; font-size: 0.85em; font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); }
.bb-tasks-editor .tiptap pre { background: var(--muted); border-radius: var(--radius); padding: 0.65em 0.85em; overflow-x: auto; font-size: 0.875em; line-height: 1.5; margin: 0.9em 0 0; tab-size: 2; }
.bb-tasks-editor .tiptap pre code { background: none; padding: 0; font-size: inherit; }
.bb-tasks-editor .tiptap blockquote { border-left: 2px solid var(--border); padding-left: 0.85em; margin: 0.75em 0 0; color: var(--muted-foreground); }
.bb-tasks-editor .tiptap hr { border: none; border-top: 1px solid var(--border); margin: 1.5em 0 0; }
.bb-tasks-editor .tiptap img { display: block; max-width: 100%; max-height: 24rem; margin: 0.9em 0 0; border-radius: var(--radius); border: 1px solid var(--border); }
.bb-tasks-editor .tiptap .tableWrapper { margin: 0.9em 0 0; overflow-x: auto; }
.bb-tasks-editor .tiptap table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.bb-tasks-editor .tiptap th,
.bb-tasks-editor .tiptap td { position: relative; min-width: 6rem; border: 1px solid var(--border); padding: 0.45em 0.6em; text-align: left; vertical-align: top; }
.bb-tasks-editor .tiptap th { background: var(--muted); font-weight: 600; }
.bb-tasks-editor .tiptap :is(th, td) > p { margin-top: 0; }
.bb-tasks-editor .tiptap :is(th, td) > p + p { margin-top: 0.5em; }
.bb-tasks-editor .tiptap .selectedCell::after { position: absolute; inset: 0; z-index: 2; pointer-events: none; content: ""; background: color-mix(in oklab, var(--primary) 14%, transparent); }
.bb-tasks-editor .tiptap ul[data-type="taskList"] { list-style: none; padding-left: 0.25em; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] ul[data-type="taskList"] { margin-top: 0; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.5em; margin-top: 0.3em; padding-left: 0; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] li > label { flex: 0 0 auto; display: inline-flex; align-items: center; height: 1.6em; user-select: none; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] li > div { flex: 1 1 auto; min-width: 0; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] li > div > p:first-child { margin-top: 0; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] input[type="checkbox"] { display: block; width: 14px; height: 14px; accent-color: var(--primary); cursor: pointer; margin: 0; }
.bb-tasks-editor .tiptap ul[data-type="taskList"] li[data-checked="true"] > div { color: var(--muted-foreground); text-decoration: line-through; }
.bb-tasks-editor .tiptap p.is-editor-empty:first-child::before { content: attr(data-placeholder); float: left; height: 0; pointer-events: none; color: var(--muted-foreground); }
.bb-tasks-editor .tiptap ::selection { background: color-mix(in oklab, var(--primary) 22%, transparent); }
.bb-tasks-editor .bb-tasks-mention {
  display: inline; border-radius: calc(var(--radius) * 0.75);
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary); padding: 0.05em 0.35em;
  font-size: 0.9em; font-weight: 500; white-space: nowrap;
}
.bb-tasks-editor .bb-tasks-thread-mention { cursor: pointer; }
.bb-tasks-editor .bb-tasks-thread-mention:hover { background: color-mix(in oklab, var(--primary) 20%, transparent); }
.bb-tasks-editor .bb-tasks-mention-icon {
  display: inline-block; width: 0.95em; height: 0.95em;
  vertical-align: -0.12em; margin-right: 0.3em;
}
`;

function ensureEditorStyles(): void {
  const existing = document.head.querySelector<HTMLStyleElement>(
    `[${STYLE_MARKER}]`,
  );
  if (existing) {
    existing.textContent = EDITOR_CSS;
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = EDITOR_CSS;
  document.head.append(style);
}

interface MentionPopoverState {
  items: MentionItem[];
  clientRect: (() => DOMRect | null) | null;
  command: (item: MentionItem) => void;
  selectedIndex: number;
}

interface BubbleAction {
  id: string;
  label: string;
  icon: IconSvgElement;
  isActive(editor: Editor): boolean;
  run(chain: ChainedCommands): ChainedCommands;
}

const BUBBLE_ACTIONS: BubbleAction[] = [
  {
    id: "bold",
    label: "Bold",
    icon: TextBoldIcon,
    isActive: (editor) => editor.isActive("bold"),
    run: (chain) => chain.toggleBold(),
  },
  {
    id: "italic",
    label: "Italic",
    icon: TextItalicIcon,
    isActive: (editor) => editor.isActive("italic"),
    run: (chain) => chain.toggleItalic(),
  },
  {
    id: "code",
    label: "Inline code",
    icon: CodeIcon,
    isActive: (editor) => editor.isActive("code"),
    run: (chain) => chain.toggleCode(),
  },
  {
    id: "heading",
    label: "Heading",
    icon: Heading02Icon,
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
    run: (chain) => chain.toggleHeading({ level: 2 }),
  },
  {
    id: "bulletList",
    label: "Bullet list",
    icon: LeftToRightListBulletIcon,
    isActive: (editor) => editor.isActive("bulletList"),
    run: (chain) => chain.toggleBulletList(),
  },
  {
    id: "taskList",
    label: "Checklist",
    icon: CheckListIcon,
    isActive: (editor) => editor.isActive("taskList"),
    run: (chain) => chain.toggleTaskList(),
  },
  {
    id: "codeBlock",
    label: "Code block",
    icon: SourceCodeIcon,
    isActive: (editor) => editor.isActive("codeBlock"),
    run: (chain) => chain.toggleCodeBlock(),
  },
  {
    id: "blockquote",
    label: "Quote",
    icon: LeftToRightBlockQuoteIcon,
    isActive: (editor) => editor.isActive("blockquote"),
    run: (chain) => chain.toggleBlockquote(),
  },
];

interface TasksEditorProps {
  value: string;
  onChange(markdown: string): void;
  placeholder?: string;
  readOnly?: boolean;
  autofocus?: boolean;
  variant?: "doc" | "comment";
  onUploadImage?: (
    file: File,
  ) => Promise<{ url: string; attachmentId: string }>;
  onAttachFiles?: (files: File[]) => void;
  mentionItems?: (query: string) => Promise<MentionItem[]>;
  onOpenThread?: (threadId: string) => void;
  onSubmit?: () => void;
  onEditorReady?: (editor: Editor) => void;
  className?: string;
}

export function TasksEditor({
  value,
  onChange,
  placeholder,
  readOnly = false,
  autofocus = false,
  variant = "doc",
  onUploadImage,
  onAttachFiles,
  mentionItems,
  onOpenThread,
  onSubmit,
  onEditorReady,
  className,
}: TasksEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const lastMarkdownRef = useRef(value);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const attachFilesRef = useRef(onAttachFiles);
  attachFilesRef.current = onAttachFiles;
  const mentionItemsRef = useRef(mentionItems);
  mentionItemsRef.current = mentionItems;
  const openThreadRef = useRef(onOpenThread);
  openThreadRef.current = onOpenThread;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const readyRef = useRef(onEditorReady);
  readyRef.current = onEditorReady;
  const initialValueRef = useRef(value);
  const autofocusRef = useRef(autofocus);
  const isPointerCoarse = usePointerCoarse();
  const canSubmitWithEnterKey = Boolean(onSubmit) && !isPointerCoarse;
  const canSubmitWithEnterRef = useRef(canSubmitWithEnterKey);
  canSubmitWithEnterRef.current = canSubmitWithEnterKey;
  const editorEnterKeyHint = onSubmit
    ? isPointerCoarse
      ? "enter"
      : "send"
    : undefined;

  const [, setRevision] = useState(0);
  const [mention, setMentionState] = useState<MentionPopoverState | null>(null);
  const mentionRef = useRef<MentionPopoverState | null>(null);
  const setMention = (next: MentionPopoverState | null) => {
    mentionRef.current = next;
    setMentionState(next);
  };
  const setMentionRef = useRef(setMention);
  setMentionRef.current = setMention;

  useEffect(() => {
    ensureEditorStyles();
    if (!rootRef.current) return;
    let editor: Editor;
    const upload = async (file: File) => {
      const handler = uploadRef.current;
      if (!handler || !file.type.startsWith("image/")) return false;
      const result = await handler(file);
      editor
        .chain()
        .focus()
        .setImage({ src: result.url, alt: file.name })
        .run();
      return true;
    };
    const mentionHandle: MentionSuggestionHandle = {
      getItems: (query) =>
        mentionItemsRef.current?.(query) ?? Promise.resolve([]),
      onChange: (props: SuggestionProps<MentionItem, MentionItem>) => {
        const previous = mentionRef.current;
        setMentionRef.current({
          items: props.items,
          clientRect: props.clientRect ?? null,
          command: props.command,
          selectedIndex: Math.min(
            previous?.selectedIndex ?? 0,
            Math.max(0, props.items.length - 1),
          ),
        });
      },
      onExit: () => setMentionRef.current(null),
      onKeyDown: (event) => {
        const state = mentionRef.current;
        if (!state || state.items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setMentionRef.current({
            ...state,
            selectedIndex: (state.selectedIndex + 1) % state.items.length,
          });
          return true;
        }
        if (event.key === "ArrowUp") {
          setMentionRef.current({
            ...state,
            selectedIndex:
              (state.selectedIndex - 1 + state.items.length) %
              state.items.length,
          });
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = state.items[state.selectedIndex];
          if (item) state.command(item);
          return true;
        }
        if (event.key === "Escape") {
          setMentionRef.current(null);
          return true;
        }
        return false;
      },
    };
    editor = new Editor({
      element: rootRef.current,
      editable: !readOnly,
      extensions: createEditorExtensions({
        placeholder: () => placeholderRef.current ?? "",
        mentionHandle,
      }),
      content: initialValueRef.current,
      autofocus: autofocusRef.current && !readOnly ? "end" : false,
      editorProps: {
        handleKeyDown(_view, event) {
          if (!onSubmitRef.current || readOnly) return false;
          if (event.key !== "Enter") return false;
          if (isImeComposing(event)) return false;
          const openMention = mentionRef.current;
          if (openMention && openMention.items.length > 0) return false;

          const withPrimaryMod =
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey;
          const plainEnter =
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey;

          if (event.shiftKey && !withPrimaryMod) return false;
          if (!withPrimaryMod && !plainEnter) return false;
          if (plainEnter && !canSubmitWithEnterRef.current) return false;

          event.preventDefault();
          onSubmitRef.current();
          return true;
        },
        handlePaste(_view, event) {
          const files = [...(event.clipboardData?.files ?? [])];
          if (attachFilesRef.current) {
            if (files.length === 0) return false;
            attachFilesRef.current(files);
            return true;
          }
          if (!uploadRef.current) return false;
          const file = files.find((candidate) =>
            candidate.type.startsWith("image/"),
          );
          if (!file) return false;
          void upload(file);
          return true;
        },
        handleDrop(_view, event) {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (attachFilesRef.current) {
            if (files.length === 0) return false;
            event.preventDefault();
            attachFilesRef.current(files);
            return true;
          }
          if (!uploadRef.current) return false;
          const file = files.find((candidate) =>
            candidate.type.startsWith("image/"),
          );
          if (!file) return false;
          event.preventDefault();
          void upload(file);
          return true;
        },
      },
    });
    editorRef.current = editor;
    if (!readOnly) {
      const last = editor.state.doc.lastChild;
      const paragraph = editor.state.schema.nodes.paragraph;
      if (paragraph && last && last.type.isLeaf) {
        editor.view.dispatch(
          editor.state.tr.insert(
            editor.state.doc.content.size,
            paragraph.create(),
          ),
        );
      }
    }
    if (variant === "doc" && !readOnly && bubbleRef.current) {
      editor.registerPlugin(
        BubbleMenuPlugin({
          pluginKey: "tasksBubbleMenu",
          editor,
          element: bubbleRef.current,
          updateDelay: 150,
          tippyOptions: {
            duration: 120,
            placement: "top",
            maxWidth: "none",
            zIndex: 40,
            appendTo: () => rootRef.current?.parentElement ?? document.body,
          },
          shouldShow: ({ editor: bubbleEditor, state, from, to }) => {
            const { selection } = state;
            if (!bubbleEditor.isEditable || selection.empty) return false;
            if (isNodeSelection(selection)) return false;
            return state.doc.textBetween(from, to).trim().length > 0;
          },
        }),
      );
    }
    editor.on("update", () => {
      const markdown = editor.storage.markdown.getMarkdown() as string;
      lastMarkdownRef.current = markdown;
      changeRef.current(markdown);
    });
    editor.on("transaction", () => setRevision((current) => current + 1));
    readyRef.current?.(editor);
    const root = rootRef.current;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const pill = event.target.closest("[data-thread-mention]");
      const threadId = pill?.getAttribute("data-thread-mention");
      if (threadId && openThreadRef.current) {
        event.preventDefault();
        openThreadRef.current(threadId);
      }
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
      editorRef.current = null;
      setMentionRef.current(null);
      editor.destroy();
    };
  }, [readOnly, variant]);

  useEffect(() => {
    initialValueRef.current = value;
    const editor = editorRef.current;
    if (!editor || value === lastMarkdownRef.current) return;
    lastMarkdownRef.current = value;
    editor.commands.setContent(value, false);
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) return;
    if (editorEnterKeyHint) {
      editor.view.dom.setAttribute("enterkeyhint", editorEnterKeyHint);
    } else {
      editor.view.dom.removeAttribute("enterkeyhint");
    }
  }, [editorEnterKeyHint]);

  const editor = editorRef.current;
  const mentionRect = mention?.clientRect?.() ?? null;
  const taskItems = (mention?.items ?? [])
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.type === "task");
  const threadItems = (mention?.items ?? [])
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.type === "thread");

  const mentionRow = ({
    item,
    index,
  }: {
    item: MentionItem;
    index: number;
  }) => (
    <button
      key={item.id}
      type="button"
      role="option"
      aria-selected={index === mention?.selectedIndex}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
        index === mention?.selectedIndex
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => mention?.command(item)}
    >
      {item.type === "task" ? (
        <span className="shrink-0 font-medium text-muted-foreground">
          {item.key}
        </span>
      ) : (
        <HugeiconsIcon
          icon={BubbleChatIcon}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
    </button>
  );

  const focusOnEmptyMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly) return;
    if (
      event.target === wrapperRef.current ||
      event.target === rootRef.current
    ) {
      event.preventDefault();
      editorRef.current?.commands.focus("end");
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={cn("bb-tasks-editor relative min-w-0", className)}
      data-variant={variant}
      onMouseDown={variant === "doc" ? focusOnEmptyMouseDown : undefined}
    >
      {}
      {variant === "doc" && !readOnly ? (
        <div
          ref={bubbleRef}
          role="toolbar"
          aria-label="Formatting"
          style={{ visibility: "hidden" }}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 text-popover-foreground shadow-md"
        >
          {BUBBLE_ACTIONS.map((action) => (
            <Button
              key={action.id}
              type="button"
              size="icon"
              variant="ghost"
              aria-label={action.label}
              aria-pressed={editor ? action.isActive(editor) : false}
              className={cn(
                "size-7 text-muted-foreground",
                editor && action.isActive(editor)
                  ? "bg-accent text-accent-foreground"
                  : undefined,
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const current = editorRef.current;
                if (!current) return;
                action.run(current.chain().focus()).run();
              }}
            >
              <HugeiconsIcon icon={action.icon} className="size-4" />
            </Button>
          ))}
        </div>
      ) : null}
      <div ref={rootRef} className="bb-tasks-editor-surface min-w-0" />
      {mention && mention.items.length > 0 ? (
        <div
          role="listbox"
          aria-label="Mention a task or thread"
          className="fixed z-50 max-h-64 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          style={
            mentionRect
              ? { top: mentionRect.bottom + 4, left: mentionRect.left }
              : undefined
          }
        >
          {taskItems.length > 0 ? (
            <div className="px-2 pb-0.5 pt-1 text-2xs font-semibold text-muted-foreground">
              Tasks
            </div>
          ) : null}
          {taskItems.map(mentionRow)}
          {threadItems.length > 0 ? (
            <div className="px-2 pb-0.5 pt-1 text-2xs font-semibold text-muted-foreground">
              Threads
            </div>
          ) : null}
          {threadItems.map(mentionRow)}
        </div>
      ) : null}
    </div>
  );
}
