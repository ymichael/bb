// @vitest-environment jsdom

import type { PromptTextMention } from "@bb/domain";
import { TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import {
  createRef,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import {
  EMPTY_ORDERED_MENTION_SUGGESTIONS,
  emptyPromptDraftState,
} from "@bb/client-core";
import {
  getComposerInputLock,
  useComposer,
  useComposerView,
} from "@/lib/plugin-sdk-hooks";
import {
  getComposerTextEffects,
  useComposerTextEffects,
} from "@/lib/composer-text-effects";
import {
  getPluginThreadRowStatus,
  resetPluginThreadRowStatusesForTest,
} from "@/lib/plugin-thread-row-status";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  PluginComposerHostProvider,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { QueuedEditorTypeaheadLayoutContext } from "@/components/promptbox/queued-editor-typeahead-layout";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  AUTOMATION_PROMPT_ACTION,
  CREATE_PLUGIN_PROMPT_ACTION,
} from "./PromptBoxActionsMenu";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
  arePromptEditorValuesEqual,
  suppressPromptEditorAnchorActivation,
  type PromptBoxAction,
  type PromptBoxHandle,
  type PromptVoiceConfig,
  type TypeaheadConfig,
} from "./PromptBoxInternal";
import { promptMentionClipboardContent } from "./mentions/prompt-mention-clipboard";
import { orderPromptMentionSuggestions } from "@/hooks/promptMentionCandidates";
import type {
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
} from "@bb/client-core";

type PromptBoxProps = ComponentProps<typeof PromptBoxInternal>;

function pluginRegistrationSet(
  composerCustomizations: NonNullable<
    PluginRegistrationSet["composerCustomizations"]
  >,
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    composerCustomizations,
  });
}

interface PromptChange {
  mentions: PromptTextMention[];
  value: string;
}

const promptActions: readonly PromptBoxAction[] = [
  { kind: "skills", text: "/" },
  {
    kind: "plan",
    command: { trigger: "/", name: "plan", trailingText: " " },
    text: "/plan ",
  },
  {
    kind: "goal",
    command: { trigger: "/", name: "goal", trailingText: " " },
    text: "/goal ",
  },
  AUTOMATION_PROMPT_ACTION,
  CREATE_PLUGIN_PROMPT_ACTION,
];

function createPromptBoxProps(
  overrides: Partial<PromptBoxProps> = {},
): PromptBoxProps {
  return {
    value: "",
    mentionRanges: [],
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    mentionMenuPlacement: "bottom",
    typeahead: {
      mention: {
        results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
        isLoading: false,
        isError: false,
        onQueryChange: vi.fn(),
      },
      command: INERT_TYPEAHEAD_COMMAND_CONFIG,
    },
    ...overrides,
  };
}

function buildTypeaheadConfig({
  mentionTriggers,
  mentionSuggestions = [],
  onMentionQueryChange = () => {},
  commandSuggestions = [],
  onCommandQueryChange = () => {},
}: {
  mentionTriggers?: TypeaheadConfig["mention"]["triggers"];
  mentionSuggestions?: readonly PromptMentionSuggestion[];
  onMentionQueryChange?: TypeaheadConfig["mention"]["onQueryChange"];
  commandSuggestions?: TypeaheadConfig["command"]["suggestions"];
  onCommandQueryChange?: (query: string | null) => void;
} = {}): TypeaheadConfig {
  return {
    mention: {
      triggers: mentionTriggers,
      results: orderPromptMentionSuggestions({
        query: "",
        suggestions: mentionSuggestions,
      }),
      isLoading: false,
      isError: false,
      onQueryChange: onMentionQueryChange,
    },
    command: {
      trigger: "/",
      suggestions: commandSuggestions,
      isLoading: false,
      isError: false,
      hasMore: false,
      isLoadingMore: false,
      loadMore: () => {},
      onQueryChange: onCommandQueryChange,
    },
  };
}

function PromptBoxRaceHarness({
  onChange,
  value,
}: {
  onChange: PromptBoxProps["onChange"];
  value: string;
}) {
  const promptBoxRef = useRef<PromptBoxHandle | null>(null);
  const insertedForValueRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (value === "" || insertedForValueRef.current === value) return;

    insertedForValueRef.current = value;
    promptBoxRef.current?.focusEnd();
    promptBoxRef.current?.insertTextAtCursor("reply");
  }, [value]);

  return (
    <PromptBoxInternal
      {...createPromptBoxProps({
        onChange,
        value,
      })}
      promptBoxRef={promptBoxRef}
    />
  );
}

function PromptBoxFocusOnMountHarness() {
  const promptBoxRef = useRef<PromptBoxHandle | null>(null);

  useLayoutEffect(() => {
    promptBoxRef.current?.focusEnd();
  }, []);

  return (
    <PromptBoxInternal
      {...createPromptBoxProps()}
      promptBoxRef={promptBoxRef}
    />
  );
}

function PromptBoxHistoryAutoFocusHarness({
  historyResetKey,
}: {
  historyResetKey: string | number;
}) {
  return (
    <>
      <button type="button">Outside focus target</button>
      <PromptBoxInternal
        {...createPromptBoxProps({
          history: {
            currentDraft: emptyPromptDraftState(),
            entries: [],
            onSelectEntry: vi.fn(),
            resetKey: historyResetKey,
          },
        })}
      />
    </>
  );
}

function PromptBoxHistoryAutoFocusAfterLayoutStealHarness({
  historyResetKey,
}: {
  historyResetKey: string | number;
}) {
  const outsideTargetRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    outsideTargetRef.current?.focus();
  }, [historyResetKey]);

  return (
    <>
      <PromptBoxInternal
        {...createPromptBoxProps({
          history: {
            currentDraft: emptyPromptDraftState(),
            entries: [],
            onSelectEntry: vi.fn(),
            resetKey: historyResetKey,
          },
        })}
      />
      <button ref={outsideTargetRef} type="button">
        Late layout focus target
      </button>
    </>
  );
}

function renderPromptBox(
  initialValue: string,
  options: {
    initialMentionRanges?: PromptTextMention[];
    mentionTriggers?: TypeaheadConfig["mention"]["triggers"];
    mentionSuggestions?: readonly PromptMentionSuggestion[];
    commandSuggestions?: TypeaheadConfig["command"]["suggestions"];
    onAttachFiles?: (files: File[]) => Promise<void> | void;
  } = {},
) {
  const changes: PromptChange[] = [];
  const onMentionQueryChange = vi.fn();
  const onCommandQueryChange = vi.fn();
  const onSubmit = vi.fn();
  const promptBoxRef = createRef<PromptBoxHandle>();

  function PromptBoxHarness() {
    const [value, setValue] = useState(initialValue);
    const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>(
      options.initialMentionRanges ?? [],
    );
    return (
      <PromptBoxInternal
        value={value}
        mentionRanges={mentionRanges}
        onChange={(nextValue, nextMentions) => {
          changes.push({ mentions: nextMentions, value: nextValue });
          setValue(nextValue);
          setMentionRanges(nextMentions);
        }}
        onSubmit={onSubmit}
        typeahead={buildTypeaheadConfig({
          mentionTriggers: options.mentionTriggers,
          mentionSuggestions: options.mentionSuggestions,
          onMentionQueryChange,
          commandSuggestions: options.commandSuggestions,
          onCommandQueryChange,
        })}
        mentionMenuPlacement="bottom"
        attachments={{ onAttachFiles: options.onAttachFiles }}
        promptActions={promptActions}
        promptBoxRef={promptBoxRef}
      />
    );
  }

  render(<PromptBoxHarness />);
  return {
    changes,
    onMentionQueryChange,
    onCommandQueryChange,
    onSubmit,
    promptBoxRef,
  };
}

function dispatchThroughEditorTarget({
  eventName,
  target,
}: {
  eventName: "auxclick" | "click";
  target: HTMLElement;
}) {
  const editorRoot = document.createElement("div");
  editorRoot.append(target);
  document.body.append(editorRoot);

  let suppressed = false;
  editorRoot.addEventListener(eventName, (event) => {
    suppressed = suppressPromptEditorAnchorActivation(event);
  });

  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
  });
  const defaultAllowed = target.dispatchEvent(event);

  editorRoot.remove();
  return { defaultAllowed, event, suppressed };
}

async function selectPromptAction(label: string) {
  await waitFor(() =>
    expect(document.activeElement).toBe(getPromptEditorElement()),
  );
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const trigger = screen.getByRole("button", { name: "Prompt actions" });
  fireEvent.pointerDown(trigger, { button: 0 });
  const menu = await screen.findByRole("menu", { name: "Prompt actions" });
  const menuItem = within(menu).getByRole("menuitem", { name: label });
  fireEvent.click(menuItem);
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Prompt actions" })).toBeNull(),
  );
  if (label !== "Attach files") {
    await waitFor(() =>
      expect(document.activeElement).toBe(getPromptEditorElement()),
    );
  }
}

async function selectCommandSuggestion(label: string) {
  const suggestion = await screen.findByRole("button", { name: label });
  fireEvent.mouseDown(suggestion, { button: 0 });
}

function getPromptEditorElement(): HTMLElement {
  const editorElement = document.querySelector(".ProseMirror");
  if (!(editorElement instanceof HTMLElement)) {
    throw new Error("Prompt editor element was not rendered");
  }
  return editorElement;
}

function latestValue(changes: readonly PromptChange[]): string | undefined {
  return changes[changes.length - 1]?.value;
}

function latestChange(
  changes: readonly PromptChange[],
): PromptChange | undefined {
  return changes[changes.length - 1];
}

async function waitForPromptFocus() {
  await waitFor(() =>
    expect(document.activeElement).toBe(getPromptEditorElement()),
  );
}

async function focusPromptEnd(promptBoxRef: RefObject<PromptBoxHandle | null>) {
  await waitFor(() => expect(promptBoxRef.current).not.toBeNull());
  await act(async () => {
    promptBoxRef.current?.focusEnd();
  });
}

function pastePlainText(text: string) {
  pasteClipboard({ plainText: text });
}

function pasteClipboard({
  files = [],
  html = "",
  plainText = "",
}: {
  files?: File[];
  html?: string;
  plainText?: string;
}) {
  fireEvent.paste(getPromptEditorElement(), {
    clipboardData: {
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
      })),
      getData: (type: string) => {
        if (type === "text/html") return html;
        if (type === "text/plain") return plainText;
        return "";
      },
    },
  });
}

function mockPointerCoarse(matches: boolean): () => void {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  return () => {
    window.matchMedia = originalMatchMedia;
  };
}

function mockNavigatorIdentity({
  userAgent,
  vendor,
  platform,
  maxTouchPoints,
}: Pick<
  Navigator,
  "userAgent" | "vendor" | "platform" | "maxTouchPoints"
>): () => void {
  const userAgentMock = vi
    .spyOn(navigator, "userAgent", "get")
    .mockReturnValue(userAgent);
  const vendorMock = vi
    .spyOn(navigator, "vendor", "get")
    .mockReturnValue(vendor);
  const platformMock = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue(platform);
  const maxTouchPointsDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "maxTouchPoints",
  );
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: maxTouchPoints,
  });
  return () => {
    if (maxTouchPointsDescriptor) {
      Object.defineProperty(
        navigator,
        "maxTouchPoints",
        maxTouchPointsDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "maxTouchPoints");
    }
    platformMock.mockRestore();
    vendorMock.mockRestore();
    userAgentMock.mockRestore();
  };
}

function mockIPadOSWebKit(): () => void {
  return mockNavigatorIdentity({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
      "AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    vendor: "Apple Computer, Inc.",
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
}

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 2));
  resetPluginLogoStoreForTest();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  resetPluginThreadRowStatusesForTest();
  vi.clearAllMocks();
});

describe("suppressPromptEditorAnchorActivation", () => {
  it("cancels anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("cancels auxiliary anchor clicks inside the prompt editor", () => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com";
    anchor.textContent = "https://example.com";

    const result = dispatchThroughEditorTarget({
      eventName: "auxclick",
      target: anchor,
    });

    expect(result.suppressed).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.defaultAllowed).toBe(false);
  });

  it("does not cancel ordinary prompt editor clicks", () => {
    const span = document.createElement("span");
    span.textContent = "plain prompt text";

    const result = dispatchThroughEditorTarget({
      eventName: "click",
      target: span,
    });

    expect(result.suppressed).toBe(false);
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.defaultAllowed).toBe(true);
  });
});

describe("PromptBoxInternal controlled value sync", () => {
  it("compares cloned mention values without serializing the prompt text", () => {
    const resource = {
      kind: "path" as const,
      source: "workspace" as const,
      entryKind: "file" as const,
      path: "src/a.ts",
      label: "a.ts",
    };
    const mention: PromptTextMention = {
      start: 4,
      end: 10,
      resource,
    };
    const left = { text: "see @a.ts", mentions: [mention] };

    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [{ ...mention, resource: { ...resource } }],
      }),
    ).toBe(true);
    expect(
      arePromptEditorValuesEqual(left, {
        text: left.text,
        mentions: [
          {
            ...mention,
            resource: { ...resource, path: "src/b.ts" },
          },
        ],
      }),
    ).toBe(false);
  });

  it("suppresses and restores plugin customizations without remounting the editor", () => {
    setPluginSlotRegistrations(
      "pending-test",
      pluginRegistrationSet([
        {
          id: "tools",
          actions: [
            { id: "action", component: () => <button>Plugin action</button> },
          ],
          plusMenu: [
            {
              id: "menu",
              label: "Plugin menu item",
              run: () => {},
            },
          ],
        },
      ]),
    );
    const props = createPromptBoxProps({ value: "Retained draft" });
    const view = render(<PromptBoxInternal {...props} />);
    const editor = getPromptEditorElement();

    expect(screen.getByRole("button", { name: "Plugin action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prompt actions" })).toBeTruthy();

    view.rerender(
      <PromptBoxInternal {...props} suppressPluginComposerCustomizations />,
    );

    expect(screen.queryByRole("button", { name: "Plugin action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prompt actions" })).toBeNull();
    expect(getPromptEditorElement()).toBe(editor);

    view.rerender(
      <PromptBoxInternal
        {...props}
        suppressPluginComposerCustomizations={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Plugin action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prompt actions" })).toBeTruthy();
    expect(getPromptEditorElement()).toBe(editor);
  });

  it("decorates only draft text and removes the effect when cleared", async () => {
    const props = createPromptBoxProps({ value: "Keep this draft readable" });
    const view = render(
      <PromptBoxInternal
        {...props}
        textEffects={[
          {
            pluginId: "test",
            effect: { className: "test-text-effect" },
            order: 0,
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(
        view.container.querySelector(".test-text-effect")?.textContent,
      ).toBe("Keep this draft readable");
    });
    expect(
      view.container
        .querySelector("[data-promptbox]")
        ?.classList.contains("test-text-effect"),
    ).toBe(false);

    view.rerender(<PromptBoxInternal {...props} textEffects={[]} />);
    await waitFor(() => {
      expect(view.container.querySelector(".test-text-effect")).toBeNull();
    });
  });

  it("paints simultaneous imperative plugin effects and removes owners independently", async () => {
    const props = createPromptBoxProps({ value: "Overlapping effects" });
    const alpha = {
      pluginId: "alpha",
      effect: { className: "alpha-effect" },
      order: 1,
    } as const;
    const zeta = {
      pluginId: "zeta",
      effect: { className: "zeta-effect" },
      order: 2,
    } as const;
    const view = render(
      <PromptBoxInternal {...props} textEffects={[alpha, zeta]} />,
    );

    await waitFor(() => {
      expect(view.container.querySelector(".alpha-effect")?.textContent).toBe(
        "Overlapping effects",
      );
      expect(view.container.querySelector(".zeta-effect")?.textContent).toBe(
        "Overlapping effects",
      );
    });
    view.rerender(<PromptBoxInternal {...props} textEffects={[zeta]} />);
    await waitFor(() => {
      expect(view.container.querySelector(".alpha-effect")).toBeNull();
      expect(view.container.querySelector(".zeta-effect")?.textContent).toBe(
        "Overlapping effects",
      );
    });

    view.rerender(<PromptBoxInternal {...props} textEffects={[]} />);
    await waitFor(() => {
      expect(view.container.querySelector(".zeta-effect")).toBeNull();
    });
  });

  it("wires scoped plugin rich-text rules and draft observers without rebuilding the editor", async () => {
    const onDraftChange = vi.fn();
    setPluginSlotRegistrations(
      "rich-text",
      pluginRegistrationSet([
        {
          id: "active",
          scopes: ["new-thread"],
          richText: {
            effects: [
              {
                id: "paint",
                className: "plugin-draft-paint",
                match: (text) => [{ from: 0, to: text.length }],
              },
            ],
            onDraftChange,
          },
        },
        {
          id: "wrong-scope",
          scopes: ["thread"],
          richText: {
            effects: [
              {
                id: "hidden",
                className: "wrong-scope-paint",
                match: (text) => [{ from: 0, to: text.length }],
              },
            ],
          },
        },
      ]),
    );
    const props = createPromptBoxProps({ value: "Decorate this draft" });
    const view = render(<PromptBoxInternal {...props} />);
    const editor = getPromptEditorElement();

    await waitFor(() => {
      expect(
        view.container.querySelector(".plugin-draft-paint")?.textContent,
      ).toBe("Decorate this draft");
    });
    expect(view.container.querySelector(".wrong-scope-paint")).toBeNull();
    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        { text: "Decorate this draft", mentions: [] },
        expect.objectContaining({
          scope: { kind: "new-thread", projectId: null },
          draft: expect.objectContaining({ text: "Decorate this draft" }),
        }),
      );
    });

    act(() => {
      setPluginSlotRegistrations(
        "rich-text",
        pluginRegistrationSet([
          {
            id: "replacement",
            richText: {
              effects: [
                {
                  id: "paint-next",
                  className: "plugin-draft-paint-next",
                  match: (text) => [{ from: 0, to: text.length }],
                },
              ],
            },
          },
        ]),
      );
    });
    await waitFor(() => {
      expect(view.container.querySelector(".plugin-draft-paint")).toBeNull();
      expect(
        view.container.querySelector(".plugin-draft-paint-next")?.textContent,
      ).toBe("Decorate this draft");
    });
    expect(getPromptEditorElement()).toBe(editor);

    view.rerender(
      <PromptBoxInternal {...props} suppressPluginComposerCustomizations />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelector(".plugin-draft-paint-next"),
      ).toBeNull();
    });
    expect(getPromptEditorElement()).toBe(editor);
  });

  it("refreshes draft observers when the composer scope identity changes", async () => {
    const onDraftChange = vi.fn();
    setPluginSlotRegistrations(
      "scope-observer",
      pluginRegistrationSet([
        {
          id: "queued-message-observer",
          scopes: ["queued-message"],
          richText: { onDraftChange },
        },
      ]),
    );
    const draft = {
      ...emptyPromptDraftState(),
      text: "Unchanged draft",
    };
    const host = (queuedMessageId: string): PluginComposerHost => ({
      scope: {
        kind: "queued-message",
        threadId: "thread-1",
        queuedMessageId,
      },
      textEffectKey: `queued-message:${queuedMessageId}`,
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: vi.fn(),
      focus: vi.fn(),
    });
    const props = createPromptBoxProps({ value: draft.text });
    const rendered = render(
      <PluginComposerHostProvider value={host("message-1")}>
        <PromptBoxInternal {...props} />
      </PluginComposerHostProvider>,
    );

    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        { text: draft.text, mentions: [] },
        expect.objectContaining({
          scope: expect.objectContaining({ queuedMessageId: "message-1" }),
        }),
      );
    });
    onDraftChange.mockClear();

    rendered.rerender(
      <PluginComposerHostProvider value={host("message-2")}>
        <PromptBoxInternal {...props} />
      </PluginComposerHostProvider>,
    );

    await waitFor(() => {
      expect(onDraftChange).toHaveBeenCalledWith(
        { text: draft.text, mentions: [] },
        expect.objectContaining({
          scope: expect.objectContaining({ queuedMessageId: "message-2" }),
        }),
      );
    });
  });

  it.each([
    {
      label: "plain text",
      clipboard: { plainText: " — café\nnext" },
      expectedValue: "ask Alice — café\nnext",
    },
    {
      label: "structured blockquote",
      clipboard: {
        html: "<blockquote><p>quoted café</p></blockquote><p>after paste</p>",
        plainText: "> quoted café\n\nafter paste",
      },
      expectedValue: "ask Alice\n> quoted café\n\nafter paste",
    },
  ])(
    "preserves decorated serialization, mentions, and history through a real $label paste",
    async ({ clipboard, expectedValue }) => {
      setPluginSlotRegistrations(
        "clipboard-decoration",
        pluginRegistrationSet([
          {
            id: "paint",
            richText: {
              effects: [
                {
                  id: "whole-draft",
                  className: "clipboard-paste-decoration",
                  match: (text) => [{ from: 0, to: text.length }],
                },
              ],
            },
          },
        ]),
      );
      const initialValue = "ask Alice";
      const initialMentions: PromptTextMention[] = [
        {
          start: 4,
          end: 9,
          resource: {
            kind: "plugin",
            pluginId: "sample",
            icon: null,
            itemId: "people:alice",
            label: "Alice",
          },
        },
      ];
      const { changes, promptBoxRef } = renderPromptBox(initialValue, {
        initialMentionRanges: initialMentions,
      });

      await focusPromptEnd(promptBoxRef);
      await waitFor(() =>
        expect(
          document.querySelector(".clipboard-paste-decoration"),
        ).not.toBeNull(),
      );
      pasteClipboard(clipboard);

      await waitFor(() => expect(latestValue(changes)).toBe(expectedValue));
      expect(latestChange(changes)?.mentions).toEqual(initialMentions);
      expect(
        document.querySelector(".clipboard-paste-decoration"),
      ).not.toBeNull();

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await waitFor(() => expect(latestValue(changes)).toBe(initialValue));
      expect(latestChange(changes)?.mentions).toEqual(initialMentions);
      expect(
        document.querySelector(".clipboard-paste-decoration"),
      ).not.toBeNull();

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        shiftKey: true,
      });
      await waitFor(() => expect(latestValue(changes)).toBe(expectedValue));
      expect(latestChange(changes)?.mentions).toEqual(initialMentions);
      expect(
        document.querySelector(".clipboard-paste-decoration"),
      ).not.toBeNull();
    },
  );

  it("honors early focusEnd requests once the editor is ready", async () => {
    const restoreMatchMedia = mockPointerCoarse(false);
    try {
      render(<PromptBoxFocusOnMountHarness />);

      await waitForPromptFocus();
    } finally {
      restoreMatchMedia();
    }
  });

  it("skips passive autofocus on coarse pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      render(<PromptBoxInternal {...createPromptBoxProps()} />);

      await waitFor(() =>
        expect(getPromptEditorElement()).toBeInstanceOf(HTMLElement),
      );
      expect(document.activeElement).not.toBe(getPromptEditorElement());
    } finally {
      restoreMatchMedia();
    }
  });

  it("releases passive editor focus when autofocus becomes blocked", async () => {
    const restoreMatchMedia = mockPointerCoarse(false);
    try {
      const baseProps = createPromptBoxProps();
      const view = render(<PromptBoxInternal {...baseProps} />);

      await waitForPromptFocus();
      view.rerender(<PromptBoxInternal {...baseProps} autoFocus={false} />);

      await waitFor(() =>
        expect(document.activeElement).not.toBe(getPromptEditorElement()),
      );
    } finally {
      restoreMatchMedia();
    }
  });

  it("does not honor focus-end requests on coarse pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const promptBoxRef = createRef<PromptBoxHandle>();
      const baseProps = createPromptBoxProps({
        focusEndKey: 0,
        promptBoxRef,
      });
      const view = render(<PromptBoxInternal {...baseProps} />);

      await waitFor(() => expect(promptBoxRef.current).not.toBeNull());
      const outsideTarget = document.createElement("button");
      document.body.append(outsideTarget);
      outsideTarget.focus();

      view.rerender(<PromptBoxInternal {...baseProps} focusEndKey={1} />);
      promptBoxRef.current?.focusEnd();

      expect(document.activeElement).toBe(outsideTarget);
      outsideTarget.remove();
    } finally {
      restoreMatchMedia();
    }
  });

  it("inserts text without reopening the editor on coarse pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const onChange = vi.fn();
      const promptBoxRef = createRef<PromptBoxHandle>();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({ onChange, promptBoxRef })}
        />,
      );

      await waitFor(() => expect(promptBoxRef.current).not.toBeNull());
      const outsideTarget = document.createElement("button");
      document.body.append(outsideTarget);
      outsideTarget.focus();

      act(() => promptBoxRef.current?.insertTextAtCursor("transcript"));

      expect(onChange).toHaveBeenLastCalledWith("transcript", []);
      expect(document.activeElement).toBe(outsideTarget);
      outsideTarget.remove();
    } finally {
      restoreMatchMedia();
    }
  });

  it("blurs the editor before starting voice input on coarse pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const start = vi.fn();
      const promptBoxRef = createRef<PromptBoxHandle>();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            promptBoxRef,
            voice: {
              state: "idle",
              isSupported: true,
              stream: null,
              start,
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      await waitFor(() => expect(promptBoxRef.current).not.toBeNull());
      const editor = getPromptEditorElement();
      editor.focus();
      expect(document.activeElement).toBe(editor);

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" }),
      );

      expect(start).toHaveBeenCalledOnce();
      expect(document.activeElement).not.toBe(editor);
    } finally {
      restoreMatchMedia();
    }
  });

  it("refocuses when the history reset key changes on fine pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(false);
    try {
      const view = render(
        <PromptBoxHistoryAutoFocusHarness historyResetKey={0} />,
      );

      await waitForPromptFocus();
      const outsideTarget = screen.getByRole("button", {
        name: "Outside focus target",
      });
      outsideTarget.focus();
      expect(document.activeElement).toBe(outsideTarget);

      view.rerender(<PromptBoxHistoryAutoFocusHarness historyResetKey={1} />);

      await waitForPromptFocus();
    } finally {
      restoreMatchMedia();
    }
  });

  it("refocuses after another layout effect steals focus", async () => {
    const restoreMatchMedia = mockPointerCoarse(false);
    try {
      const view = render(
        <PromptBoxHistoryAutoFocusAfterLayoutStealHarness
          historyResetKey={0}
        />,
      );

      await waitForPromptFocus();

      view.rerender(
        <PromptBoxHistoryAutoFocusAfterLayoutStealHarness
          historyResetKey={1}
        />,
      );

      await waitForPromptFocus();
    } finally {
      restoreMatchMedia();
    }
  });

  it("does not refocus for history reset key changes on coarse pointers", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const view = render(
        <PromptBoxHistoryAutoFocusHarness historyResetKey={0} />,
      );

      await waitFor(() =>
        expect(getPromptEditorElement()).toBeInstanceOf(HTMLElement),
      );
      const outsideTarget = screen.getByRole("button", {
        name: "Outside focus target",
      });
      outsideTarget.focus();
      expect(document.activeElement).toBe(outsideTarget);

      view.rerender(<PromptBoxHistoryAutoFocusHarness historyResetKey={1} />);

      expect(document.activeElement).toBe(outsideTarget);
    } finally {
      restoreMatchMedia();
    }
  });

  it("applies an added quote before focus-end insertion can edit the old document", () => {
    const onChange = vi.fn();
    const view = render(<PromptBoxRaceHarness onChange={onChange} value="" />);

    view.rerender(
      <PromptBoxRaceHarness onChange={onChange} value={"> selected text\n"} />,
    );

    expect(onChange).toHaveBeenLastCalledWith("> selected text\n\nreply", []);
  });

  it("places focus-end insertion below an added quote", async () => {
    const onChange = vi.fn();
    const promptBoxRef = createRef<PromptBoxHandle>();
    const baseProps = createPromptBoxProps({
      onChange,
      promptBoxRef,
      value: "",
      focusEndKey: 0,
    });
    const view = render(<PromptBoxInternal {...baseProps} />);

    view.rerender(
      <PromptBoxInternal
        {...baseProps}
        value={"> selected text\n"}
        focusEndKey={1}
      />,
    );

    await waitForPromptFocus();
    await act(async () => {
      promptBoxRef.current?.insertTextAtCursor("reply");
    });

    expect(onChange).toHaveBeenLastCalledWith("> selected text\n\nreply", []);
  });
});

describe("PromptBoxInternal submit shortcuts", () => {
  it("exposes the disabled submit reason as its label and hover tooltip", async () => {
    const reason = "Loading models from the selected machine...";
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Investigate this",
          submission: { disabled: true, disabledReason: reason },
        })}
      />,
    );

    const submit = screen.getByRole("button", { name: reason });
    expect(submit.hasAttribute("disabled")).toBe(true);

    const tooltipTrigger = submit.closest(
      "[data-promptbox-submit-disabled-reason]",
    );
    expect(tooltipTrigger).not.toBeNull();
    fireEvent.pointerMove(tooltipTrigger!, { pointerType: "mouse" });

    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe(reason);
    });
  });

  it("continues to submit unmodified Enter on a fine-pointer device", () => {
    const restoreMatchMedia = mockPointerCoarse(false);
    try {
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Run this",
            onSubmit,
          })}
        />,
      );

      const wasNotCanceled = fireEvent.keyDown(getPromptEditorElement(), {
        key: "Enter",
      });

      expect(wasNotCanceled).toBe(false);
      expect(onSubmit).toHaveBeenCalledOnce();
    } finally {
      restoreMatchMedia();
    }
  });

  it("submits a Magic Keyboard Enter on coarse-pointer iPadOS WebKit", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Run this",
            onChange,
            onSubmit,
            blurOnPointerSubmit: true,
          })}
        />,
      );

      const editor = getPromptEditorElement();
      act(() => editor.focus());
      const wasNotCanceled = fireEvent.keyDown(editor, {
        key: "Enter",
        code: "Enter",
      });

      expect(wasNotCanceled).toBe(false);
      expect(editor.getAttribute("enterkeyhint")).toBe("enter");
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("keeps software-keyboard Enter as a newline on coarse-pointer iPadOS WebKit", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "First line",
            onChange,
            onSubmit,
          })}
        />,
      );

      const editor = getPromptEditorElement();
      fireEvent.keyDown(editor, { key: "Enter", code: "" });

      expect(editor.getAttribute("enterkeyhint")).toBe("enter");
      expect(onSubmit).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("First line\n", []),
      );
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("keeps software code=Enter as a newline on an Android coarse pointer", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockNavigatorIdentity({
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) " +
        "AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      vendor: "Google Inc.",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    try {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "First line",
            onChange,
            onSubmit,
          })}
        />,
      );

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "Enter",
        code: "Enter",
      });

      expect(onSubmit).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("First line\n", []),
      );
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("does not intercept code=Enter on a non-iPad coarse-pointer hybrid", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockNavigatorIdentity({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      vendor: "Google Inc.",
      platform: "Win32",
      maxTouchPoints: 10,
    });
    try {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "First line",
            onChange,
            onSubmit,
          })}
        />,
      );

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "Enter",
        code: "Enter",
      });

      expect(onSubmit).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("First line\n", []),
      );
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("keeps Magic Keyboard Shift+Enter as a newline on coarse-pointer iPadOS WebKit", async () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "First line",
            onChange,
            onSubmit,
          })}
        />,
      );

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
      });

      expect(onSubmit).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("First line\n", []),
      );
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("routes Magic Keyboard Command+Enter to modifier submit on coarse-pointer iPadOS WebKit", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onModifierSubmit = vi.fn();
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Follow up",
            onSubmit,
            submission: { onModifierSubmit },
            blurOnPointerSubmit: true,
          })}
        />,
      );

      const editor = getPromptEditorElement();
      act(() => editor.focus());
      fireEvent.keyDown(editor, {
        key: "Enter",
        code: "Enter",
        metaKey: true,
      });

      expect(onModifierSubmit).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(editor);
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("does not submit a hardware Enter that is committing IME composition", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Composing",
            onSubmit,
          })}
        />,
      );

      fireEvent.keyDown(getPromptEditorElement(), {
        key: "Enter",
        code: "Enter",
        isComposing: true,
      });

      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("does not submit the Enter keydown immediately following compositionend", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Composed candidate",
            onSubmit,
          })}
        />,
      );

      const editor = getPromptEditorElement();
      fireEvent.compositionStart(editor, { data: "候補" });
      fireEvent.compositionEnd(editor, { data: "候補" });
      fireEvent.keyDown(editor, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
      });

      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });

  it("still submits a hardware Enter after a compositionend outside a composition", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    const restoreNavigator = mockIPadOSWebKit();
    try {
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Run this",
            onSubmit,
          })}
        />,
      );

      const editor = getPromptEditorElement();
      fireEvent.compositionEnd(editor, { data: "候補" });
      fireEvent.keyDown(editor, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
      });

      expect(onSubmit).toHaveBeenCalledOnce();
    } finally {
      restoreNavigator();
      restoreMatchMedia();
    }
  });
});

describe("PromptBoxInternal escape", () => {
  it("blurs the editor when no host Escape action is provided", async () => {
    const promptBoxRef = createRef<PromptBoxHandle>();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({ value: "Follow-up message" })}
        promptBoxRef={promptBoxRef}
      />,
    );
    await focusPromptEnd(promptBoxRef);
    const editor = getPromptEditorElement();

    const wasNotCanceled = fireEvent.keyDown(editor, { key: "Escape" });

    expect(wasNotCanceled).toBe(false);
    expect(document.activeElement).not.toBe(editor);
  });

  it("routes Escape to onEscape instead of blurring the editor", async () => {
    const onEscape = vi.fn();
    const promptBoxRef = createRef<PromptBoxHandle>();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({ onEscape, value: "Edited message" })}
        promptBoxRef={promptBoxRef}
      />,
    );
    await focusPromptEnd(promptBoxRef);

    const wasNotCanceled = fireEvent.keyDown(getPromptEditorElement(), {
      key: "Escape",
    });

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(wasNotCanceled).toBe(false);
    expect(document.activeElement).toBe(getPromptEditorElement());
  });

  it("dismisses an open typeahead before Escape reaches onEscape", async () => {
    const onEscape = vi.fn();
    const promptBoxRef = createRef<PromptBoxHandle>();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          onEscape,
          value: "/re",
          typeahead: buildTypeaheadConfig({
            commandSuggestions: [
              {
                kind: "command",
                name: "review",
                source: "command",
                origin: "user",
                description: null,
                argumentHint: null,
              },
            ],
          }),
        })}
        promptBoxRef={promptBoxRef}
      />,
    );
    await focusPromptEnd(promptBoxRef);
    await screen.findByRole("button", { name: "review" });

    fireEvent.keyDown(getPromptEditorElement(), { key: "Escape" });

    expect(onEscape).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "review" })).toBeNull(),
    );

    fireEvent.keyDown(getPromptEditorElement(), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe("PromptBoxInternal size controls", () => {
  it.each([
    ["thread", "calc(50dvh - 3rem)"],
    ["root-compose", "calc(70dvh - 3rem)"],
  ] as const)(
    "caps the %s editor at its intended viewport height",
    (layout, maxHeight) => {
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({ editorLayout: layout })}
        />,
      );

      const editorScroll = document.querySelector<HTMLElement>(
        "[data-promptbox-editor-scroll]",
      );
      expect(editorScroll?.style.maxHeight).toBe(maxHeight);
    },
  );

  it("offers only the collapse action and releases editor focus", async () => {
    const onCollapse = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          onCollapse,
        })}
      />,
    );
    await waitForPromptFocus();

    expect(
      screen.queryByRole("button", { name: /Make prompt box/u }),
    ).toBeNull();
    const collapseButton = screen.getByRole("button", {
      name: "Collapse prompt box",
    });
    expect(collapseButton.classList).toContain("text-subtle-foreground/75");
    expect(collapseButton.classList).toContain("w-6");
    expect(collapseButton.classList).toContain("px-0");
    expect(collapseButton.parentElement?.classList).toContain("right-[13px]");
    expect(
      collapseButton.querySelector('[data-icon="ChevronDown"]')?.classList,
    ).toContain("size-3.5");
    fireEvent.click(collapseButton);

    expect(onCollapse).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(getPromptEditorElement());
  });
});

describe("PromptBoxInternal plugin composer actions", () => {
  it("mounts scope-matched actions in deterministic order before voice", () => {
    setPluginSlotRegistrations(
      "zeta",
      pluginRegistrationSet([
        {
          id: "tools",
          actions: [
            { id: "zeta", component: () => <button>Zeta action</button> },
          ],
        },
      ]),
    );
    setPluginSlotRegistrations(
      "alpha",
      pluginRegistrationSet([
        {
          id: "tools",
          scopes: ["new-thread"],
          actions: [
            { id: "first", component: () => <button>Alpha first</button> },
            { id: "second", component: () => <button>Alpha second</button> },
          ],
        },
        {
          id: "thread-only",
          scopes: ["thread"],
          actions: [
            { id: "hidden", component: () => <button>Hidden action</button> },
          ],
        },
      ]),
    );

    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          voice: {
            state: "idle",
            isSupported: true,
            stream: null,
            start: vi.fn(),
            stop: vi.fn(),
            cancel: vi.fn(),
          },
        })}
      />,
    );

    expect(
      Array.from(
        document.querySelectorAll("[data-plugin-composer-action] button"),
        (element) => element.textContent,
      ),
    ).toEqual(["Alpha first", "Alpha second", "Zeta action"]);
    expect(screen.queryByRole("button", { name: "Hidden action" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Zeta action" })
        .compareDocumentPosition(
          screen.getByRole("button", { name: "Start voice input" }),
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("releases composer visual state acquired by an action that crashes before passive effects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    function Crashes(): never {
      const composer = useComposer();
      composer.setInputLock(true);
      composer.setTextEffect({ className: "crashed-action-effect" });
      throw new Error("action crashed");
    }
    setPluginSlotRegistrations(
      "actions",
      pluginRegistrationSet([
        {
          id: "tools",
          actions: [
            { id: "broken", component: Crashes },
            { id: "fine", component: () => <button>Still available</button> },
          ],
        },
      ]),
    );

    const draft = emptyPromptDraftState();
    const host: PluginComposerHost = {
      scope: { kind: "thread", threadId: "crashing-action-thread" },
      textEffectKey: "crashing-action-composer",
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: vi.fn(),
      focus: vi.fn(),
    };
    function Harness() {
      const textEffects = useComposerTextEffects(host.textEffectKey);
      return (
        <MemoryRouter>
          <PluginComposerHostProvider value={host}>
            <PromptBoxInternal
              {...createPromptBoxProps({ value: "Native draft" })}
              textEffects={textEffects}
            />
          </PluginComposerHostProvider>
        </MemoryRouter>
      );
    }

    render(<Harness />);

    expect(
      screen.getByRole("button", { name: "Still available" }),
    ).toBeTruthy();
    expect(screen.queryByText(/plugin actions crashed/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Submit (Enter)" })).toBeTruthy();
    await waitFor(() => {
      expect(getPromptEditorElement().getAttribute("contenteditable")).toBe(
        "true",
      );
      expect(
        document
          .querySelector("[data-promptbox-editor-scroll]")
          ?.hasAttribute("aria-busy"),
      ).toBe(false);
    });
    expect(document.querySelector(".crashed-action-effect")).toBeNull();
    expect(getComposerInputLock(host.textEffectKey)).toBe(false);
    expect(getComposerTextEffects(host.textEffectKey)).toEqual([]);
    expect(getPluginThreadRowStatus("crashing-action-thread")).toBeNull();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("makes the editor read-only while locked and restores it on unlock", async () => {
    function LockAction() {
      const composer = useComposer();
      const view = useComposerView();
      const [locked, setLocked] = useState(false);
      return (
        <button
          type="button"
          onClick={() => {
            composer.setInputLock(!locked);
            setLocked(!locked);
          }}
        >
          Toggle lock ({view.scope.kind})
        </button>
      );
    }
    setPluginSlotRegistrations(
      "locker",
      pluginRegistrationSet([
        {
          id: "tools",
          scopes: ["thread"],
          actions: [{ id: "lock", component: LockAction }],
          plusMenu: [
            { id: "thread-menu", label: "Thread tool", run: () => {} },
          ],
          richText: {
            effects: [
              {
                id: "thread-rule",
                className: "thread-rule",
                match: (text) => [{ from: 0, to: text.length }],
              },
            ],
          },
        },
      ]),
    );
    const draft = emptyPromptDraftState();
    const host: PluginComposerHost = {
      scope: { kind: "thread", threadId: "thread-1" },
      textEffectKey: "promptbox-lock-test",
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: vi.fn(),
      focus: vi.fn(),
    };
    render(
      <MemoryRouter>
        <PluginComposerHostProvider value={host}>
          <PromptBoxInternal
            {...createPromptBoxProps({ value: "Thread draft" })}
          />
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );
    const editor = getPromptEditorElement();
    expect(editor.getAttribute("contenteditable")).toBe("true");

    expect(
      screen.getByRole("button", { name: "Toggle lock (thread)" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prompt actions" })).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector(".thread-rule")?.textContent).toBe(
        "Thread draft",
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle lock (thread)" }),
    );
    await waitFor(() => {
      expect(editor.getAttribute("contenteditable")).toBe("false");
      expect(
        document
          .querySelector("[data-promptbox-editor-scroll]")
          ?.getAttribute("aria-busy"),
      ).toBe("true");
    });
    expect(screen.getByRole("button", { name: "Submit (Enter)" })).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle lock (thread)" }),
    );
    await waitFor(() => {
      expect(editor.getAttribute("contenteditable")).toBe("true");
      expect(
        document
          .querySelector("[data-promptbox-editor-scroll]")
          ?.hasAttribute("aria-busy"),
      ).toBe(false);
    });
  });

  it("remounts scoped actions and releases owned state when scope identity changes", () => {
    const mounted = vi.fn();
    const cleaned = vi.fn();
    const staleWrite = vi.fn();
    const completions: Array<() => void> = [];
    function ScopedAction() {
      const composer = useComposer();
      const view = useComposerView();
      useLayoutEffect(() => {
        mounted(view.scope);
        composer.setInputLock(true);
        composer.setTextEffect({ className: "scoped-effect" });
        let active = true;
        completions.push(() => {
          if (active) staleWrite();
        });
        return () => {
          active = false;
          cleaned(view.scope);
        };
      }, [composer, view.scope]);
      return <button>{view.scope.kind}</button>;
    }
    setPluginSlotRegistrations(
      "scope-action",
      pluginRegistrationSet([
        {
          id: "scope",
          actions: [{ id: "probe", component: ScopedAction }],
        },
      ]),
    );
    const draft = emptyPromptDraftState();
    const host = (threadId: string): PluginComposerHost => ({
      scope: { kind: "thread", threadId },
      textEffectKey: `scope-action:${threadId}`,
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: vi.fn(),
      focus: vi.fn(),
    });
    const firstHost = host("one");
    const secondHost = host("two");
    const props = createPromptBoxProps({ value: "Scoped draft" });
    const rendered = render(
      <MemoryRouter>
        <PluginComposerHostProvider value={firstHost}>
          <PromptBoxInternal {...props} />
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(getComposerInputLock(firstHost.textEffectKey)).toBe(true);
    expect(getComposerTextEffects(firstHost.textEffectKey)).toHaveLength(1);

    rendered.rerender(
      <MemoryRouter>
        <PluginComposerHostProvider value={secondHost}>
          <PromptBoxInternal {...props} />
        </PluginComposerHostProvider>
      </MemoryRouter>,
    );
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(getComposerInputLock(firstHost.textEffectKey)).toBe(false);
    expect(getComposerTextEffects(firstHost.textEffectKey)).toEqual([]);
    expect(getComposerInputLock(secondHost.textEffectKey)).toBe(true);

    completions[0]?.();
    expect(staleWrite).not.toHaveBeenCalled();
  });

  it("does not mount plugin actions in compact layout", () => {
    setPluginSlotRegistrations(
      "compact",
      pluginRegistrationSet([
        {
          id: "tools",
          actions: [
            { id: "hidden", component: () => <button>Plugin action</button> },
          ],
        },
      ]),
    );
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({ compact: { isCompact: true } })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Plugin action" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit (Enter)" })).toBeTruthy();
  });
});

describe("PromptBoxInternal compact layout", () => {
  it("shows attachment upload progress on the submit button", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            attachments: { isAttaching: true },
            compact: {
              isCompact: true,
              placeholder: "Ask a follow-up",
            },
            voice: {
              state: "idle",
              isSupported: true,
              stream: null,
              start: vi.fn(),
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      const submit = screen.getByRole("button", {
        name: "Uploading attachments...",
      });
      expect(submit.hasAttribute("disabled")).toBe(true);
      expect(submit.querySelector('[data-icon="Spinner"]')).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: "Start voice input" }),
      ).toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });

  it("publishes the container-compact placeholder for CSS", () => {
    const baseProps = createPromptBoxProps();
    const view = render(
      <PromptBoxInternal
        {...baseProps}
        containerCompactPlaceholder="Reconnecting..."
      />,
    );
    const form = document.querySelector("[data-promptbox]");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Prompt box form was not rendered");
    }

    expect(
      form.style.getPropertyValue("--promptbox-container-compact-placeholder"),
    ).toBe('"Reconnecting..."');

    view.rerender(<PromptBoxInternal {...baseProps} />);
    expect(
      form.style.getPropertyValue("--promptbox-container-compact-placeholder"),
    ).toBe("");
  });

  it("animates between compact and full layouts", async () => {
    const promptBoxRef = createRef<PromptBoxHandle>();
    const baseProps = createPromptBoxProps({ promptBoxRef });
    const view = render(
      <PromptBoxInternal
        {...baseProps}
        compact={{ isCompact: true, placeholder: "Ask a follow-up" }}
      />,
    );
    const form = document.querySelector("[data-promptbox]");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Prompt box form was not rendered");
    }
    vi.spyOn(form, "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 0, 320, 48))
      .mockReturnValueOnce(new DOMRect(0, 0, 320, 144))
      .mockReturnValue(new DOMRect(0, 0, 320, 144));

    act(() => promptBoxRef.current?.captureHeightForLayoutChange());
    view.rerender(
      <PromptBoxInternal
        {...baseProps}
        compact={{ isCompact: false, placeholder: "Ask a follow-up" }}
      />,
    );

    await waitFor(() => {
      expect(form.style.transition).toContain("height 240ms");
      expect(form.style.height).toBe("144px");
      expect(form.style.overflow).toBe("hidden");
    });
    fireEvent.transitionEnd(form, { propertyName: "height" });
    expect(form.style.overflow).toBe("");
  });

  it("animates an externally driven layout change", async () => {
    const promptBoxRef = createRef<PromptBoxHandle>();
    const baseProps = createPromptBoxProps({ promptBoxRef });
    const view = render(
      <PromptBoxInternal {...baseProps} heightAnimationKey="compact" />,
    );
    const form = document.querySelector("[data-promptbox]");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Prompt box form was not rendered");
    }
    vi.spyOn(form, "getBoundingClientRect")
      .mockReturnValueOnce(new DOMRect(0, 0, 320, 48))
      .mockReturnValueOnce(new DOMRect(0, 0, 320, 144))
      .mockReturnValue(new DOMRect(0, 0, 320, 144));

    act(() => promptBoxRef.current?.captureHeightForLayoutChange());
    view.rerender(
      <PromptBoxInternal {...baseProps} heightAnimationKey="expanded" />,
    );

    await waitFor(() => {
      expect(form.style.transition).toContain("height 240ms");
      expect(form.style.height).toBe("144px");
    });
    fireEvent.transitionEnd(form, { propertyName: "height" });
  });

  it("skips an external layout animation when the height did not change", () => {
    const promptBoxRef = createRef<PromptBoxHandle>();
    const baseProps = createPromptBoxProps({ promptBoxRef });
    const view = render(
      <PromptBoxInternal {...baseProps} heightAnimationKey="compact" />,
    );
    const form = document.querySelector("[data-promptbox]");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Prompt box form was not rendered");
    }
    vi.spyOn(form, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 144),
    );

    act(() => promptBoxRef.current?.captureHeightForLayoutChange());
    view.rerender(
      <PromptBoxInternal {...baseProps} heightAnimationKey="expanded" />,
    );

    expect(form.style.transition).toBe("");
    expect(form.style.height).toBe("");
  });

  it("keeps only the one-line editor and primary action", () => {
    const voice: PromptVoiceConfig = {
      state: "idle",
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };

    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value:
            "A compact follow-up that is much wider than the available mobile space\nA hidden second line",
          attachments: { onAttachFiles: vi.fn() },
          footerStart: <button type="button">Model selector</button>,
          compact: {
            isCompact: true,
            placeholder: "Ask a follow-up",
          },
          promptActions,
          voice,
        })}
      />,
    );

    const form = document.querySelector("[data-promptbox]");
    expect(form?.getAttribute("data-promptbox-compact")).toBe("");
    expect(screen.getByRole("button", { name: "Submit (Enter)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Prompt actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Model selector" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start voice input" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Make prompt box/u }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Collapse prompt box" }),
    ).toBeNull();
    expect(getPromptEditorElement().getAttribute("data-placeholder")).toBe(
      "Ask a follow-up",
    );
    const compactContent = document.querySelector(
      "[data-promptbox-compact-content]",
    );
    expect(compactContent).toBeTruthy();
  });

  it("uses voice as the primary action for an empty coarse-pointer prompt", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const start = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            compact: {
              isCompact: true,
              placeholder: "Ask a follow-up",
            },
            voice: {
              state: "idle",
              isSupported: true,
              stream: null,
              start,
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      const voiceButton = screen.getByRole("button", {
        name: "Start voice input",
      });
      const submitGroup = document.querySelector(
        "[data-promptbox-submit-group]",
      );
      expect(submitGroup?.contains(voiceButton)).toBe(true);
      expect(
        screen.queryByRole("button", { name: "Submit (Enter)" }),
      ).toBeNull();

      expect(
        fireEvent.pointerDown(voiceButton, {
          button: 0,
          pointerType: "touch",
        }),
      ).toBe(false);
      fireEvent.click(voiceButton);

      expect(start).toHaveBeenCalledOnce();
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps an unfocused compact submit stable on coarse pointers", () => {
    const restoreMatchMedia = mockPointerCoarse(true);
    try {
      const onSubmit = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Transcript ready to send",
            onSubmit,
            compact: {
              isCompact: true,
              placeholder: "Ask a follow-up",
            },
          })}
        />,
      );

      expect(document.activeElement).not.toBe(getPromptEditorElement());
      const submit = screen.getByRole("button", { name: "Submit (Enter)" });
      expect(
        fireEvent.pointerDown(submit, {
          button: 0,
          pointerType: "touch",
        }),
      ).toBe(false);
      fireEvent.click(submit, { detail: 1 });
      expect(onSubmit).toHaveBeenCalledOnce();
    } finally {
      restoreMatchMedia();
    }
  });

  it("keeps the editor focused through a pointer submit", async () => {
    const onSubmit = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Send this follow-up",
          onSubmit,
          compact: {
            isCompact: true,
            placeholder: "Ask a follow-up",
          },
        })}
      />,
    );

    await waitForPromptFocus();
    const editor = getPromptEditorElement();
    const submit = screen.getByRole("button", { name: "Submit (Enter)" });

    expect(
      fireEvent.pointerDown(submit, { button: 0, pointerType: "touch" }),
    ).toBe(false);
    expect(document.activeElement).toBe(editor);

    fireEvent.click(submit, { detail: 1 });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(editor);
  });

  it("keeps DOM focus through submit when TipTap focus state is stale", async () => {
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({ value: "Send this follow-up" })}
      />,
    );

    await waitForPromptFocus();
    const editor = getPromptEditorElement();
    const submit = screen.getByRole("button", { name: "Submit (Enter)" });

    editor.dispatchEvent(new FocusEvent("blur"));
    expect(document.activeElement).toBe(editor);

    expect(
      fireEvent.pointerDown(submit, { button: 0, pointerType: "touch" }),
    ).toBe(false);
    expect(document.activeElement).toBe(editor);
  });

  it("blurs the editor after a pointer submit when requested", async () => {
    const onSubmit = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Send this follow-up",
          onSubmit,
          blurOnPointerSubmit: true,
          compact: {
            isCompact: true,
            placeholder: "Ask a follow-up",
          },
        })}
      />,
    );

    await waitForPromptFocus();
    const editor = getPromptEditorElement();
    const submit = screen.getByRole("button", { name: "Submit (Enter)" });

    expect(
      fireEvent.pointerDown(submit, { button: 0, pointerType: "touch" }),
    ).toBe(false);
    expect(document.activeElement).toBe(editor);

    fireEvent.click(submit, { detail: 1 });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(editor);
  });

  it("keeps all Markdown and mention text in the navigable preview", async () => {
    const mentionToken =
      "@apps/app/src/components/promptbox/PromptBoxInternal.tsx";
    const value = [
      `> Review ${mentionToken} with the rest of this long quoted request`,
      "> Then verify the hidden continuation",
      "A hidden paragraph after the quote",
    ].join("\n");
    const mentionStart = value.indexOf(mentionToken);

    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value,
          mentionRanges: [
            {
              start: mentionStart,
              end: mentionStart + mentionToken.length,
              resource: {
                kind: "path",
                source: "workspace",
                entryKind: "file",
                path: "apps/app/src/components/promptbox/PromptBoxInternal.tsx",
                label: "PromptBoxInternal.tsx",
              },
            },
          ],
          compact: {
            isCompact: true,
            placeholder: "Ask a follow-up",
          },
        })}
      />,
    );

    const compactContent = document.querySelector(
      "[data-promptbox-compact-content]",
    );
    const editor = getPromptEditorElement();
    expect(compactContent?.contains(editor)).toBe(true);
    expect(editor.firstElementChild?.tagName).toBe("BLOCKQUOTE");
    await waitFor(() =>
      expect(editor.querySelector(".prompt-mention-pill")).toBeTruthy(),
    );
    expect(editor.querySelector("br")).toBeTruthy();
    expect(editor.children.length).toBeGreaterThan(1);
    expect(editor.textContent).toContain("A hidden paragraph after the quote");
  });

  it("anchors only the primary action during a container-driven reveal", () => {
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          voice: {
            state: "idle",
            isSupported: true,
            stream: null,
            start: vi.fn(),
            stop: vi.fn(),
            cancel: vi.fn(),
          },
        })}
      />,
    );

    const submitGroup = document.querySelector("[data-promptbox-submit-group]");
    const submit = screen.getByRole("button", { name: "Submit (Enter)" });
    const voice = screen.getByRole("button", { name: "Start voice input" });

    expect(submitGroup?.contains(submit)).toBe(true);
    expect(submitGroup?.contains(voice)).toBe(false);
  });

  it("keeps the existing prompt content when voice recording activates", () => {
    const onChange = vi.fn();
    const voice = {
      state: "idle" as const,
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const view = render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Keep this prompt visible while I dictate",
          onChange,
          voice,
        })}
      />,
    );

    const editor = getPromptEditorElement();
    expect(editor.textContent).toBe("Keep this prompt visible while I dictate");

    view.rerender(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Keep this prompt visible while I dictate",
          onChange,
          voice: { ...voice, state: "recording" },
        })}
      />,
    );

    expect(getPromptEditorElement()).toBe(editor);
    expect(editor.textContent).toBe("Keep this prompt visible while I dictate");
    expect(
      onChange.mock.calls.every(
        ([nextValue]) =>
          nextValue === "Keep this prompt visible while I dictate",
      ),
    ).toBe(true);
  });

  it.each(["recording", "transcribing"] as const)(
    "keeps the visible draft keyboard-read-only and standard controls inert while %s",
    async (state) => {
      const onChange = vi.fn();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "Keep this prompt unchanged",
            onChange,
            voice: {
              state,
              isSupported: true,
              stream: null,
              start: vi.fn(),
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      const editor = getPromptEditorElement();
      await waitFor(() =>
        expect(editor.getAttribute("contenteditable")).toBe("false"),
      );
      expect(editor.getAttribute("tabindex")).toBe("-1");
      expect(editor.getAttribute("aria-readonly")).toBe("true");
      expect(screen.getByRole("textbox")).toBe(editor);
      onChange.mockClear();
      editor.focus();
      fireEvent.keyDown(editor, { key: "x", code: "KeyX" });

      expect(editor.textContent).toBe("Keep this prompt unchanged");
      expect(onChange).not.toHaveBeenCalled();
      expect(
        document
          .querySelector("[data-promptbox-input-region]")
          ?.hasAttribute("inert"),
      ).toBe(false);
      for (const controls of document.querySelectorAll(
        "[data-promptbox-standard-actions]",
      )) {
        expect(controls.hasAttribute("inert")).toBe(true);
      }
      expect(
        document
          .querySelector("[data-promptbox-voice-controls]")
          ?.hasAttribute("inert"),
      ).toBe(false);
    },
  );

  it("keeps the prompt editor visible while the waveform occupies the action row", () => {
    const stop = vi.fn();
    const cancel = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          value: "Keep this prompt visible while I dictate",
          voice: {
            state: "recording",
            isSupported: true,
            stream: null,
            start: vi.fn(),
            stop,
            cancel,
          },
        })}
      />,
    );

    const main = document.querySelector("[data-promptbox-main]");
    const layout = document.querySelector<HTMLElement>(
      "[data-promptbox-layout]",
    );
    const actionRow = document.querySelector("[data-promptbox-action-row]");
    const waveform = document.querySelector("canvas[aria-hidden]");

    expect(main?.classList.contains("opacity-0")).toBe(false);
    expect(main?.classList.contains("pointer-events-none")).toBe(true);
    expect(layout?.style.gridTemplateRows).toBe("1fr");
    expect(getPromptEditorElement().textContent).toBe(
      "Keep this prompt visible while I dictate",
    );
    expect(waveform).toBeTruthy();
    expect(actionRow?.contains(waveform)).toBe(true);
    const confirm = screen.getByRole("button", {
      name: "Stop and transcribe recording",
    });
    const cancelButton = screen.getByRole("button", {
      name: "Cancel recording",
    });
    const voiceControls = document.querySelector(
      "[data-promptbox-voice-controls]",
    );
    expect(voiceControls?.classList.contains("pointer-events-auto")).toBe(true);
    expect(voiceControls?.contains(confirm)).toBe(true);
    expect(voiceControls?.contains(cancelButton)).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(cancelButton);
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps newly mounted voice controls entering until the reveal frame", () => {
    let nextFrameId = 1;
    const pendingFrames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const frameId = nextFrameId++;
        pendingFrames.set(frameId, callback);
        return frameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((frameId) => {
        pendingFrames.delete(frameId);
      });
    try {
      const idleVoice: PromptVoiceConfig = {
        state: "idle",
        isSupported: true,
        stream: null,
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
      };
      const view = render(
        <PromptBoxInternal {...createPromptBoxProps({ voice: idleVoice })} />,
      );

      view.rerender(
        <PromptBoxInternal
          {...createPromptBoxProps({
            voice: { ...idleVoice, state: "recording" },
          })}
        />,
      );

      const voiceControls = document.querySelector<HTMLElement>(
        "[data-promptbox-voice-controls]",
      );
      expect(voiceControls?.dataset.voiceTransition).toBe("entering");
      expect(voiceControls?.hasAttribute("inert")).toBe(true);

      act(() => {
        const callbacks = Array.from(pendingFrames.values());
        pendingFrames.clear();
        for (const callback of callbacks) callback(0);
      });

      expect(voiceControls?.dataset.voiceTransition).toBe("active");
      expect(voiceControls?.hasAttribute("inert")).toBe(false);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("finishes the voice exit transition before a ready transcript can be inserted", async () => {
    vi.useFakeTimers();
    try {
      const promptBoxRef = createRef<PromptBoxHandle>();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            promptBoxRef,
            value: "Existing draft",
            voice: {
              state: "transcribing",
              isSupported: true,
              stream: null,
              start: vi.fn(),
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      let transitionFinished = false;
      let transition: Promise<void> | undefined;
      act(() => {
        transition = promptBoxRef.current?.playVoiceCompletionTransition();
        void transition?.then(() => {
          transitionFinished = true;
        });
      });

      expect(
        document
          .querySelector("[data-promptbox-voice-controls]")
          ?.getAttribute("data-voice-transition"),
      ).toBe("exiting");

      const voiceControls = document.querySelector<HTMLElement>(
        "[data-promptbox-voice-controls]",
      );
      expect(voiceControls?.hasAttribute("inert")).toBe(true);
      expect(voiceControls?.getAttribute("aria-hidden")).toBe("true");
      expect(
        voiceControls?.querySelector('[aria-label="Cancel transcription"]'),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Cancel transcription" }),
      ).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(179);
      });
      expect(transitionFinished).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await transition;
      });
      expect(transitionFinished).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels immediately while retaining the voice bar for its exit transition", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const recordingVoice: PromptVoiceConfig = {
        state: "recording",
        isSupported: true,
        stream: null,
        start: vi.fn(),
        stop: vi.fn(),
        cancel,
      };
      const view = render(
        <PromptBoxInternal
          {...createPromptBoxProps({ voice: recordingVoice })}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
      expect(cancel).toHaveBeenCalledOnce();

      view.rerender(
        <PromptBoxInternal
          {...createPromptBoxProps({
            voice: { ...recordingVoice, state: "idle" },
          })}
        />,
      );
      expect(
        document
          .querySelector("[data-promptbox-voice-controls]")
          ?.getAttribute("data-voice-transition"),
      ).toBe("exiting");
      const voiceControls = document.querySelector<HTMLElement>(
        "[data-promptbox-voice-controls]",
      );
      expect(voiceControls?.hasAttribute("inert")).toBe(true);
      expect(voiceControls?.getAttribute("aria-hidden")).toBe("true");
      expect(
        voiceControls?.querySelector('[aria-label="Cancel recording"]'),
      ).toBeTruthy();
      expect(
        voiceControls?.querySelector('[aria-label="Cancel transcription"]'),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Cancel recording" }),
      ).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(180);
      });
      expect(
        document.querySelector("[data-promptbox-voice-controls]"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay transcript insertion while the document is hidden", async () => {
    const originalVisibilityState = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    try {
      const promptBoxRef = createRef<PromptBoxHandle>();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            promptBoxRef,
            voice: {
              state: "transcribing",
              isSupported: true,
              stream: null,
              start: vi.fn(),
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      await expect(
        promptBoxRef.current?.playVoiceCompletionTransition(),
      ).resolves.toBeUndefined();
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(
          document,
          "visibilityState",
          originalVisibilityState,
        );
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
    }
  });

  it("does not delay transcript insertion for reduced motion", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
    try {
      const promptBoxRef = createRef<PromptBoxHandle>();
      render(
        <PromptBoxInternal
          {...createPromptBoxProps({
            promptBoxRef,
            voice: {
              state: "transcribing",
              isSupported: true,
              stream: null,
              start: vi.fn(),
              stop: vi.fn(),
              cancel: vi.fn(),
            },
          })}
        />,
      );

      await expect(
        promptBoxRef.current?.playVoiceCompletionTransition(),
      ).resolves.toBeUndefined();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("does not expose size controls in the full mobile layout", () => {
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          attachments: { onAttachFiles: vi.fn() },
          compact: { isCompact: false },
          promptActions,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Make prompt box/u }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Prompt actions" })).toBeTruthy();
  });
});

describe("PromptBoxInternal mention triggers", () => {
  const githubIssueSuggestion: PromptMentionSuggestion = {
    kind: "plugin",
    pluginId: "github",
    providerId: "issue",
    itemId: "issue:owner/repo#42",
    providerLabel: "GitHub issues",
    title: "#42 Fix login bug",
    subtitle: "owner/repo",
    icon: null,
    replacement: "#42 Fix login bug",
  };

  it("applies the first result with Enter for a multiword mention query", async () => {
    const { changes, onMentionQueryChange, onSubmit, promptBoxRef } =
      renderPromptBox("Ask @fix login", {
        mentionSuggestions: [githubIssueSuggestion],
      });

    await focusPromptEnd(promptBoxRef);
    await waitFor(() =>
      expect(onMentionQueryChange).toHaveBeenCalledWith("fix login", "@"),
    );
    await screen.findByRole("button", { name: /Fix login bug/u });

    fireEvent.keyDown(getPromptEditorElement(), { key: "Enter" });

    await waitFor(() =>
      expect(latestValue(changes)).toBe("Ask @#42 Fix login bug "),
    );
    expect(latestChange(changes)?.mentions).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps a dismissed multiword occurrence closed as its query extends", async () => {
    const { changes, promptBoxRef } = renderPromptBox("@asdf qwe", {
      mentionSuggestions: [githubIssueSuggestion],
    });
    await focusPromptEnd(promptBoxRef);
    await screen.findByRole("button", { name: /Fix login bug/u });

    fireEvent.keyDown(getPromptEditorElement(), { key: "Escape" });
    await act(async () => promptBoxRef.current?.insertTextAtCursor("rt"));

    await waitFor(() => expect(latestValue(changes)).toBe("@asdf qwe rt"));
    expect(screen.queryByRole("button", { name: /Fix login bug/u })).toBeNull();
  });

  it("dismisses a coarse-pointer occurrence from a 44px close target", async () => {
    const restorePointer = mockPointerCoarse(true);
    try {
      const { onMentionQueryChange } = renderPromptBox("@fix", {
        mentionSuggestions: [githubIssueSuggestion],
      });

      const closeButton = await screen.findByRole("button", {
        name: "Close suggestions",
      });
      expect(closeButton.classList).toContain("size-11");
      expect(closeButton.parentElement?.classList).toContain("h-11");
      expect(closeButton.parentElement?.classList).not.toContain("absolute");

      fireEvent.click(closeButton);

      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Fix login bug/u }),
        ).toBeNull(),
      );
      expect(getPromptEditorElement().textContent).toBe("@fix");
      expect(onMentionQueryChange).toHaveBeenLastCalledWith(null, null);
    } finally {
      restorePointer();
    }
  });

  it("reopens after a touch-dismissed occurrence is removed and retyped", async () => {
    const restorePointer = mockPointerCoarse(true);
    const promptBoxRef = createRef<PromptBoxHandle>();

    function RetriggerHarness() {
      const [value, setValue] = useState("@fix");
      return (
        <>
          <button type="button" onClick={() => setValue("")}>
            Remove occurrence
          </button>
          <button type="button" onClick={() => setValue("@fix")}>
            Retype occurrence
          </button>
          <PromptBoxInternal
            {...createPromptBoxProps({
              value,
              onChange: (nextValue) => setValue(nextValue),
              typeahead: buildTypeaheadConfig({
                mentionSuggestions: [githubIssueSuggestion],
              }),
            })}
            promptBoxRef={promptBoxRef}
          />
        </>
      );
    }

    try {
      render(<RetriggerHarness />);
      await screen.findByRole("button", { name: /Fix login bug/u });
      fireEvent.click(
        screen.getByRole("button", { name: "Close suggestions" }),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Remove occurrence" }),
      );
      await waitFor(() =>
        expect(getPromptEditorElement().textContent).toBe(""),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Retype occurrence" }),
      );

      await screen.findByRole("button", { name: /Fix login bug/u });
    } finally {
      restorePointer();
    }
  });

  it("reports the queued editor typeahead's open state and measured height", async () => {
    const layouts: Array<{ height: number; isOpen: boolean }> = [];
    const nativeGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute("data-promptbox-typeahead-menu")) {
          return new DOMRect(0, 0, 600, 144);
        }
        return nativeGetBoundingClientRect.call(this);
      });
    const promptBoxRef = createRef<PromptBoxHandle>();

    render(
      <QueuedEditorTypeaheadLayoutContext.Provider
        value={(layout) => layouts.push(layout)}
      >
        <PromptBoxInternal
          {...createPromptBoxProps({
            value: "@fix",
            typeahead: buildTypeaheadConfig({
              mentionSuggestions: [githubIssueSuggestion],
            }),
          })}
          promptBoxRef={promptBoxRef}
        />
      </QueuedEditorTypeaheadLayoutContext.Provider>,
    );

    await focusPromptEnd(promptBoxRef);
    await waitFor(() =>
      expect(layouts).toContainEqual({ height: 144, isOpen: true }),
    );

    fireEvent.keyDown(getPromptEditorElement(), { key: "Escape" });
    await waitFor(() =>
      expect(layouts.at(-1)).toEqual({ height: 0, isOpen: false }),
    );
    rectSpy.mockRestore();
  });

  it("renders a plugin mention's named icon hint", async () => {
    const suggestion = { ...githubIssueSuggestion, icon: "FileText" };
    const { promptBoxRef } = renderPromptBox("@fix", {
      mentionSuggestions: [suggestion],
    });

    await focusPromptEnd(promptBoxRef);
    const row = await screen.findByRole("button", { name: /Fix login bug/u });
    expect(row.querySelector('[data-icon="FileText"]')).not.toBeNull();
  });

  it("keeps a plugin mention's named icon hint in the inserted pill", async () => {
    setPluginLogoUrls(new Map());
    const suggestion = { ...githubIssueSuggestion, icon: "FileText" };
    const { promptBoxRef } = renderPromptBox("@fix", {
      mentionSuggestions: [suggestion],
    });

    await focusPromptEnd(promptBoxRef);
    fireEvent.mouseDown(
      await screen.findByRole("button", { name: /Fix login bug/u }),
      { button: 0 },
    );

    await waitFor(() =>
      expect(
        getPromptEditorElement().querySelector('[data-icon="FileText"]'),
      ).not.toBeNull(),
    );
  });

  it("reports hash mention queries with the active trigger", async () => {
    const { onMentionQueryChange, promptBoxRef } = renderPromptBox("#42", {
      mentionTriggers: ["@", "#"],
    });

    await focusPromptEnd(promptBoxRef);

    await waitFor(() =>
      expect(onMentionQueryChange).toHaveBeenCalledWith("42", "#"),
    );
  });

  it("does not open the menu for a bare non-at mention trigger", async () => {
    const { onMentionQueryChange, promptBoxRef } = renderPromptBox("#", {
      mentionTriggers: ["@", "#"],
      mentionSuggestions: [githubIssueSuggestion],
    });

    await focusPromptEnd(promptBoxRef);

    await waitFor(() =>
      expect(onMentionQueryChange).toHaveBeenCalledWith("", "#"),
    );
    expect(screen.queryByText("GitHub issues")).toBeNull();
  });

  it("inserts hash-triggered plugin mentions without duplicating the prefix", async () => {
    setPluginLogoUrls(
      new Map([
        [
          "github",
          {
            displayName: "GitHub",
            icon: null,
            compactIconUrl: null,
            logoUrl: "/api/v1/plugins/github/assets/logo?h=abc",
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    const { changes, promptBoxRef } = renderPromptBox("#42", {
      mentionTriggers: ["@", "#"],
      mentionSuggestions: [githubIssueSuggestion],
    });

    await focusPromptEnd(promptBoxRef);
    const suggestion = await screen.findByRole("button", {
      name: /#42 Fix login bug/u,
    });
    fireEvent.mouseDown(suggestion, { button: 0 });

    await waitFor(() =>
      expect(latestValue(changes)).toBe("#42 Fix login bug "),
    );
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "#42 Fix login bug".length,
        resource: {
          kind: "plugin",
          pluginId: "github",
          icon: null,
          itemId: "issue:owner/repo#42",
          label: "#42 Fix login bug",
        },
      },
    ]);
    const promptEditor = getPromptEditorElement();
    expect(promptEditor.querySelector('[data-icon="Zap"]')).toBeTruthy();
    expect(promptEditor.querySelector("img")).toBeNull();
  });

  it("keeps path-first mention results in keyboard navigation order", async () => {
    const pathSuggestion: PromptMentionSuggestion = {
      kind: "path",
      source: "workspace",
      entryKind: "file",
      path: "src/app.ts",
      name: "app.ts",
      replacement: "src/app.ts",
    };
    const threadSuggestion: PromptMentionSuggestion = {
      kind: "thread",
      path: "thread:thr_app",
      replacement: "thread:thr_app",
      projectId: "proj_app",
      projectName: "App",
      threadId: "thr_app",
      title: "App thread",
    };
    const { promptBoxRef } = renderPromptBox("@src/", {
      mentionSuggestions: [pathSuggestion, threadSuggestion],
    });

    await focusPromptEnd(promptBoxRef);
    const workspaceLabel = await screen.findByText("Workspace");
    const menu = workspaceLabel.closest(".overflow-hidden");
    if (!(menu instanceof HTMLElement)) {
      throw new Error("Expected mention menu");
    }
    const [pathButton, threadButton] = within(menu).getAllByRole("button");
    expect(pathButton.textContent).toContain("app.ts");
    expect(threadButton.textContent).toContain("App thread");
    expect(pathButton.className).toContain("bg-state-active");

    fireEvent.keyDown(getPromptEditorElement(), { key: "ArrowDown" });

    await waitFor(() =>
      expect(threadButton.className).toContain("bg-state-active"),
    );
  });

  it("keeps the keyboard-selected mention when a stronger delayed result arrives", async () => {
    const threadSuggestion: PromptMentionSuggestion = {
      kind: "thread",
      path: "thread:thr_atlas",
      replacement: "Atlas launch notes",
      projectId: "proj_atlas",
      projectName: "Atlas",
      threadId: "thr_atlas",
      title: "Atlas launch notes",
    };
    const sectionSuggestion: PromptMentionSuggestion = {
      kind: "section",
      path: "section:sec_atlas_planning",
      replacement: "Atlas planning",
      sectionId: "sec_atlas_planning",
      name: "Atlas planning",
    };
    const delayedExactSuggestion: PromptMentionSuggestion = {
      kind: "plugin",
      pluginId: "installed",
      providerId: "plugins",
      itemId: "plugins:atlas",
      providerLabel: "Installed",
      title: "Atlas",
      subtitle: null,
      icon: null,
      replacement: "Atlas",
    };
    const changes: PromptChange[] = [];
    const promptBoxRef = createRef<PromptBoxHandle>();

    function Harness({
      mentionSuggestions,
    }: {
      mentionSuggestions: readonly PromptMentionSuggestion[];
    }) {
      const [value, setValue] = useState("@atlas");
      const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>(
        [],
      );
      return (
        <PromptBoxInternal
          value={value}
          mentionRanges={mentionRanges}
          onChange={(nextValue, nextMentions) => {
            changes.push({ mentions: nextMentions, value: nextValue });
            setValue(nextValue);
            setMentionRanges(nextMentions);
          }}
          onSubmit={vi.fn()}
          typeahead={{
            mention: {
              results: orderPromptMentionSuggestions({
                query: "atlas",
                suggestions: mentionSuggestions,
              }),
              isLoading: false,
              isError: false,
              onQueryChange: vi.fn(),
            },
            command: INERT_TYPEAHEAD_COMMAND_CONFIG,
          }}
          mentionMenuPlacement="bottom"
          promptBoxRef={promptBoxRef}
        />
      );
    }

    const initialSuggestions = [threadSuggestion, sectionSuggestion];
    const view = render(<Harness mentionSuggestions={initialSuggestions} />);
    await focusPromptEnd(promptBoxRef);

    const sectionButton = await screen.findByRole("button", {
      name: "Atlas planning",
    });
    fireEvent.keyDown(getPromptEditorElement(), { key: "ArrowDown" });
    await waitFor(() =>
      expect(sectionButton.className).toContain("bg-state-active"),
    );

    view.rerender(
      <Harness
        mentionSuggestions={[...initialSuggestions, delayedExactSuggestion]}
      />,
    );
    await screen.findByRole("button", { name: "Atlas" });
    await waitFor(() =>
      expect(sectionButton.className).toContain("bg-state-active"),
    );

    fireEvent.keyDown(getPromptEditorElement(), { key: "Enter" });

    await waitFor(() => expect(latestValue(changes)).toBe("@Atlas planning "));
    expect(latestChange(changes)?.mentions[0]?.resource).toMatchObject({
      kind: "section",
      sectionId: "sec_atlas_planning",
    });
  });
});

describe("PromptBoxInternal selection reveal", () => {
  async function nextAnimationFrame() {
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  it("reveals the moving selection head, not the anchor, when a selection extends upward", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const { promptBoxRef } = renderPromptBox(lines.join("\n"));

    const scrollContainer = document.querySelector(
      "[data-promptbox-editor-scroll]",
    );
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Prompt editor scroll container was not rendered");
    }
    let scrollTop = 500;
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = next;
      },
    });
    const scrollRectSpy = vi
      .spyOn(scrollContainer, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 320, 100));
    let view: EditorView | null = null;
    const coordsAtPosSpy = vi
      .spyOn(EditorView.prototype, "coordsAtPos")
      .mockImplementation(function (this: EditorView, pos: number) {
        view = this;
        const { selection } = this.state;
        if (pos === selection.head && selection.head !== selection.anchor) {
          return { left: 0, right: 0, top: -30, bottom: -14 };
        }
        return { left: 0, right: 0, top: 160, bottom: 176 };
      });

    try {
      await focusPromptEnd(promptBoxRef);
      await nextAnimationFrame();

      expect(view).not.toBeNull();
      if (view === null) {
        throw new Error("Expected focus reveal to capture the editor view");
      }
      const liveView: EditorView = view;
      const { doc } = liveView.state;
      scrollTop = 500;
      await act(async () => {
        liveView.dispatch(
          liveView.state.tr.setSelection(
            TextSelection.create(doc, doc.content.size - 1, 1),
          ),
        );
      });
      await nextAnimationFrame();

      expect(scrollTop).toBeLessThan(500);
    } finally {
      coordsAtPosSpy.mockRestore();
      scrollRectSpy.mockRestore();
    }
  });
});

describe("PromptBoxInternal prompt actions", () => {
  it("keeps the action row out of text selection while the editor stays selectable", () => {
    renderPromptBox("");

    const actionRow = document.querySelector("[data-promptbox-action-row]");
    expect(actionRow?.classList.contains("select-none")).toBe(true);
    expect(getPromptEditorElement().closest(".select-none")).toBeNull();
  });

  it("keeps the custom caret reveal for composer-handled text pastes", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );

    const scrollContainer = document.querySelector(
      "[data-promptbox-editor-scroll]",
    );
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Prompt editor scroll container was not rendered");
    }
    const scrollRectSpy = vi
      .spyOn(scrollContainer, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 320, 100));
    const coordsAtPosSpy = vi
      .spyOn(EditorView.prototype, "coordsAtPos")
      .mockReturnValue({
        left: 0,
        right: 0,
        top: 120,
        bottom: 136,
      });

    try {
      pastePlainText("first line\nsecond line");

      await waitFor(() =>
        expect(latestValue(changes)).toBe("first line\nsecond line"),
      );
      await act(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );

      expect(coordsAtPosSpy).toHaveBeenCalled();
    } finally {
      coordsAtPosSpy.mockRestore();
      scrollRectSpy.mockRestore();
    }
  });

  it("pastes clipboard text and attaches the clipboard image", async () => {
    const onAttachFiles = vi.fn().mockResolvedValue(undefined);
    const { changes, promptBoxRef } = renderPromptBox("Before ", {
      onAttachFiles,
    });
    const image = new File(["image"], "photo.png", { type: "image/png" });

    await focusPromptEnd(promptBoxRef);
    pasteClipboard({ files: [image], plainText: "A photo" });

    await waitFor(() => expect(latestValue(changes)).toBe("Before A photo"));
    expect(onAttachFiles).toHaveBeenCalledWith([image]);
  });

  it("preserves blockquote structure when pasting copied blockquote html", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    pasteClipboard({
      html: "<blockquote><p>quoted</p></blockquote>",
      plainText: "> quoted",
    });

    await waitFor(() => expect(latestValue(changes)).toBe("> quoted"));
    expect(getPromptEditorElement().querySelector("blockquote")).not.toBeNull();
  });

  it("keeps multiple pasted plugin references as distinct pills", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");
    const reference = (id: string, label: string) => {
      const pill = promptMentionClipboardContent({
        kind: "plugin",
        pluginId: "plugin-api-docs",
        icon: null,
        itemId: `surface:${id}`,
        label,
      });
      return {
        text: `Build a plugin capability like ${pill.text.trimEnd()} using bb's Plugin Guide. `,
        html: `Build a plugin capability like ${pill.html.trimEnd()} using bb's Plugin Guide. `,
      };
    };

    await focusPromptEnd(promptBoxRef);
    const actions = reference("composer-actions", "Inline actions");
    pasteClipboard({ html: actions.html, plainText: actions.text });
    await waitFor(() =>
      expect(latestChange(changes)?.mentions).toHaveLength(1),
    );

    const panels = reference("thread-panel", "Thread side-panel tabs");
    pasteClipboard({ html: panels.html, plainText: panels.text });

    await waitFor(() =>
      expect(latestChange(changes)?.mentions).toHaveLength(2),
    );
    expect(
      latestChange(changes)?.mentions.map((mention) => mention.resource),
    ).toEqual([
      expect.objectContaining({ itemId: "surface:composer-actions" }),
      expect.objectContaining({ itemId: "surface:thread-panel" }),
    ]);
    expect(
      getPromptEditorElement().querySelectorAll(".prompt-mention-pill"),
    ).toHaveLength(2);
    expect(latestValue(changes)).toBe(
      "Build a plugin capability like @Inline actions using bb's Plugin Guide. " +
        "Build a plugin capability like @Thread side-panel tabs using bb's Plugin Guide. ",
    );
  });

  it("opens the file picker from the prompt actions menu", async () => {
    const onAttachFiles = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          attachments: { onAttachFiles },
          promptActions,
        })}
      />,
    );

    const attachmentInput = document.querySelector('input[type="file"]');
    if (!(attachmentInput instanceof HTMLInputElement)) {
      throw new Error("Attachment input was not rendered");
    }
    const clickFileInput = vi
      .spyOn(attachmentInput, "click")
      .mockImplementation(() => {});

    await selectPromptAction("Attach files");

    expect(clickFileInput).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Prompt actions" })).toBeNull(),
    );
  });

  it("inserts the skills trigger with no trailing space", async () => {
    const { changes, onCommandQueryChange } = renderPromptBox("");

    await selectPromptAction("Skills");

    await waitFor(() => expect(latestValue(changes)).toBe("/"));
    await waitFor(() =>
      expect(document.activeElement).toBe(getPromptEditorElement()),
    );
    expect(onCommandQueryChange).toHaveBeenCalledWith("");
  });

  it("does not duplicate the skills trigger when it is already active", async () => {
    const { changes } = renderPromptBox("/");

    await selectPromptAction("Skills");

    expect(changes).toHaveLength(0);
  });

  it("replaces an active skills command token with plan mode", async () => {
    const { changes, promptBoxRef } = renderPromptBox("Start /");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Plan");

    await waitFor(() => expect(latestValue(changes)).toBe("Start /plan "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: "Start ".length,
        end: "Start /plan".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ]);
  });

  it("replaces an active partial skills command token with plan mode", async () => {
    const { changes, promptBoxRef } = renderPromptBox("Start /pl");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Plan");

    await waitFor(() => expect(latestValue(changes)).toBe("Start /plan "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: "Start ".length,
        end: "Start /plan".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ]);
  });

  it.each([
    ["Start /", "Plan", "Start /plan "],
    ["Start /p", "Plan", "Start /plan "],
    ["Start /g", "Goal", "Start /goal "],
  ])(
    "replaces an active partial slash token %s with %s",
    async (initialValue, actionLabel, expectedValue) => {
      const { changes, promptBoxRef } = renderPromptBox(initialValue);

      await focusPromptEnd(promptBoxRef);
      await selectPromptAction(actionLabel);

      await waitFor(() => expect(latestValue(changes)).toBe(expectedValue));
    },
  );

  it("inserts goal mode as a command pill", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Goal");

    await waitFor(() => expect(latestValue(changes)).toBe("/goal "));
    await waitFor(() =>
      expect(document.querySelector('[data-icon="Target"]')).not.toBeNull(),
    );
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/goal".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "goal",
          source: "command",
          origin: "user",
          label: "goal",
          argumentHint: null,
        },
      },
    ]);
  });

  it("inserts automation mode as a command pill", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Automation");

    await waitFor(() => expect(latestValue(changes)).toBe("/automation "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/automation".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "automation",
          source: "command",
          origin: "user",
          label: "automation",
          argumentHint: null,
        },
      },
    ]);
  });

  it("seeds the plugin prompt as plain text and returns focus", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Plugin");

    await waitFor(() =>
      expect(latestValue(changes)).toBe(CREATE_PLUGIN_PROMPT_ACTION.text),
    );
    expect(latestChange(changes)?.mentions).toEqual([]);
  });

  it("does not duplicate command text immediately before the cursor", async () => {
    const { changes, promptBoxRef } = renderPromptBox("Start /goal ");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Goal");

    expect(changes).toHaveLength(0);
  });

  it("replaces a just-selected plan action with goal at the cursor", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Plan");
    await waitFor(() => expect(latestValue(changes)).toBe("/plan "));
    await waitForPromptFocus();

    await selectPromptAction("Goal");

    await waitFor(() => expect(latestValue(changes)).toBe("/goal "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/goal".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "goal",
          source: "command",
          origin: "user",
          label: "goal",
          argumentHint: null,
        },
      },
    ]);
  });

  it("replaces a just-selected skills trigger with plan at the cursor", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Skills");
    await waitFor(() => expect(latestValue(changes)).toBe("/"));
    await waitForPromptFocus();

    await selectPromptAction("Plan");

    await waitFor(() => expect(latestValue(changes)).toBe("/plan "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/plan".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
    ]);
  });

  it("pastes prompt action command tokens as goal, plan, and automation pills", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");
    const text =
      "/plan inspect first\n/goal finish the change\n/automation keep checking";

    await focusPromptEnd(promptBoxRef);
    pastePlainText(text);

    await waitFor(() => expect(latestValue(changes)).toBe(text));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/plan".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "user",
          label: "plan",
          argumentHint: null,
        },
      },
      {
        start: "/plan inspect first\n".length,
        end: "/plan inspect first\n/goal".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "goal",
          source: "command",
          origin: "user",
          label: "goal",
          argumentHint: null,
        },
      },
      {
        start: "/plan inspect first\n/goal finish the change\n".length,
        end: "/plan inspect first\n/goal finish the change\n/automation".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "automation",
          source: "command",
          origin: "user",
          label: "automation",
          argumentHint: null,
        },
      },
    ]);
  });

  it("replaces a just-selected goal action with skills at the cursor", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Goal");
    await waitFor(() => expect(latestValue(changes)).toBe("/goal "));
    await waitForPromptFocus();

    await selectPromptAction("Skills");

    await waitFor(() => expect(latestValue(changes)).toBe("/"));
    expect(latestChange(changes)?.mentions).toEqual([]);
  });

  it("replaces a just-selected goal action with automation at the cursor", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Goal");
    await waitFor(() => expect(latestValue(changes)).toBe("/goal "));
    await waitForPromptFocus();

    await selectPromptAction("Automation");

    await waitFor(() => expect(latestValue(changes)).toBe("/automation "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/automation".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "automation",
          source: "command",
          origin: "user",
          label: "automation",
          argumentHint: null,
        },
      },
    ]);
  });

  it("selects automation from slash typeahead as a command pill", async () => {
    const { changes, promptBoxRef } = renderPromptBox("/auto", {
      commandSuggestions: [
        {
          kind: "command",
          name: "automation",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ],
    });

    await focusPromptEnd(promptBoxRef);
    await selectCommandSuggestion("automation");

    await waitFor(() => expect(latestValue(changes)).toBe("/automation "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/automation".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "automation",
          source: "command",
          origin: "user",
          label: "automation",
          argumentHint: null,
        },
      },
    ]);
  });

  it("selects a slash typeahead command as a command pill", async () => {
    const { changes, promptBoxRef } = renderPromptBox("/re", {
      commandSuggestions: [
        {
          kind: "command",
          name: "review",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ],
    });

    await focusPromptEnd(promptBoxRef);
    await selectCommandSuggestion("review");

    await waitFor(() => expect(latestValue(changes)).toBe("/review "));
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/review".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "review",
          source: "command",
          origin: "user",
          label: "review",
          argumentHint: null,
        },
      },
    ]);
  });

  it("keeps typed content after a prompt action when selecting another action", async () => {
    const { changes, promptBoxRef } = renderPromptBox("");

    await focusPromptEnd(promptBoxRef);
    await selectPromptAction("Plan");
    await waitFor(() => expect(latestValue(changes)).toBe("/plan "));
    await waitForPromptFocus();

    await act(async () => {
      promptBoxRef.current?.insertTextAtCursor("clean up");
    });
    await waitFor(() => expect(latestValue(changes)).toBe("/plan clean up"));

    await selectPromptAction("Goal");

    await waitFor(() => expect(latestValue(changes)).toContain("clean up"));
    expect(latestValue(changes)).not.toBe("/goal ");
  });
});

describe("PromptBoxInternal command typeahead submit", () => {
  const compactSuggestion: ProviderCommandSuggestion = {
    kind: "command",
    name: "compact",
    source: "command",
    origin: "builtin",
    description: "Compact context",
    argumentHint: null,
  };
  const userSkillSuggestion: ProviderCommandSuggestion = {
    kind: "command",
    name: "review",
    source: "skill",
    origin: "user",
    description: "Review a PR",
    argumentHint: null,
  };

  function renderCommandPromptBox(suggestion: ProviderCommandSuggestion) {
    const onSubmit = vi.fn();
    const changes: PromptChange[] = [];
    const promptBoxRef = createRef<PromptBoxHandle>();

    function Harness() {
      const [value, setValue] = useState("");
      const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>(
        [],
      );
      return (
        <PromptBoxInternal
          value={value}
          mentionRanges={mentionRanges}
          onChange={(nextValue, nextMentions) => {
            changes.push({ mentions: nextMentions, value: nextValue });
            setValue(nextValue);
            setMentionRanges(nextMentions);
          }}
          onSubmit={onSubmit}
          typeahead={{
            mention: {
              results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
              isLoading: false,
              isError: false,
              onQueryChange: () => {},
            },
            command: {
              trigger: "/",
              suggestions: [suggestion],
              isLoading: false,
              isError: false,
              hasMore: false,
              isLoadingMore: false,
              loadMore: () => {},
              onQueryChange: () => {},
            },
          }}
          mentionMenuPlacement="bottom"
          promptBoxRef={promptBoxRef}
        />
      );
    }

    render(<Harness />);
    return { changes, onSubmit, promptBoxRef };
  }

  async function openCommandMenu(
    promptBoxRef: RefObject<PromptBoxHandle | null>,
    token: string,
    name: string,
  ) {
    await focusPromptEnd(promptBoxRef);
    await act(async () => {
      promptBoxRef.current?.insertTextAtCursor(token);
    });
    await act(async () => {});
    await waitFor(() => expect(screen.queryByText(name)).not.toBeNull());
  }

  it("submits when a built-in command is selected with Enter", async () => {
    const { changes, onSubmit, promptBoxRef } =
      renderCommandPromptBox(compactSuggestion);
    await openCommandMenu(promptBoxRef, "/compact", "compact");

    await act(async () => {
      fireEvent.keyDown(getPromptEditorElement(), { key: "Enter" });
    });
    await act(async () => {});

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestChange(changes)?.mentions).toEqual([
      {
        start: 0,
        end: "/compact".length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "compact",
          source: "command",
          origin: "builtin",
          label: "compact",
          argumentHint: null,
        },
      },
    ]);
  });

  it("does not submit when a non-built-in command is selected with Enter", async () => {
    const { changes, onSubmit, promptBoxRef } =
      renderCommandPromptBox(userSkillSuggestion);
    await openCommandMenu(promptBoxRef, "/review", "review");

    await act(async () => {
      fireEvent.keyDown(getPromptEditorElement(), { key: "Enter" });
    });
    await act(async () => {});

    expect(onSubmit).not.toHaveBeenCalled();
    expect(latestChange(changes)?.mentions?.[0]?.resource).toMatchObject({
      name: "review",
      origin: "user",
    });
  });

  it("does not submit when a built-in command is selected with Tab", async () => {
    const { onSubmit, promptBoxRef } =
      renderCommandPromptBox(compactSuggestion);
    await openCommandMenu(promptBoxRef, "/compact", "compact");

    await act(async () => {
      fireEvent.keyDown(getPromptEditorElement(), { key: "Tab" });
    });
    await act(async () => {});

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("PromptBoxInternal command typeahead navigation", () => {
  it("uses the rendered section order for Arrow keys and Enter", async () => {
    const { changes, promptBoxRef } = renderPromptBox("/", {
      commandSuggestions: [
        {
          kind: "command",
          name: "plan",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "review",
          source: "skill",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "compact",
          source: "command",
          origin: "builtin",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "interview",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "deploy",
          source: "command",
          origin: "project",
          description: null,
          argumentHint: null,
        },
      ],
    });

    await focusPromptEnd(promptBoxRef);
    const sectionLabel = await screen.findByText("Commands");
    const menu = sectionLabel.closest(".overflow-hidden");
    if (!(menu instanceof HTMLElement)) {
      throw new Error("Expected command menu");
    }
    const buttons = within(menu).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "compact",
      "review",
      "deploy",
      "plan",
      "interview",
    ]);

    const editor = getPromptEditorElement();
    for (const name of ["compact", "review", "deploy", "plan", "interview"]) {
      const button = within(menu).getByRole("button", { name });
      await waitFor(() =>
        expect(button.className).toContain("bg-state-active"),
      );
      if (name !== "interview") {
        fireEvent.keyDown(editor, { key: "ArrowDown" });
      }
    }
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(latestValue(changes)).toBe("/interview "));
    expect(latestChange(changes)?.mentions[0]?.resource).toMatchObject({
      kind: "command",
      name: "interview",
    });
  });

  it("hoists an exactly-named user command above the skills section", async () => {
    const { changes, promptBoxRef } = renderPromptBox("/plan", {
      commandSuggestions: [
        {
          kind: "command",
          name: "plugin:plan",
          source: "skill",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "planner",
          source: "skill",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "planning-doc",
          source: "skill",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "plan",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          kind: "command",
          name: "plan-b",
          source: "command",
          origin: "user",
          description: null,
          argumentHint: null,
        },
      ],
    });

    await focusPromptEnd(promptBoxRef);
    const sectionLabel = await screen.findByText("User commands");
    const menu = sectionLabel.closest(".overflow-hidden");
    if (!(menu instanceof HTMLElement)) {
      throw new Error("Expected command menu");
    }
    expect(
      within(menu)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["plan", "plan-b", "plugin:plan", "planner", "planning-doc"]);
    expect(
      within(menu)
        .getAllByText(/^(User commands|Skills)$/)
        .map((label) => label.textContent),
    ).toEqual(["User commands", "Skills"]);

    await waitFor(() =>
      expect(
        within(menu).getByRole("button", { name: "plan" }).className,
      ).toContain("bg-state-active"),
    );

    fireEvent.keyDown(getPromptEditorElement(), { key: "Enter" });

    await waitFor(() => expect(latestValue(changes)).toBe("/plan "));
    expect(latestChange(changes)?.mentions[0]?.resource).toMatchObject({
      kind: "command",
      name: "plan",
      source: "command",
    });
  });
});

describe("voice recording escape", () => {
  function voiceConfig(
    overrides: Partial<PromptVoiceConfig> = {},
  ): PromptVoiceConfig {
    return {
      state: "recording",
      isSupported: true,
      stream: null,
      start: vi.fn(),
      stop: vi.fn(),
      cancel: vi.fn(),
      ...overrides,
    };
  }

  function pressEscape(): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  }

  it("cancels the recording on Escape and consumes the event before the composer's dismiss", () => {
    const cancel = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({ voice: voiceConfig({ cancel }) })}
      />,
    );

    const dismiss = vi.fn();
    const onWindowEscape = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onWindowEscape);
    const event = pressEscape();
    window.removeEventListener("keydown", onWindowEscape);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("cancels on Escape while transcribing too", () => {
    const cancel = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          voice: voiceConfig({ state: "transcribing", cancel }),
        })}
      />,
    );

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when not recording", () => {
    const cancel = vi.fn();
    render(
      <PromptBoxInternal
        {...createPromptBoxProps({
          voice: voiceConfig({ state: "idle", cancel }),
        })}
      />,
    );

    expect(pressEscape().defaultPrevented).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
});
