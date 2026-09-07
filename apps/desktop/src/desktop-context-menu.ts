import {
  clipboard,
  Menu,
  type ContextMenuParams,
  type Event,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";

export interface DesktopContextMenuWebContents {
  on(
    eventName: "context-menu",
    listener: (event: Event, params: ContextMenuParams) => void,
  ): void;
  replaceMisspelling(text: string): void;
  session: Pick<
    Session,
    "addWordToSpellCheckerDictionary" | "setSpellCheckerEnabled"
  >;
}

interface DesktopContextMenuSpellcheckContext {
  dictionarySuggestions: string[];
  misspelledWord: string;
}

interface BuildDesktopContextMenuTemplateArgs {
  params: ContextMenuParams;
  webContents: Pick<
    DesktopContextMenuWebContents,
    "replaceMisspelling" | "session"
  >;
}

interface RegisterDesktopContextMenuArgs {
  webContents: DesktopContextMenuWebContents;
}

function pushSeparatorIfNeeded(template: MenuItemConstructorOptions[]): void {
  if (template.length === 0) {
    return;
  }
  if (template.at(-1)?.type === "separator") {
    return;
  }
  template.push({ type: "separator" });
}

function trimTrailingSeparator(
  template: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  if (template.at(-1)?.type !== "separator") {
    return template;
  }
  return template.slice(0, -1);
}

function getSpellcheckContextFromParams(
  params: ContextMenuParams,
): DesktopContextMenuSpellcheckContext | null {
  if (!params.isEditable || params.misspelledWord.length === 0) {
    return null;
  }
  return {
    dictionarySuggestions: params.dictionarySuggestions,
    misspelledWord: params.misspelledWord,
  };
}

export function buildDesktopContextMenuTemplate({
  params,
  webContents,
}: BuildDesktopContextMenuTemplateArgs): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const spellcheckContext = getSpellcheckContextFromParams(params);

  if (spellcheckContext !== null) {
    if (spellcheckContext.dictionarySuggestions.length > 0) {
      for (const suggestion of spellcheckContext.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => {
            webContents.replaceMisspelling(suggestion);
          },
        });
      }
    } else {
      template.push({
        label: "No Spelling Suggestions",
        enabled: false,
      });
    }
    template.push({
      label: `Add "${spellcheckContext.misspelledWord}" to Dictionary`,
      click: () => {
        webContents.session.addWordToSpellCheckerDictionary(
          spellcheckContext.misspelledWord,
        );
      },
    });
    pushSeparatorIfNeeded(template);
  }

  if (params.linkURL.length > 0) {
    template.push({
      label: "Copy Link",
      click: () => {
        clipboard.writeText(params.linkURL);
      },
    });
    pushSeparatorIfNeeded(template);
  }

  if (params.isEditable) {
    const { editFlags } = params;
    template.push(
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { role: "delete", enabled: editFlags.canDelete },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    );
    return trimTrailingSeparator(template);
  }

  if (params.selectionText.length > 0 && params.editFlags.canCopy) {
    template.push({ role: "copy", enabled: true });
  }
  if (params.editFlags.canSelectAll) {
    template.push({ role: "selectAll", enabled: true });
  }

  return trimTrailingSeparator(template);
}

function showDesktopContextMenu({
  params,
  webContents,
}: RegisterDesktopContextMenuArgs & {
  params: ContextMenuParams;
}): void {
  const template = buildDesktopContextMenuTemplate({
    params,
    webContents,
  });
  if (template.length === 0) {
    return;
  }
  Menu.buildFromTemplate(template).popup();
}

export function registerDesktopContextMenu({
  webContents,
}: RegisterDesktopContextMenuArgs): void {
  webContents.session.setSpellCheckerEnabled(false);
  webContents.on("context-menu", (_event, params) => {
    showDesktopContextMenu({ params, webContents });
  });
}
