import { toast } from "sonner";
import type * as MonacoNs from "monaco-editor";

type Editor = MonacoNs.editor.IStandaloneCodeEditor;

export type ActiveEditor = {
  editor: Editor;
  absolutePath: string;
  relativePath: string;
};

let lastFocused: ActiveEditor | null = null;

export function markEditorActive(active: ActiveEditor): void {
  lastFocused = active;
}

export function forgetEditor(editor: Editor): void {
  if (lastFocused?.editor === editor) lastFocused = null;
}

function targetEditor(): ActiveEditor | null {
  const node = lastFocused?.editor.getDomNode();
  if (!node || !node.isConnected || node.offsetParent === null) return null;
  return lastFocused;
}

function hasMultiLineSelection({ editor }: ActiveEditor): boolean {
  return (
    editor
      .getSelections()
      ?.some(
        (selection) =>
          !selection.isEmpty() &&
          selection.startLineNumber !== selection.endLineNumber,
      ) ?? false
  );
}

export type EditorCommand = {
  id: string;
  title: string;
  precondition?: (active: ActiveEditor) => boolean;
  run: (active: ActiveEditor) => void | Promise<void>;
};

function monacoAction(
  id: string,
  title: string,
  actionId: string,
  precondition?: (active: ActiveEditor) => boolean,
): EditorCommand {
  return {
    id,
    title,
    precondition,
    run: async ({ editor }) => {
      editor.focus();
      await editor.getAction(actionId)?.run();
    },
  };
}

function copy(text: string, successMessage: string): Promise<void> {
  return navigator.clipboard
    .writeText(text)
    .then(() => {
      toast.success(successMessage);
    })
    .catch(() => {
      toast.error("Failed to copy");
    });
}

export const EDITOR_COMMANDS: readonly EditorCommand[] = [
  ...[1, 2, 3, 4, 5].map((level) =>
    monacoAction(
      `fold-level-${level}`,
      `Monaco: fold level ${level}`,
      `editor.foldLevel${level}`,
    ),
  ),
  monacoAction(
    "fold-recursively",
    "Monaco: fold recursively",
    "editor.foldRecursively",
  ),
  monacoAction("unfold-all", "Monaco: unfold all", "editor.unfoldAll"),
  monacoAction(
    "unfold-recursively",
    "Monaco: unfold recursively",
    "editor.unfoldRecursively",
  ),
  monacoAction("unfold", "Monaco: unfold at cursor", "editor.unfold"),
  monacoAction(
    "sort-lines-ascending",
    "Monaco: sort selected lines ascending",
    "editor.action.sortLinesAscending",
    hasMultiLineSelection,
  ),
  monacoAction(
    "sort-lines-descending",
    "Monaco: sort selected lines descending",
    "editor.action.sortLinesDescending",
    hasMultiLineSelection,
  ),
  {
    id: "copy-path",
    title: "Monaco: copy path of current file",
    run: ({ absolutePath }) => copy(absolutePath, "Absolute path copied"),
  },
  {
    id: "copy-relative-path",
    title: "Monaco: copy relative path of current file",
    run: ({ relativePath }) => copy(relativePath, "Relative path copied"),
  },
];

export function isCommandAvailable(command: EditorCommand): boolean {
  const active = targetEditor();
  if (!active) return false;
  return command.precondition?.(active) ?? true;
}

export async function runEditorCommand(command: EditorCommand): Promise<void> {
  const active = targetEditor();
  if (!active || !(command.precondition?.(active) ?? true)) return;
  await command.run(active);
}
