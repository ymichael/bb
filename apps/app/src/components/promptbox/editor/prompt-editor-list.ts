import { commands, type Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";

interface SplitListEditorContext {
  extensionManager: {
    attributes: Editor["extensionManager"]["attributes"];
  };
}

export function createSplitPromptListItemTransaction(args: {
  state: EditorState;
  editor: SplitListEditorContext;
}): Transaction | null {
  const listItemType = args.state.schema.nodes.listItem;
  if (!listItemType) return null;

  const transaction = args.state.tr;
  let nextTransaction: Transaction | null = null;
  const didSplit = commands.splitListItem(listItemType)({
    state: args.state,
    tr: transaction,
    dispatch: () => {
      nextTransaction = transaction;
    },
    editor: args.editor as Editor,
    commands: null as never,
    can: null as never,
    chain: null as never,
    view: null as never,
  });

  return didSplit && transaction.docChanged
    ? (nextTransaction ?? transaction)
    : null;
}

function createLiftPromptListItemTransaction(args: {
  state: EditorState;
  editor: SplitListEditorContext;
}): Transaction | null {
  const listItemType = args.state.schema.nodes.listItem;
  if (!listItemType) return null;

  let nextTransaction: Transaction | null = null;
  const didLift = commands.liftListItem(listItemType)({
    state: args.state,
    tr: args.state.tr,
    dispatch: (transaction?: Transaction) => {
      nextTransaction = transaction ?? args.state.tr;
    },
    editor: args.editor as Editor,
    commands: null as never,
    can: null as never,
    chain: null as never,
    view: null as never,
  });

  const dispatchedTransaction = nextTransaction as Transaction | null;
  return didLift && dispatchedTransaction?.docChanged
    ? dispatchedTransaction
    : null;
}

function isSelectionInEmptyListItem(state: EditorState): boolean {
  const { selection } = state;
  if (!selection.empty) return false;

  const { $from } = selection;
  if ($from.parent.type.name !== "paragraph" || $from.parent.content.size > 0) {
    return false;
  }

  for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem") continue;
    return (
      node.childCount === 1 &&
      node.firstChild?.type.name === "paragraph" &&
      node.firstChild.content.size === 0
    );
  }

  return false;
}

export function createPromptListNewlineTransaction(args: {
  state: EditorState;
  editor: SplitListEditorContext;
}): Transaction | null {
  if (isSelectionInEmptyListItem(args.state)) {
    return createLiftPromptListItemTransaction(args);
  }

  return (
    createSplitPromptListItemTransaction(args) ??
    createLiftPromptListItemTransaction(args)
  );
}

export function applyPromptListNewline(editor: Editor): boolean {
  const transaction = createPromptListNewlineTransaction({
    state: editor.state,
    editor,
  });
  if (transaction === null) return false;
  editor.view.dispatch(transaction);
  return true;
}
