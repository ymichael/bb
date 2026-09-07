import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopContextMenuTemplate,
  registerDesktopContextMenu,
  type DesktopContextMenuWebContents,
} from "../src/desktop-context-menu.js";

const popup = vi.fn();
const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    writeText: writeClipboardText,
  },
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]) {
      return { popup, template };
    },
  },
}));

const DEFAULT_EDIT_FLAGS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
} satisfies ContextMenuParams["editFlags"];

const DEFAULT_MEDIA_FLAGS = {
  inError: false,
  isPaused: false,
  isMuted: false,
  hasAudio: false,
  isLooping: false,
  isControlsVisible: false,
  canToggleControls: false,
  canPrint: false,
  canSave: false,
  canShowPictureInPicture: false,
  isShowingPictureInPicture: false,
  canRotate: false,
  canLoop: false,
} satisfies ContextMenuParams["mediaFlags"];

interface FakeWebContents extends Pick<
  DesktopContextMenuWebContents,
  "replaceMisspelling" | "session"
> {
  addedDictionaryWords: string[];
  replacedMisspellings: string[];
  spellCheckerEnabledValues: boolean[];
}

function createContextMenuParams(
  overrides: Partial<ContextMenuParams> = {},
): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "",
    frameURL: "",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "utf-8",
    formControlType: "none",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: DEFAULT_MEDIA_FLAGS,
    editFlags: DEFAULT_EDIT_FLAGS,
    ...overrides,
  };
}

function createFakeWebContents(): FakeWebContents {
  const addedDictionaryWords: string[] = [];
  const replacedMisspellings: string[] = [];
  const spellCheckerEnabledValues: boolean[] = [];
  return {
    addedDictionaryWords,
    replacedMisspellings,
    spellCheckerEnabledValues,
    replaceMisspelling(text) {
      replacedMisspellings.push(text);
    },
    session: {
      addWordToSpellCheckerDictionary(word) {
        addedDictionaryWords.push(word);
        return true;
      },
      setSpellCheckerEnabled(enabled) {
        spellCheckerEnabledValues.push(enabled);
      },
    },
  };
}

function clickMenuItem(item: MenuItemConstructorOptions | undefined): void {
  item?.click?.(undefined as never, undefined as never, undefined as never);
}

describe("desktop context menu", () => {
  it("uses Electron's spelling result even when spellcheckEnabled is false", () => {
    const webContents = createFakeWebContents();
    const params = createContextMenuParams({
      formControlType: "input-text",
      isEditable: true,
      spellcheckEnabled: false,
      misspelledWord: "teh",
      dictionarySuggestions: ["the", "tech"],
    });
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params,
    });

    expect(template[0]).toMatchObject({ label: "the" });
    expect(template[1]).toMatchObject({ label: "tech" });

    clickMenuItem(template[0]);

    expect(webContents.replacedMisspellings).toEqual(["the"]);
  });

  it("can add a misspelled word to the spellchecker dictionary", () => {
    const webContents = createFakeWebContents();
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        isEditable: true,
        spellcheckEnabled: true,
        misspelledWord: "bbapp",
      }),
    });

    expect(template[0]).toMatchObject({
      label: "No Spelling Suggestions",
      enabled: false,
    });
    expect(template[1]).toMatchObject({
      label: 'Add "bbapp" to Dictionary',
    });

    clickMenuItem(template[1]);

    expect(webContents.addedDictionaryWords).toEqual(["bbapp"]);
  });

  it("keeps standard edit actions in editable context menus", () => {
    const webContents = createFakeWebContents();
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        isEditable: true,
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canPaste: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toEqual([
      { role: "undo", enabled: false },
      { role: "redo", enabled: false },
      { type: "separator" },
      { role: "cut", enabled: false },
      { role: "copy", enabled: true },
      { role: "paste", enabled: true },
      { role: "delete", enabled: false },
      { type: "separator" },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("copies a link target", () => {
    const webContents = createFakeWebContents();
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        linkURL: "https://example.com/device",
      }),
    });

    expect(template).toEqual([
      { label: "Copy Link", click: expect.any(Function) },
    ]);

    clickMenuItem(template[0]);

    expect(writeClipboardText).toHaveBeenCalledWith(
      "https://example.com/device",
    );
  });

  it("groups selected-text actions together", () => {
    const webContents = createFakeWebContents();
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        selectionText: "device authorization",
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toEqual([
      { role: "copy", enabled: true },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("preserves selected-text actions for links", () => {
    const webContents = createFakeWebContents();
    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        linkURL: "https://example.com/device",
        selectionText: "device authorization",
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toMatchObject([
      { label: "Copy Link" },
      { type: "separator" },
      { role: "copy", enabled: true },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("does not show an empty menu for inert content", () => {
    const webContents = createFakeWebContents();

    expect(
      buildDesktopContextMenuTemplate({
        webContents,
        params: createContextMenuParams(),
      }),
    ).toEqual([]);
  });

  it("registers the native menu popup for context-menu events", async () => {
    const webContents = {
      ...createFakeWebContents(),
      on: vi.fn(),
    } satisfies DesktopContextMenuWebContents;

    registerDesktopContextMenu({ webContents });

    expect(webContents.spellCheckerEnabledValues).toEqual([false]);

    const listener = webContents.on.mock.calls[0]?.[1];
    listener?.(
      undefined as never,
      createContextMenuParams({
        selectionText: "selected",
        editFlags: { ...DEFAULT_EDIT_FLAGS, canCopy: true },
      }),
    );

    await Promise.resolve();

    expect(popup).toHaveBeenCalledOnce();
  });
});
