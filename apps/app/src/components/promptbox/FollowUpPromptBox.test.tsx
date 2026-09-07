// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler, startTransition, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@bb/client-core";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => {
  const values = {
    executionControls: vi.fn(),
    isCompactViewport: false,
    isPointerCoarse: false,
    scrollToBottom: vi.fn(),
    permissionModePicker: vi.fn(),
    voiceState: "idle" as "idle" | "recording" | "transcribing" | "error",
  };
  return Object.assign(values, {});
});
let resizeObserverCallback: ResizeObserverCallback | null = null;

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: () => ({
    isAtBottom: false,
    scrollToBottom: mocks.scrollToBottom,
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    captureScrollAnchor: vi.fn(),
  }),
}));

vi.mock("@bb/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => mocks.isCompactViewport,
}));

vi.mock("@bb/shared-ui/hooks/use-pointer-coarse", () => ({
  usePointerCoarse: () => mocks.isPointerCoarse,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      keybindings: [
        {
          command: "composer.focus",
          desktopOnly: false,
          shortcut: {
            key: "c",
            mod: false,
            meta: true,
            control: false,
            alt: false,
            shift: true,
          },
          when: {
            all: ["mainSurface", "promptAvailable"],
            none: [],
          },
        },
      ],
    },
  }),
}));

vi.mock("@/components/promptbox/PromptBoxInternal", () => ({
  PromptBoxInternal: ({
    footerStart,
    compact,
    onSubmit,
    onEscape,
    blurOnPointerSubmit,
    promptBoxRef,
    submission,
    suppressPluginComposerCustomizations,
    onCollapse,
    heightAnimationKey,
    minHeight,
    voice,
  }: {
    footerStart?: ReactNode;
    compact?: {
      isCompact: boolean;
      placeholder?: string;
    };
    onSubmit: () => void;
    onEscape?: () => void;
    blurOnPointerSubmit?: boolean;
    promptBoxRef?: {
      current: {
        captureHeightForLayoutChange: () => void;
        focusEnd: () => void;
      } | null;
    };
    submission?: { onModifierSubmit?: () => void };
    suppressPluginComposerCustomizations?: boolean;
    onCollapse?: () => void;
    heightAnimationKey?: string | number;
    minHeight?: number;
    voice?: { state: "idle" | "recording" | "transcribing" | "error" };
  }) => (
    <div
      data-testid="prompt-box"
      data-compact={compact?.isCompact}
      data-height-animation-key={heightAnimationKey}
      data-min-height={minHeight}
      data-voice-state={voice?.state}
      data-plugin-customizations-suppressed={
        suppressPluginComposerCustomizations ? "true" : "false"
      }
    >
      {footerStart}
      <input
        aria-label="Follow-up prompt"
        ref={(node) => {
          if (!promptBoxRef) return;
          promptBoxRef.current = node
            ? {
                captureHeightForLayoutChange: () => {},
                focusEnd: () => {
                  node.focus();
                  node.setSelectionRange(node.value.length, node.value.length);
                },
              }
            : null;
        }}
      />
      {compact?.isCompact ? <span>{compact.placeholder}</span> : null}
      <button
        type="button"
        onClick={(event) => {
          onSubmit();
          if (
            blurOnPointerSubmit &&
            event.detail > 0 &&
            document.activeElement instanceof HTMLElement
          ) {
            document.activeElement.blur();
          }
        }}
      >
        Submit
      </button>
      <button type="button" onClick={submission?.onModifierSubmit}>
        Modifier submit
      </button>
      {onCollapse ? (
        <button type="button" onClick={onCollapse}>
          Collapse prompt box
        </button>
      ) : null}
      {onEscape ? (
        <button type="button" onClick={onEscape}>
          Escape
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/promptbox/usePromptVoice", () => ({
  usePromptVoice: () => ({
    state: mocks.voiceState,
    isSupported: false,
    stream: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("@/components/promptbox/ExecutionControls", () => ({
  ExecutionControls: (props: { disabled?: boolean }) => {
    mocks.executionControls(props);
    return null;
  },
}));

vi.mock("@/components/pickers/PermissionModePicker", () => ({
  PermissionModePicker: (props: {
    disabled?: boolean;
    showChevronWhenDisabled?: boolean;
  }) => {
    mocks.permissionModePicker(props);
    return null;
  },
}));

vi.mock("@/views/thread-detail/ThreadTimelineScrollToBottomButton", () => ({
  ThreadTimelineScrollToBottomButton: () => null,
}));

vi.mock("@/components/thread/timeline", () => ({
  ThreadContextWindowIndicator: () => null,
}));

function createFollowUpPromptBoxProps(
  submitMode: FollowUpSubmitMode,
): Parameters<typeof FollowUpPromptBox>[0] {
  return {
    attachments: {
      items: [],
      projectId: "proj_test",
      isAttaching: false,
      error: null,
      onAttachFiles: vi.fn(),
      onRemove: vi.fn(),
    },
    stack: null,
    composer: {
      history: {
        currentDraft: { text: "Follow up", mentions: [], attachments: [] },
        entries: [],
        onSelectEntry: vi.fn(),
      },
      isFollowUpSubmitting: false,
      message: "Follow up",
      mentionRanges: [],
      onChangeMessage: vi.fn(),
      onModifierSubmit: vi.fn(),
      onSubmit: vi.fn(),
      compactPromptPlaceholder: "Ask a follow-up",
      promptPlaceholder: "Ask for a follow-up",
      canModifierSubmit: true,
      steerActiveThreadOnEnter: false,
      submitMode,
      threadRuntimeDisplayStatus:
        submitMode.kind === "queue" ? "active" : "idle",
    },
    environmentSummary: null,
    contextWindowUsage: null,
    execution: {
      provider: {
        selectedId: "codex",
      },
      model: {
        selected: "gpt-5",
        options: [],
        moreOptions: [],
        isLoading: false,
        loadFailed: false,
        onChange: vi.fn(),
      },
      reasoning: {
        value: "medium",
        options: [],
        onChange: vi.fn(),
      },
    },
    permission: {
      value: "accept-edits",
      options: [{ value: "accept-edits", label: "Accept Edits" }],
      onChange: vi.fn(),
      supported: true,
    },
    typeahead: {
      mention: {
        results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
        isLoading: false,
        isError: false,
        onQueryChange: vi.fn(),
      },
      command: {
        trigger: null,
        suggestions: [],
        isLoading: false,
        isError: false,
        hasMore: false,
        isLoadingMore: false,
        loadMore: vi.fn(),
        onQueryChange: vi.fn(),
      },
    },
    collapseResetKey: "thr_test",
  };
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mocks.isCompactViewport = false;
  mocks.isPointerCoarse = false;
  mocks.voiceState = "idle";
  resizeObserverCallback = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

describe("FollowUpPromptBox", () => {
  it("does not commit an unchanged measurement while a height update is pending", () => {
    const onRender = vi.fn();
    render(
      <Profiler id="follow-up-prompt-box" onRender={onRender}>
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
          stack={<div data-testid="measured-stack">Stack</div>}
        />
      </Profiler>,
    );
    const stackElement = screen.getByTestId("measured-stack").parentElement;
    if (!stackElement) throw new Error("Expected measured composer stack");
    Object.defineProperty(stackElement, "offsetHeight", {
      configurable: true,
      value: 24,
    });
    let commitsAfterSynchronousSignal = -1;
    const resizeEntries = [
      {
        target: stackElement,
        borderBoxSize: [{ blockSize: 24 }],
        contentRect: { height: 999 },
      } as unknown as ResizeObserverEntry,
    ];

    act(() => {
      startTransition(() => {
        resizeObserverCallback?.(resizeEntries, {} as ResizeObserver);
      });
      flushSync(() => {
        resizeObserverCallback?.(resizeEntries, {} as ResizeObserver);
      });
      commitsAfterSynchronousSignal = onRender.mock.calls.length;
    });

    expect(commitsAfterSynchronousSignal).toBe(1);
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(onRender.mock.calls[0]?.[1]).toBe("mount");
    expect(onRender.mock.calls[1]?.[1]).toBe("update");
    expect(screen.getByTestId("prompt-box").dataset.minHeight).toBe("76");
  });

  it("includes expanding plugin banners in measured stack compensation", () => {
    setPluginSlotRegistrations(
      "measured-banner",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "measured",
            banners: [
              {
                id: "banner",
                component: () => <div>Expandable plugin banner</div>,
              },
            ],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    const draft = { text: "Follow up", mentions: [], attachments: [] };
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        stack={<></>}
        pluginComposerHost={{
          scope: { kind: "thread", threadId: "thr_test" },
          textEffectKey: "thread:thr_test",
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: vi.fn(),
          focus: vi.fn(),
        }}
        pluginComposerScope={{ kind: "thread", threadId: "thr_test" }}
      />,
    );
    expect(screen.getByText("Expandable plugin banner")).toBeTruthy();
    const promptBox = screen.getByTestId("prompt-box");
    const initialMinHeight = Number(promptBox.getAttribute("data-min-height"));
    const stackElement = screen
      .getByText("Expandable plugin banner")
      .closest("[data-bb-plugin-root]")?.parentElement;
    if (!stackElement) throw new Error("Expected measured composer stack");
    Object.defineProperty(stackElement, "offsetHeight", {
      configurable: true,
      value: 24,
    });

    act(() => {
      resizeObserverCallback?.(
        [
          {
            target: stackElement,
            borderBoxSize: [{ blockSize: 24 }],
            contentRect: { height: 999 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      resizeObserverCallback?.([], {} as ResizeObserver);
    });

    expect(initialMinHeight).toBe(100);
    expect(promptBox.getAttribute("data-min-height")).toBe("76");
  });

  it("renders plugin banners above native stack content", () => {
    setPluginSlotRegistrations(
      "ordered-banner",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "ordered",
            banners: [
              {
                id: "header",
                component: () => <div data-testid="plugin-header">Header</div>,
              },
            ],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );
    const draft = { text: "Follow up", mentions: [], attachments: [] };
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="queued-messages">Queued messages</div>}
        pluginComposerHost={{
          scope: { kind: "thread", threadId: "thr_test" },
          textEffectKey: "thread:thr_test",
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: vi.fn(),
          focus: vi.fn(),
        }}
        pluginComposerScope={{ kind: "thread", threadId: "thr_test" }}
      />,
    );

    const pluginHeaderRoot = screen
      .getByTestId("plugin-header")
      .closest("[data-bb-plugin-root]");
    const queuedMessages = screen.getByTestId("queued-messages");
    expect(queuedMessages.previousElementSibling).toBe(pluginHeaderRoot);
  });

  it("lays the banner stack on an explicit single-column track", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="queued-messages">Queued messages</div>}
      />,
    );

    const stack = screen.getByTestId("queued-messages").parentElement;
    expect(stack?.className).toContain("grid-cols-[minmax(0,1fr)]");
  });

  it("does not mount plugin banners for a retained inactive composer without a real scope", () => {
    setPluginSlotRegistrations(
      "inactive-banner",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "inactive",
            banners: [
              {
                id: "banner",
                component: () => (
                  <div data-testid="inactive-plugin-banner">Plugin banner</div>
                ),
              },
            ],
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
        stack={<div data-testid="retained-native-stack">Queued messages</div>}
        pluginComposerHost={null}
        pluginComposerScope={null}
        suppressPluginComposerCustomizations
      />,
    );

    expect(screen.getByTestId("retained-native-stack")).toBeTruthy();
    expect(screen.queryByTestId("inactive-plugin-banner")).toBeNull();
  });

  it("keeps the bottom composer mounted when its stack changes", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    const { container, rerender } = render(<FollowUpPromptBox {...props} />);
    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText<HTMLInputElement>("Follow-up prompt");
    input.value = "Uncommitted editor state";
    input.focus();
    input.setSelectionRange(0, 0);

    expect(
      container
        .querySelector("[data-follow-up-composer-anchor]")
        ?.querySelector('[data-testid="prompt-box"]'),
    ).toBe(promptBox);

    rerender(
      <FollowUpPromptBox
        {...props}
        stack={<div data-testid="new-stack-item">Queue</div>}
      />,
    );

    expect(screen.getByTestId("new-stack-item")).toBeTruthy();
    expect(screen.getAllByTestId("prompt-box")).toHaveLength(1);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(input.value).toBe("Uncommitted editor state");
    fireEvent.click(screen.getByText("Submit"));
    expect(props.composer?.onSubmit).toHaveBeenCalledOnce();
  });

  it("keeps the editor mounted and hidden while a pending interaction takes its place", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { container, rerender } = render(<FollowUpPromptBox {...props} />);
    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText<HTMLInputElement>("Follow-up prompt");
    input.value = "Draft typed before the approval";
    const composerShell = container.querySelector<HTMLElement>(
      "[data-follow-up-composer]",
    );
    expect(composerShell?.hidden).toBe(false);

    rerender(
      <FollowUpPromptBox
        {...props}
        composer={{
          ...props.composer!,
          submitMode: { kind: "blocked", reason: "pending-interaction" },
        }}
        stack={<div data-testid="pending-stack">Plan mode</div>}
        pendingInteraction={
          <div data-testid="pending-interaction">Allow file write?</div>
        }
      />,
    );

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(input.value).toBe("Draft typed before the approval");
    expect(composerShell?.hidden).toBe(true);
    const interaction = screen.getByTestId("pending-interaction");
    const stackItem = screen.getByTestId("pending-stack");
    expect(
      stackItem.compareDocumentPosition(interaction) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      interaction.compareDocumentPosition(promptBox) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    rerender(<FollowUpPromptBox {...props} />);

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(composerShell?.hidden).toBe(false);
    expect(screen.queryByTestId("pending-interaction")).toBeNull();
  });

  it.each([
    ["main-thread", true],
    ["side-chat", false],
  ] as const)(
    "renders queued-message banners before the %s inline composer",
    (_kind, isPrimaryComposer) => {
      setPluginSlotRegistrations(
        "queued-tools",
        makePluginRegistrationSet({
          composerCustomizations: [
            {
              id: "queued-banner",
              scopes: ["queued-message"],
              banners: [
                {
                  id: "status",
                  chrome: "bare",
                  component: () => (
                    <div data-testid="queued-plugin-banner">Queued status</div>
                  ),
                },
              ],
            },
          ],
          pendingInteractions: [],
          sidebarFooterActions: [],
          fileOpeners: [],
        }),
      );
      const draft = { text: "Queued draft", mentions: [], attachments: [] };
      const scope = {
        kind: "queued-message" as const,
        threadId: "thr_test",
        queuedMessageId: "queued_1",
      };
      const props = createFollowUpPromptBoxProps({ kind: "ready" });
      render(
        <FollowUpPromptBox
          {...props}
          isPrimaryComposer={isPrimaryComposer}
          pluginComposerHost={{
            scope,
            textEffectKey: "queued:queued_1",
            getCurrent: () => draft,
            subscribeDraft: () => () => {},
            setDraft: vi.fn(),
            focus: vi.fn(),
          }}
          pluginComposerScope={scope}
        />,
      );

      const banner = screen.getByTestId("queued-plugin-banner");
      const promptBox = screen.getByTestId("prompt-box");
      expect(
        banner.compareDocumentPosition(promptBox) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      expect(screen.getAllByTestId("queued-plugin-banner")).toHaveLength(1);
    },
  );

  it("forwards customization suppression changes without remounting the composer", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { rerender } = render(
      <FollowUpPromptBox {...props} suppressPluginComposerCustomizations />,
    );
    const promptBox = screen.getByTestId("prompt-box");
    const input = screen.getByLabelText("Follow-up prompt");

    expect(promptBox.dataset.pluginCustomizationsSuppressed).toBe("true");

    rerender(
      <FollowUpPromptBox
        {...props}
        suppressPluginComposerCustomizations={false}
      />,
    );

    expect(screen.getByTestId("prompt-box")).toBe(promptBox);
    expect(screen.getByLabelText("Follow-up prompt")).toBe(input);
    expect(promptBox.dataset.pluginCustomizationsSuppressed).toBe("false");
  });

  it("scrolls to the bottom after submitting a ready follow-up", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    render(<FollowUpPromptBox {...props} />);

    fireEvent.click(screen.getByText("Submit"));

    expect(props.composer?.onSubmit).toHaveBeenCalledOnce();
    expect(mocks.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("forwards the composer's host Escape action", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const onEscape = vi.fn();
    if (!props.composer) throw new Error("Expected follow-up composer props");
    props.composer.onEscape = onEscape;

    render(<FollowUpPromptBox {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Escape" }));

    expect(onEscape).toHaveBeenCalledOnce();
  });

  it.each([
    {
      setting: false,
      primaryAction: "queue",
      modifierAction: "steer",
    },
    {
      setting: true,
      primaryAction: "steer",
      modifierAction: "queue",
    },
  ] as const)(
    "routes Enter/click to $primaryAction and Command+Enter to $modifierAction when steer-on-Enter is $setting",
    ({ setting, primaryAction, modifierAction }) => {
      const props = createFollowUpPromptBoxProps({
        kind: "queue",
        onStop: vi.fn(),
      });
      if (!props.composer) {
        throw new Error("Expected follow-up composer props");
      }
      props.composer.steerActiveThreadOnEnter = setting;
      render(<FollowUpPromptBox {...props} />);

      fireEvent.click(screen.getByText("Submit"));
      const expectedPrimary =
        primaryAction === "queue"
          ? props.composer.onSubmit
          : props.composer.onModifierSubmit;
      const expectedModifier =
        modifierAction === "queue"
          ? props.composer.onSubmit
          : props.composer.onModifierSubmit;
      expect(expectedPrimary).toHaveBeenCalledOnce();
      expect(expectedModifier).not.toHaveBeenCalled();
      expect(mocks.scrollToBottom).toHaveBeenCalledTimes(
        primaryAction === "steer" ? 1 : 0,
      );

      fireEvent.click(screen.getByText("Modifier submit"));
      expect(expectedModifier).toHaveBeenCalledOnce();
      expect(mocks.scrollToBottom).toHaveBeenCalledOnce();
    },
  );

  it("disables the permission picker while plan mode is active", () => {
    const props = createFollowUpPromptBoxProps({
      kind: "queue",
      onStop: vi.fn(),
    });

    render(
      <FollowUpPromptBox
        {...props}
        activePromptMode={{
          mode: "plan",
          providerId: "codex",
          prompt: "inspect the failing test",
        }}
      />,
    );

    expect(mocks.permissionModePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: true,
        showChevronWhenDisabled: true,
      }),
    );
  });

  it("can lock permission without disabling execution controls", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    render(<FollowUpPromptBox {...props} permissionReadOnly />);

    expect(mocks.executionControls).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: false,
      }),
    );
    expect(mocks.permissionModePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        disabled: true,
      }),
    );
  });

  it("starts as a single compact row on mobile without size controls", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(<FollowUpPromptBox {...props} />);

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "true",
    );
    expect(screen.getByText("Ask a follow-up")).toBeTruthy();
    expect(screen.queryByText("Local environment")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Make prompt box/u }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Collapse prompt box" }),
    ).toBeNull();
  });

  it("shows an attachment that arrives after mobile focus loss", async () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { rerender } = render(<FollowUpPromptBox {...props} />);
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

    act(() => input.focus());
    act(() => input.blur());

    await waitFor(() =>
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true"),
    );

    rerender(
      <FollowUpPromptBox
        {...props}
        attachments={{
          ...props.attachments,
          items: [
            {
              type: "localImage",
              path: "uploads/photo.png",
              name: "photo.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );
    expect(
      document
        .querySelector("[data-follow-up-composer]")
        ?.hasAttribute("data-follow-up-composer-expanded"),
    ).toBe(true);

    rerender(<FollowUpPromptBox {...props} />);

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "true",
    );
  });

  it("collapses a wide composer until the user focuses it again", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(<FollowUpPromptBox {...props} />);

    expect(screen.getByText("Local environment")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse prompt box" }),
    );

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "true",
    );
    expect(screen.queryByText("Local environment")).toBeNull();

    act(() =>
      screen.getByRole("textbox", { name: "Follow-up prompt" }).focus(),
    );

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
    expect(screen.getByText("Local environment")).toBeTruthy();
  });

  it("toggles between focused and collapsed with the composer shortcut", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(
      <AppCommandProvider>
        <FollowUpPromptBox {...props} />
      </AppCommandProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

    act(() => input.focus());
    fireEvent.keyDown(input, { key: "c", metaKey: true, shiftKey: true });

    expect(document.activeElement).not.toBe(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "true",
    );
    expect(screen.queryByText("Local environment")).toBeNull();

    fireEvent.keyDown(window, { key: "c", metaKey: true, shiftKey: true });

    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
    expect(screen.getByText("Local environment")).toBeTruthy();
  });

  it("collapses after a pointer submission when the keyboard viewport settles", async () => {
    mocks.isCompactViewport = true;
    mocks.isPointerCoarse = true;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const visualViewport = Object.assign(new EventTarget(), { height: 500 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    const props = createFollowUpPromptBoxProps({ kind: "ready" });

    try {
      render(<FollowUpPromptBox {...props} />);
      const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
      act(() => input.focus());
      act(() => {
        visualViewport.height = 300;
        visualViewport.dispatchEvent(new Event("resize"));
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("prompt-box").getAttribute("data-compact"),
        ).toBe("false"),
      );

      fireEvent.click(screen.getByRole("button", { name: "Submit" }), {
        detail: 1,
      });

      expect(props.composer?.onSubmit).toHaveBeenCalledOnce();
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      await act(
        () =>
          new Promise<void>((resolve) => {
            window.requestAnimationFrame(() => resolve());
          }),
      );
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      act(() => {
        visualViewport.height = 500;
        visualViewport.dispatchEvent(new Event("resize"));
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("prompt-box").getAttribute("data-compact"),
        ).toBe("true"),
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "visualViewport", originalDescriptor);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });

  it("expands while focus is within the mobile composer", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(<FollowUpPromptBox {...props} />);

    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
    const submit = screen.getByRole("button", { name: "Submit" });
    act(() => input.focus());

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );
    expect(screen.getByText("Local environment")).toBeTruthy();

    fireEvent.blur(input, { relatedTarget: submit });
    fireEvent.focus(submit);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );
  });

  it("does not move the mobile input before the first tap can focus it", () => {
    mocks.isCompactViewport = true;
    render(
      <FollowUpPromptBox
        {...createFollowUpPromptBoxProps({ kind: "ready" })}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

    fireEvent.pointerDown(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "true",
    );

    fireEvent.focus(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );
  });

  it("coordinates coarse-pointer expansion with a visual viewport change", async () => {
    mocks.isCompactViewport = true;
    mocks.isPointerCoarse = true;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const visualViewport = Object.assign(new EventTarget(), { height: 500 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    try {
      render(
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

      fireEvent.focus(input);
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true");

      act(() => {
        visualViewport.height = 460;
        visualViewport.dispatchEvent(new Event("resize"));
      });
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true");

      act(() => {
        visualViewport.height = 300;
        visualViewport.dispatchEvent(new Event("resize"));
      });
      await vi.waitFor(() =>
        expect(
          screen.getByTestId("prompt-box").getAttribute("data-compact"),
        ).toBe("false"),
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "visualViewport", originalDescriptor);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });

  it("stays expanded during a timeline gesture and collapses when focus leaves", async () => {
    mocks.isCompactViewport = true;
    render(
      <>
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />
        <button type="button">Outside composer</button>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
    const outside = screen.getByRole("button", { name: "Outside composer" });

    act(() => input.focus());
    fireEvent.pointerDown(outside);

    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );

    act(() => outside.focus());

    await waitFor(() =>
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true"),
    );
  });

  it("stays expanded while a composer-owned overlay is open", async () => {
    mocks.isCompactViewport = true;
    render(
      <>
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />
        <button type="button">Portaled picker content</button>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
    const trigger = screen.getByRole("button", { name: "Submit" });
    const portaledContent = screen.getByRole("button", {
      name: "Portaled picker content",
    });
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "true");
    act(() => input.focus());

    fireEvent.pointerDown(portaledContent);
    act(() => portaledContent.focus());

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );

    trigger.setAttribute("aria-expanded", "false");
    act(() => trigger.focus());
    act(() => portaledContent.focus());
    await waitFor(() =>
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true"),
    );
  });

  it("stays expanded while a composer overlay trigger is held", () => {
    mocks.isCompactViewport = true;
    vi.useFakeTimers();

    try {
      render(
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
      const trigger = screen.getByRole("button", { name: "Submit" });
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      act(() => input.focus());

      act(() => {
        fireEvent.pointerDown(trigger);
        input.blur();
        vi.advanceTimersByTime(20);
      });

      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      act(() => {
        fireEvent.pointerUp(trigger);
        trigger.setAttribute("aria-expanded", "true");
        vi.runOnlyPendingTimers();
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
        trigger.blur();
        vi.advanceTimersByTime(20);
      });

      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays expanded after pressing a non-focusable composer control", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = (
      <button type="button" disabled>
        Read only mode
      </button>
    );
    render(<FollowUpPromptBox {...props} />);
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
    act(() => input.focus());

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Read only mode" }),
    );

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      "false",
    );
  });

  it("collapses after the keyboard-dismissal fallback timeout", () => {
    mocks.isCompactViewport = true;
    mocks.isPointerCoarse = true;
    vi.useFakeTimers();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const visualViewport = Object.assign(new EventTarget(), { height: 500 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    try {
      render(
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />,
      );
      const input = screen.getByRole("textbox", { name: "Follow-up prompt" });
      act(() => input.focus());
      act(() => {
        visualViewport.height = 300;
        visualViewport.dispatchEvent(new Event("resize"));
        vi.advanceTimersByTime(20);
      });
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      act(() => {
        input.blur();
        vi.advanceTimersByTime(20);
      });
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      act(() => vi.advanceTimersByTime(700));
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("false");

      act(() => vi.advanceTimersByTime(100));
      expect(
        screen.getByTestId("prompt-box").getAttribute("data-compact"),
      ).toBe("true");
    } finally {
      vi.useRealTimers();
      if (originalDescriptor) {
        Object.defineProperty(window, "visualViewport", originalDescriptor);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });

  it("keeps the status footer out of text selection", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(<FollowUpPromptBox {...props} />);

    const footer = document.querySelector("[data-follow-up-composer-footer]");
    expect(footer?.classList.contains("select-none")).toBe(true);
    expect(screen.getByText("Local environment").closest(".select-none")).toBe(
      footer,
    );
  });

  it("keeps the full composer visible on desktop", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    props.environmentSummary = <span>Local environment</span>;
    render(<FollowUpPromptBox {...props} />);

    expect(screen.getByTestId("prompt-box").getAttribute("data-compact")).toBe(
      null,
    );
    expect(screen.getByText("Local environment")).toBeTruthy();
  });

  it.each(["recording", "transcribing"] as const)(
    "keeps the status footer while the prompt box handles voice controls during %s",
    (state) => {
      mocks.voiceState = state;
      const props = createFollowUpPromptBoxProps({ kind: "ready" });
      props.environmentSummary = <span>Local environment</span>;

      render(<FollowUpPromptBox {...props} />);

      expect(screen.getByTestId("prompt-box").dataset.voiceState).toBe(state);
      expect(
        document.querySelector("[data-follow-up-composer-footer]"),
      ).toBeTruthy();
      expect(screen.getByText("Local environment")).toBeTruthy();
    },
  );

  it("exposes focus state so narrow prompt containers can expand", async () => {
    render(
      <>
        <FollowUpPromptBox
          {...createFollowUpPromptBoxProps({ kind: "ready" })}
        />
        <button type="button">Outside composer</button>
      </>,
    );
    const composer = document.querySelector("[data-follow-up-composer]");
    const input = screen.getByRole("textbox", { name: "Follow-up prompt" });

    expect(composer?.hasAttribute("data-follow-up-composer-expanded")).toBe(
      false,
    );
    expect(screen.getByTestId("prompt-box").dataset.heightAnimationKey).toBe(
      "compact",
    );

    act(() => input.focus());
    expect(composer?.hasAttribute("data-follow-up-composer-expanded")).toBe(
      true,
    );
    expect(screen.getByTestId("prompt-box").dataset.heightAnimationKey).toBe(
      "expanded",
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside composer" }),
    );
    act(() => screen.getByRole("button", { name: "Outside composer" }).focus());
    await waitFor(() =>
      expect(composer?.hasAttribute("data-follow-up-composer-expanded")).toBe(
        false,
      ),
    );
    expect(screen.getByTestId("prompt-box").dataset.heightAnimationKey).toBe(
      "compact",
    );
  });

  it("keeps the composer mounted across compact breakpoint changes", () => {
    const props = createFollowUpPromptBoxProps({ kind: "ready" });
    const { rerender } = render(<FollowUpPromptBox {...props} />);
    const initialPromptBox = screen.getByTestId("prompt-box");

    mocks.isCompactViewport = true;
    rerender(<FollowUpPromptBox {...props} focusEndKey="mobile" />);

    expect(screen.getByTestId("prompt-box")).toBe(initialPromptBox);
  });

  it("uses the caller-specific compact placeholder", () => {
    mocks.isCompactViewport = true;
    const props = createFollowUpPromptBoxProps({
      kind: "blocked",
      reason: "stopping",
    });
    if (props.composer === null) throw new Error("Missing composer");
    props.composer.compactPromptPlaceholder = "Stopping side chat...";
    props.composer.promptPlaceholder = "Stopping side chat...";
    render(<FollowUpPromptBox {...props} />);

    expect(screen.getByText("Stopping side chat...")).toBeTruthy();
  });
});
