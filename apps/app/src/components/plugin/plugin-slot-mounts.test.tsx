// @vitest-environment jsdom

import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type {
  PluginComposerApi,
  PluginFileOpenerProps,
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import { createPluginPanelFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginNavPanelSlot,
} from "@/lib/plugin-slots";
import {
  AUTOMATIONS_PLUGIN_ID,
  PLUGIN_PANEL_ROUTE_PATH,
  AUTOMATIONS_PLUGIN_PANEL_PATH,
} from "@/lib/route-paths";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { writeLastKnownPluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import { PluginPanelView } from "@/views/PluginPanelView";
import {
  PluginPanelHeaderActions,
  PluginPanelHeaderCenter,
} from "./PluginPanelHeader";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { resetDeprecatedAliasWarningsForTests } from "@/lib/plugin-sdk-deprecated-aliases";
import { applyPluginCss, resetPluginCssForTest } from "@/lib/plugin-css";
import { ComposerActionsSlot } from "./PluginComposerActions";
import { PluginContext } from "./plugin-context";
import {
  PluginComposerHostProvider,
  PluginComposerHostScopeProvider,
  type PluginComposerHost,
  useComposerHostDraftNotifier,
  usePublishPluginComposerHost,
} from "./plugin-composer-host";
import { PluginHomepageSections } from "./PluginHomepageSections";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { PluginNavSidebarItems } from "./PluginNavSidebarItems";
import {
  getComposerInputLock,
  useComposer,
  useComposerView,
} from "@/lib/plugin-sdk-hooks";
import { subscribeComposerFocusRequests } from "@/lib/composer-focus-requests";
import { getComposerTextEffects } from "@/lib/composer-text-effects";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import {
  PluginPanelTabContent,
  usePluginNewThreadPanelActions,
  usePluginPanelActions,
  type OpenPluginPanelArgs,
} from "./PluginPanelActions";
import { NewTabActions } from "@/components/secondary-panel/NewTabActions";
import { buildFileOpenerPanelTab } from "./file-opener-tabs";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { PromptDraftState } from "@bb/client-core";

function composerTextEffectValues(storageKey: string | null) {
  return getComposerTextEffects(storageKey).map(({ effect }) => effect);
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
  window.localStorage.clear();
  resetAllCrashedPluginSlotsForTest();
  resetPluginCssForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PluginHomepageSections", () => {
  it("contains a crashing section without hiding its sibling", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    function Crashes(): never {
      throw new Error("section crashed");
    }
    function Fine() {
      return <div>fine section body</div>;
    }
    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        homepageSections: [{ id: "a", title: "Broken", component: Crashes }],
      }),
    );
    setPluginSlotRegistrations(
      "fine",
      registrationSet({
        homepageSections: [{ id: "b", title: "Fine", component: Fine }],
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <PluginHomepageSections />
      </MemoryRouter>,
    );
    expect(screen.getByText("plugin broken crashed")).toBeDefined();
    expect(screen.getByText("fine section body")).toBeDefined();
  });
});

function ThreadDraftViewer({ threadId }: { threadId: string }) {
  const draft = usePromptDraftStorage({
    kind: "thread",
    projectId: PERSONAL_PROJECT_ID,
    threadId,
  });
  return (
    <div>
      <div data-testid="draft-key">{draft.storageKey}</div>
      <div data-testid="draft-text">{draft.text}</div>
      <div data-testid="draft-mentions">{JSON.stringify(draft.mentions)}</div>
      <div data-testid="draft-attachments">
        {JSON.stringify(draft.attachments)}
      </div>
    </div>
  );
}

function NewThreadDraftViewer() {
  const draft = usePromptDraftStorage({ kind: "new-thread" });
  return (
    <div>
      <div data-testid="draft-key">{draft.storageKey}</div>
      <div data-testid="draft-text">{draft.text}</div>
      <div data-testid="draft-mentions">{JSON.stringify(draft.mentions)}</div>
      <div data-testid="draft-attachments">
        {JSON.stringify(draft.attachments)}
      </div>
    </div>
  );
}

function ThreadDraftSeeder({ threadId }: { threadId: string }) {
  const draft = usePromptDraftStorage({
    kind: "thread",
    projectId: PERSONAL_PROJECT_ID,
    threadId,
  });
  return (
    <button
      type="button"
      onClick={() =>
        draft.setDraft({
          text: "Before ideas.md after",
          mentions: [
            {
              start: 7,
              end: 15,
              resource: {
                kind: "plugin",
                pluginId: "demo",
                icon: null,
                itemId: "notes:work/ideas.md",
                label: "ideas.md",
              },
            },
          ],
          attachments: [
            {
              type: "localFile",
              path: "uploads/spec.md",
              name: "spec.md",
              sizeBytes: 42,
            },
          ],
        })
      }
    >
      seed-thread
    </button>
  );
}

function NewThreadDraftSeeder() {
  const draft = usePromptDraftStorage({ kind: "new-thread" });
  return (
    <button
      type="button"
      onClick={() =>
        draft.setDraft({
          text: "new-thread seed",
          mentions: [],
          attachments: [],
        })
      }
    >
      seed-new-thread
    </button>
  );
}

describe("useComposer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function registerComposerProbe(
    label: string,
    onRender?: (composer: PluginComposerApi) => void,
  ) {
    function ComposerProbe() {
      const composer = useComposer();
      onRender?.(composer);
      const initialMethods = useRef({
        setText: composer.setText,
        updateText: composer.updateText,
        clear: composer.clear,
        setTextEffect: composer.setTextEffect,
      });
      const methodsAreStable =
        initialMethods.current.setText === composer.setText &&
        initialMethods.current.updateText === composer.updateText &&
        initialMethods.current.clear === composer.clear &&
        initialMethods.current.setTextEffect === composer.setTextEffect;
      return (
        <div>
          <div>scope: {composer.scope.kind}</div>
          <div data-testid={`${label}-scope-project`}>
            {composer.scope.kind === "new-thread" ||
            composer.scope.kind === "side-chat"
              ? (composer.scope.projectId ?? "null")
              : "none"}
          </div>
          <div data-testid={`${label}-scope-details`}>
            {JSON.stringify(composer.scope)}
          </div>
          <div data-testid={`${label}-composer-text`}>{composer.text}</div>
          <div data-testid={`${label}-stable-methods`}>
            {String(methodsAreStable)}
          </div>
          <button type="button" onClick={() => composer.setText("replacement")}>
            {label}-replace
          </button>
          <button
            type="button"
            onClick={() =>
              composer.updateText((current) => `${current} + updated`)
            }
          >
            {label}-update
          </button>
          <button
            type="button"
            onClick={() =>
              composer.updateText((current) => `prefix ${current}`)
            }
          >
            {label}-prefix
          </button>
          <button type="button" onClick={() => composer.clear()}>
            {label}-clear
          </button>
          <button
            type="button"
            onClick={() =>
              composer.setTextEffect({ className: "test-text-effect" })
            }
          >
            {label}-start-effect
          </button>
          <button type="button" onClick={() => composer.setTextEffect(null)}>
            {label}-clear-effect
          </button>
          <button type="button" onClick={() => composer.focus()}>
            {label}-focus
          </button>
          <button
            type="button"
            onClick={() => composer.addQuote("picked text")}
          >
            {label}-quote
          </button>
          <button
            type="button"
            onClick={() =>
              composer.insertMention({
                provider: "notes",
                id: "work/ideas.md",
                label: "ideas.md",
              })
            }
          >
            {label}-mention
          </button>
          <button
            type="button"
            onClick={() =>
              composer.insertMention({
                provider: "bad:colon",
                id: "x",
                label: "x",
              })
            }
          >
            {label}-bad-mention
          </button>
        </div>
      );
    }
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        composerCustomizations: [
          {
            id: "probe",
            actions: [{ id: "probe", component: ComposerProbe }],
          },
        ],
      }),
    );
  }

  function ComposerCustomizationMount() {
    const view = useComposerView();
    return <ComposerActionsSlot view={view} />;
  }

  it("writes quotes into the thread draft and fires the focus bus", () => {
    registerComposerProbe("t");
    render(
      <MemoryRouter initialEntries={["/threads/thr_comp1"]}>
        <ComposerCustomizationMount />
        <ThreadDraftViewer threadId="thr_comp1" />
      </MemoryRouter>,
    );
    expect(screen.getByText("scope: thread")).toBeDefined();

    let focusRequests = 0;
    const storageKey = screen.getByTestId("draft-key").textContent ?? "";
    const unsubscribe = subscribeComposerFocusRequests(storageKey, () => {
      focusRequests += 1;
    });
    fireEvent.click(screen.getByText("t-quote"));
    expect(screen.getByTestId("draft-text").textContent).toBe(
      "> picked text\n",
    );
    expect(focusRequests).toBe(1);
    unsubscribe();
  });

  it("keeps the withdrawn thread-row status method callable for prebuilt 0.4.1 bundles", () => {
    let runtimeComposer: object | undefined;
    registerComposerProbe("legacy-runtime", (composer) => {
      runtimeComposer = composer;
    });
    render(
      <MemoryRouter initialEntries={["/threads/thr_legacy_runtime"]}>
        <ComposerCustomizationMount />
        <ThreadDraftViewer threadId="thr_legacy_runtime" />
      </MemoryRouter>,
    );

    expect(runtimeComposer).toBeDefined();
    expect(Reflect.get(runtimeComposer ?? {}, "setThreadRowStatus")).toBeTypeOf(
      "function",
    );
  });

  it("reads, replaces, functionally updates, and clears the latest thread text without leaking to the new-thread scope", () => {
    registerComposerProbe("edit-thread");
    render(
      <MemoryRouter initialEntries={["/threads/thr_edit"]}>
        <ComposerCustomizationMount />
        <ThreadDraftSeeder threadId="thr_edit" />
        <ThreadDraftViewer threadId="thr_edit" />
        <NewThreadDraftSeeder />
        <NewThreadDraftViewer />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("seed-thread"));
    fireEvent.click(screen.getByText("seed-new-thread"));
    expect(screen.getByTestId("edit-thread-composer-text").textContent).toBe(
      "Before ideas.md after",
    );

    let focusRequests = 0;
    const storageKey = screen.getAllByTestId("draft-key")[0]?.textContent ?? "";
    const unsubscribe = subscribeComposerFocusRequests(storageKey, () => {
      focusRequests += 1;
    });

    fireEvent.click(screen.getByText("edit-thread-replace"));
    fireEvent.click(screen.getByText("edit-thread-update"));
    fireEvent.click(screen.getByText("edit-thread-update"));
    expect(screen.getByTestId("edit-thread-composer-text").textContent).toBe(
      "replacement + updated + updated",
    );
    expect(screen.getByTestId("edit-thread-stable-methods").textContent).toBe(
      "true",
    );
    expect(focusRequests).toBe(0);
    expect(screen.getAllByTestId("draft-text")[1]?.textContent).toBe(
      "new-thread seed",
    );
    fireEvent.click(screen.getByText("edit-thread-focus"));
    expect(focusRequests).toBe(1);
    unsubscribe();

    fireEvent.click(screen.getByText("edit-thread-clear"));
    expect(screen.getByTestId("edit-thread-composer-text").textContent).toBe(
      "",
    );
    expect(screen.getAllByTestId("draft-text")[1]?.textContent).toBe(
      "new-thread seed",
    );
  });

  it("preserves attachments and reconciles only mentions touched by plain-text edits", () => {
    registerComposerProbe("structured");
    render(
      <MemoryRouter initialEntries={["/threads/thr_structured"]}>
        <ComposerCustomizationMount />
        <ThreadDraftSeeder threadId="thr_structured" />
        <ThreadDraftViewer threadId="thr_structured" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("seed-thread"));

    fireEvent.click(screen.getByText("structured-prefix"));
    expect(
      JSON.parse(screen.getByTestId("draft-mentions").textContent ?? "[]"),
    ).toMatchObject([{ start: 14, end: 22 }]);
    expect(
      JSON.parse(screen.getByTestId("draft-attachments").textContent ?? "[]"),
    ).toEqual([
      {
        type: "localFile",
        path: "uploads/spec.md",
        name: "spec.md",
        sizeBytes: 42,
      },
    ]);

    fireEvent.click(screen.getByText("structured-update"));
    expect(
      JSON.parse(screen.getByTestId("draft-mentions").textContent ?? "[]"),
    ).toMatchObject([{ start: 14, end: 22 }]);

    fireEvent.click(screen.getByText("structured-quote"));
    expect(
      JSON.parse(screen.getByTestId("draft-mentions").textContent ?? "[]"),
    ).toMatchObject([{ start: 14, end: 22 }]);
    expect(
      JSON.parse(screen.getByTestId("draft-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("structured-replace"));
    expect(screen.getByTestId("draft-mentions").textContent).toBe("[]");
    expect(
      JSON.parse(screen.getByTestId("draft-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("structured-clear"));
    expect(screen.getByTestId("draft-text").textContent).toBe("");
    expect(
      JSON.parse(screen.getByTestId("draft-attachments").textContent ?? "[]"),
    ).toHaveLength(1);
  });

  it("binds composer writes to the active queued-message editor", () => {
    registerComposerProbe("queued");

    function QueuedComposerHarness() {
      const [queuedMessageId, setQueuedMessageId] = useState("qmsg_1");
      const [draft, setDraft] = useState<PromptDraftState>({
        text: "queued draft",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "uploads/queued-spec.md",
            name: "queued-spec.md",
            sizeBytes: 42,
          },
        ],
      });
      const draftRef = useRef(draft);
      draftRef.current = draft;
      const subscribeDraft = useComposerHostDraftNotifier(draft);
      const host = useMemo<PluginComposerHost>(
        () => ({
          scope: {
            kind: "queued-message",
            threadId: "thr_queue",
            queuedMessageId,
          },
          textEffectKey: `queued-message:thr_queue:${queuedMessageId}:1`,
          getCurrent: () => draftRef.current,
          subscribeDraft,
          setDraft,
          focus: () => {},
        }),
        [queuedMessageId, subscribeDraft],
      );

      return (
        <PluginComposerHostProvider value={host}>
          <ComposerCustomizationMount />
          <div data-testid="queued-attachments">
            {JSON.stringify(draft.attachments)}
          </div>
          <button type="button" onClick={() => setQueuedMessageId("qmsg_2")}>
            change-queued-scope
          </button>
        </PluginComposerHostProvider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/threads/thr_queue"]}>
        <QueuedComposerHarness />
      </MemoryRouter>,
    );
    expect(screen.getByText("scope: queued-message")).toBeDefined();
    expect(
      JSON.parse(
        screen.getByTestId("queued-scope-details").textContent ?? "{}",
      ),
    ).toMatchObject({ kind: "queued-message", threadId: "thr_queue" });

    fireEvent.click(screen.getByText("queued-replace"));
    expect(screen.getByTestId("queued-composer-text").textContent).toBe(
      "replacement",
    );
    expect(
      JSON.parse(screen.getByTestId("queued-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    const firstEffectKey = "queued-message:thr_queue:qmsg_1:1";
    fireEvent.click(screen.getByText("queued-start-effect"));
    expect(composerTextEffectValues(firstEffectKey)).toEqual([
      { className: "test-text-effect" },
    ]);
    fireEvent.click(screen.getByText("change-queued-scope"));
    expect(screen.getByText("scope: queued-message")).toBeDefined();
    expect(composerTextEffectValues(firstEffectKey)).toEqual([]);
  });

  it("shares a queued-message host with sibling plugin surfaces in the pane", () => {
    function HostPublisher({ host }: { host: PluginComposerHost | null }) {
      usePublishPluginComposerHost(host);
      return null;
    }

    function SiblingPluginProbe() {
      const composer = useComposer();
      return (
        <>
          <div data-testid="sibling-scope">{composer.scope.kind}</div>
          <div data-testid="sibling-text">{composer.text}</div>
          <button
            type="button"
            onClick={() => composer.setText("sibling replacement")}
          >
            sibling-replace
          </button>
        </>
      );
    }

    function QueuedPaneHarness() {
      const [isEditing, setIsEditing] = useState(true);
      const [draft, setDraft] = useState<PromptDraftState>({
        text: "queued draft",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "uploads/queued-spec.md",
            name: "queued-spec.md",
            sizeBytes: 42,
          },
        ],
      });
      const host = useMemo<PluginComposerHost | null>(
        () =>
          isEditing
            ? {
                scope: {
                  kind: "queued-message",
                  threadId: "thr_queue",
                  queuedMessageId: "qmsg_1",
                },
                textEffectKey:
                  "queued-message:thr_queue:qmsg_1:sibling-surface",
                getCurrent: () => draft,
                subscribeDraft: () => () => {},
                setDraft,
                focus: () => {},
              }
            : null,
        [draft, isEditing],
      );
      return (
        <PluginComposerHostScopeProvider>
          <HostPublisher host={host} />
          <PluginContext.Provider value="demo">
            <SiblingPluginProbe />
          </PluginContext.Provider>
          <div data-testid="sibling-attachments">
            {JSON.stringify(draft.attachments)}
          </div>
          <button type="button" onClick={() => setIsEditing(false)}>
            dismiss-queued-edit
          </button>
        </PluginComposerHostScopeProvider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/threads/thr_queue"]}>
        <QueuedPaneHarness />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("sibling-scope").textContent).toBe(
      "queued-message",
    );
    expect(screen.getByTestId("sibling-text").textContent).toBe("queued draft");
    fireEvent.click(screen.getByText("sibling-replace"));
    expect(screen.getByTestId("sibling-text").textContent).toBe(
      "sibling replacement",
    );
    expect(
      JSON.parse(screen.getByTestId("sibling-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("dismiss-queued-edit"));
    expect(screen.getByTestId("sibling-scope").textContent).toBe("thread");
  });

  it("binds side-chat customizations and hooks to the visible side-chat draft", () => {
    registerComposerProbe("side");

    function SideChatComposerHarness() {
      const [childThreadId, setChildThreadId] = useState<string | null>(null);
      const [draft, setDraft] = useState<PromptDraftState>({
        text: "side-chat draft",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "uploads/side-spec.md",
            name: "side-spec.md",
            sizeBytes: 42,
          },
        ],
      });
      const draftRef = useRef(draft);
      draftRef.current = draft;
      const subscribeDraft = useComposerHostDraftNotifier(draft);
      const host = useMemo<PluginComposerHost>(
        () => ({
          scope: {
            kind: "side-chat",
            projectId: "proj_side",
            parentThreadId: "thr_parent",
            tabId: "side-chat:one",
            childThreadId,
          },
          textEffectKey: `side-chat:side-chat:one:${childThreadId ?? ""}`,
          getCurrent: () => draftRef.current,
          subscribeDraft,
          setDraft,
          focus: () => {},
        }),
        [childThreadId, subscribeDraft],
      );

      return (
        <PluginComposerHostProvider value={host}>
          <ComposerCustomizationMount />
          <div data-testid="side-attachments">
            {JSON.stringify(draft.attachments)}
          </div>
          <button type="button" onClick={() => setChildThreadId("thr_side")}>
            create-side-child
          </button>
        </PluginComposerHostProvider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/threads/thr_parent"]}>
        <SideChatComposerHarness />
      </MemoryRouter>,
    );

    expect(screen.getByText("scope: side-chat")).toBeDefined();
    expect(
      JSON.parse(screen.getByTestId("side-scope-details").textContent ?? "{}"),
    ).toEqual({
      kind: "side-chat",
      projectId: "proj_side",
      parentThreadId: "thr_parent",
      tabId: "side-chat:one",
      childThreadId: null,
    });

    fireEvent.click(screen.getByText("side-replace"));
    expect(screen.getByTestId("side-composer-text").textContent).toBe(
      "replacement",
    );
    expect(
      JSON.parse(screen.getByTestId("side-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("create-side-child"));
    expect(
      JSON.parse(screen.getByTestId("side-scope-details").textContent ?? "{}"),
    ).toEqual({
      kind: "side-chat",
      projectId: "proj_side",
      parentThreadId: "thr_parent",
      tabId: "side-chat:one",
      childThreadId: "thr_side",
    });
    expect(screen.getByTestId("side-composer-text").textContent).toBe(
      "replacement",
    );
  });

  it("targets the new-thread composer without leaking replacements to thread drafts", () => {
    registerComposerProbe("edit-new");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ComposerCustomizationMount />
        <NewThreadDraftSeeder />
        <NewThreadDraftViewer />
        <ThreadDraftSeeder threadId="thr_other" />
        <ThreadDraftViewer threadId="thr_other" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("seed-new-thread"));
    fireEvent.click(screen.getByText("seed-thread"));

    fireEvent.click(screen.getByText("edit-new-replace"));
    expect(screen.getAllByTestId("draft-text")[0]?.textContent).toBe(
      "replacement",
    );
    expect(screen.getAllByTestId("draft-text")[1]?.textContent).toBe(
      "Before ideas.md after",
    );
  });

  it("binds root compose customizations and hooks to the selected project without losing its draft", () => {
    registerComposerProbe("root");

    function RootSiblingPluginSurface() {
      const composer = useComposer();
      return (
        <>
          <div data-testid="root-sibling-scope-project">
            {composer.scope.kind === "new-thread"
              ? (composer.scope.projectId ?? "null")
              : "none"}
          </div>
          <button
            type="button"
            onClick={() => composer.setText("sibling replacement")}
          >
            root-sibling-replace
          </button>
        </>
      );
    }

    function RootComposerHarness() {
      const [projectId, setProjectId] = useState("proj_selected");
      const [draft, setDraft] = useState<PromptDraftState>({
        text: "root draft",
        mentions: [],
        attachments: [
          {
            type: "localFile",
            path: "uploads/root-spec.md",
            name: "root-spec.md",
            sizeBytes: 42,
          },
        ],
      });
      const draftRef = useRef(draft);
      draftRef.current = draft;
      const subscribeDraft = useComposerHostDraftNotifier(draft);
      const host = useMemo<PluginComposerHost>(
        () => ({
          scope: { kind: "new-thread", projectId },
          textEffectKey: `root:${projectId}`,
          getCurrent: () => draftRef.current,
          subscribeDraft,
          setDraft,
          focus: () => {},
        }),
        [projectId, subscribeDraft],
      );

      return (
        <PluginComposerHostProvider value={host}>
          <ComposerCustomizationMount />
          <PluginContext.Provider value="demo">
            <RootSiblingPluginSurface />
          </PluginContext.Provider>
          <div data-testid="root-attachments">
            {JSON.stringify(draft.attachments)}
          </div>
          <button type="button" onClick={() => setProjectId("proj_other")}>
            change-root-project
          </button>
        </PluginComposerHostProvider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <RootComposerHarness />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("root-scope-project").textContent).toBe(
      "proj_selected",
    );
    expect(screen.getByTestId("root-sibling-scope-project").textContent).toBe(
      "proj_selected",
    );
    fireEvent.click(screen.getByText("change-root-project"));
    expect(screen.getByTestId("root-scope-project").textContent).toBe(
      "proj_other",
    );
    expect(screen.getByTestId("root-sibling-scope-project").textContent).toBe(
      "proj_other",
    );
    expect(screen.getByTestId("root-composer-text").textContent).toBe(
      "root draft",
    );
    expect(
      JSON.parse(screen.getByTestId("root-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("root-sibling-replace"));
    expect(screen.getByTestId("root-composer-text").textContent).toBe(
      "sibling replacement",
    );
    expect(
      JSON.parse(screen.getByTestId("root-attachments").textContent ?? "[]"),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("root-replace"));
    expect(screen.getByTestId("root-composer-text").textContent).toBe(
      "replacement",
    );
    expect(
      JSON.parse(screen.getByTestId("root-attachments").textContent ?? "[]"),
    ).toHaveLength(1);
  });

  it("exposes the personal project and an unresolved root scope faithfully", () => {
    registerComposerProbe("root-project-state");

    function RootProjectStateHarness() {
      const [projectId, setProjectId] = useState<string | null>(
        PERSONAL_PROJECT_ID,
      );
      const host = useMemo<PluginComposerHost>(() => {
        const draft: PromptDraftState = {
          text: "",
          mentions: [],
          attachments: [],
        };
        return {
          scope: { kind: "new-thread", projectId },
          textEffectKey: `root-state:${projectId ?? "null"}`,
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: () => {},
          focus: () => {},
        };
      }, [projectId]);

      return (
        <PluginComposerHostProvider value={host}>
          <ComposerCustomizationMount />
          <button type="button" onClick={() => setProjectId(null)}>
            unset-root-project
          </button>
        </PluginComposerHostProvider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <RootProjectStateHarness />
      </MemoryRouter>,
    );

    expect(
      screen.getByTestId("root-project-state-scope-project").textContent,
    ).toBe(PERSONAL_PROJECT_ID);

    fireEvent.click(screen.getByText("unset-root-project"));
    expect(
      screen.getByTestId("root-project-state-scope-project").textContent,
    ).toBe("null");
  });

  it("scopes text effects to the composer and clears them on unmount", () => {
    registerComposerProbe("effect");
    const view = render(
      <MemoryRouter initialEntries={["/threads/thr_effect"]}>
        <ComposerCustomizationMount />
        <ThreadDraftViewer threadId="thr_effect" />
      </MemoryRouter>,
    );
    const storageKey = screen.getByTestId("draft-key").textContent ?? "";

    fireEvent.click(screen.getByText("effect-start-effect"));
    expect(composerTextEffectValues(storageKey)).toEqual([
      { className: "test-text-effect" },
    ]);
    fireEvent.click(screen.getByText("effect-clear-effect"));
    expect(composerTextEffectValues(storageKey)).toEqual([]);
    fireEvent.click(screen.getByText("effect-start-effect"));

    view.unmount();
    expect(composerTextEffectValues(storageKey)).toEqual([]);
  });

  it("keeps a same-plugin hook owner's visual state when its sibling unmounts", () => {
    const captured = new Map<
      string,
      Pick<PluginComposerApi, "setTextEffect">
    >();

    function VisualOwner({ label }: { label: string }) {
      const composer = useComposer();
      captured.set(label, {
        setTextEffect: composer.setTextEffect,
      });
      return (
        <button
          type="button"
          onClick={() => {
            composer.setTextEffect({ className: "test-text-effect" });
          }}
        >
          start-{label}
        </button>
      );
    }

    function Harness() {
      const [showFirst, setShowFirst] = useState(true);
      return (
        <PluginContext.Provider value="demo">
          {showFirst ? <VisualOwner label="first" /> : null}
          <VisualOwner label="second" />
          <button type="button" onClick={() => setShowFirst(false)}>
            unmount-first
          </button>
          <ThreadDraftViewer threadId="thr_shared_owner" />
        </PluginContext.Provider>
      );
    }

    render(
      <MemoryRouter initialEntries={["/threads/thr_shared_owner"]}>
        <Harness />
      </MemoryRouter>,
    );
    const storageKey = screen.getByTestId("draft-key").textContent ?? "";

    fireEvent.click(screen.getByText("start-first"));
    fireEvent.click(screen.getByText("start-second"));
    expect(composerTextEffectValues(storageKey)).toEqual([
      { className: "test-text-effect" },
      { className: "test-text-effect" },
    ]);
    const staleFirst = captured.get("first");
    expect(staleFirst).toBeDefined();
    fireEvent.click(screen.getByText("unmount-first"));

    expect(composerTextEffectValues(storageKey)).toEqual([
      { className: "test-text-effect" },
    ]);
    act(() => {
      staleFirst?.setTextEffect(null);
    });
    expect(composerTextEffectValues(storageKey)).toEqual([
      { className: "test-text-effect" },
    ]);
  });

  it("keeps the next scope's visual state when the previous scope cleans up", () => {
    const draft: PromptDraftState = {
      text: "Queued draft",
      mentions: [],
      attachments: [],
    };

    function ScopedVisualWriter() {
      const { scope, setTextEffect } = useComposer();
      const queuedMessageId =
        scope.kind === "queued-message" ? scope.queuedMessageId : "unexpected";

      useLayoutEffect(() => {
        setTextEffect({ className: "test-text-effect" });
      }, [queuedMessageId, setTextEffect]);

      return null;
    }

    function Harness() {
      const [queuedMessageId, setQueuedMessageId] = useState("qmsg_1");
      const host = useMemo<PluginComposerHost>(
        () => ({
          scope: {
            kind: "queued-message",
            threadId: "thr_scope_owner",
            queuedMessageId,
          },
          textEffectKey: "shared-scope-effect",
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: () => {},
          focus: () => {},
        }),
        [queuedMessageId],
      );

      return (
        <PluginContext.Provider value="demo">
          <PluginComposerHostProvider value={host}>
            <ScopedVisualWriter />
            <button type="button" onClick={() => setQueuedMessageId("qmsg_2")}>
              change-visual-scope
            </button>
          </PluginComposerHostProvider>
        </PluginContext.Provider>
      );
    }

    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    expect(composerTextEffectValues("shared-scope-effect")).toEqual([
      { className: "test-text-effect" },
    ]);
    fireEvent.click(screen.getByText("change-visual-scope"));

    expect(composerTextEffectValues("shared-scope-effect")).toEqual([
      { className: "test-text-effect" },
    ]);
  });

  it("clears a text effect when the plugin composer scope changes", () => {
    registerComposerProbe("scope-effect");
    function ChangeScope() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate("/threads/thr_effect_next")}
        >
          change-scope
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={["/threads/thr_effect"]}>
        <ComposerCustomizationMount />
        <ThreadDraftViewer threadId="thr_effect" />
        <ChangeScope />
      </MemoryRouter>,
    );
    const storageKey = screen.getByTestId("draft-key").textContent ?? "";

    fireEvent.click(screen.getByText("scope-effect-start-effect"));
    expect(composerTextEffectValues(storageKey)).toEqual([
      { className: "test-text-effect" },
    ]);
    fireEvent.click(screen.getByText("change-scope"));

    expect(composerTextEffectValues(storageKey)).toEqual([]);
  });

  it("clears and rejects captured lock and effect setters after scope cleanup or unmount", () => {
    const captured: Array<
      Pick<PluginComposerApi, "setInputLock" | "setTextEffect">
    > = [];
    registerComposerProbe("owned", (composer) => {
      const previous = captured.at(-1);
      if (
        previous?.setInputLock !== composer.setInputLock ||
        previous?.setTextEffect !== composer.setTextEffect
      ) {
        captured.push({
          setInputLock: composer.setInputLock,
          setTextEffect: composer.setTextEffect,
        });
      }
    });
    function ChangeScope() {
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={() => navigate("/threads/thr_owned_next")}
        >
          change-owned-scope
        </button>
      );
    }
    const view = render(
      <MemoryRouter initialEntries={["/threads/thr_owned"]}>
        <ComposerCustomizationMount />
        <ThreadDraftViewer threadId="thr_owned" />
        <ThreadDraftViewer threadId="thr_owned_next" />
        <ChangeScope />
      </MemoryRouter>,
    );
    const [initialStorageKey, nextStorageKey] = screen
      .getAllByTestId("draft-key")
      .map((element) => element.textContent ?? "");

    fireEvent.click(screen.getByText("owned-start-effect"));
    act(() => captured[0]!.setInputLock(true));
    expect(getComposerInputLock(initialStorageKey ?? null)).toBe(true);
    expect(composerTextEffectValues(initialStorageKey ?? null)).toEqual([
      { className: "test-text-effect" },
    ]);
    const staleScopeSetters = captured[0]!;
    fireEvent.click(screen.getByText("change-owned-scope"));
    expect(getComposerInputLock(initialStorageKey ?? null)).toBe(false);
    expect(composerTextEffectValues(initialStorageKey ?? null)).toEqual([]);
    act(() => {
      staleScopeSetters.setInputLock(true);
      staleScopeSetters.setTextEffect({ className: "stale-text-effect" });
    });
    expect(getComposerInputLock(initialStorageKey ?? null)).toBe(false);
    expect(composerTextEffectValues(initialStorageKey ?? null)).toEqual([]);
    const currentSetters = captured.at(-1)!;
    act(() => {
      currentSetters.setInputLock(true);
      currentSetters.setTextEffect({ className: "test-text-effect" });
    });
    expect(getComposerInputLock(nextStorageKey ?? null)).toBe(true);
    expect(composerTextEffectValues(nextStorageKey ?? null)).toEqual([
      { className: "test-text-effect" },
    ]);
    view.unmount();
    expect(getComposerInputLock(nextStorageKey ?? null)).toBe(false);
    expect(composerTextEffectValues(nextStorageKey ?? null)).toEqual([]);
    act(() => {
      currentSetters.setInputLock(true);
      currentSetters.setTextEffect({ className: "unmounted-text-effect" });
    });
    expect(getComposerInputLock(nextStorageKey ?? null)).toBe(false);
    expect(composerTextEffectValues(nextStorageKey ?? null)).toEqual([]);
  });

  it("appends mention pills with offsets into the new-thread draft", () => {
    registerComposerProbe("n");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ComposerCustomizationMount />
        <NewThreadDraftViewer />
      </MemoryRouter>,
    );
    expect(screen.getByText("scope: new-thread")).toBeDefined();

    fireEvent.click(screen.getByText("n-mention"));
    expect(screen.getByTestId("draft-text").textContent).toBe("ideas.md ");
    const mentions = JSON.parse(
      screen.getByTestId("draft-mentions").textContent ?? "[]",
    ) as Array<{
      start: number;
      end: number;
      resource: Record<string, unknown>;
    }>;
    expect(mentions).toEqual([
      {
        start: 0,
        end: 8,
        resource: {
          kind: "plugin",
          pluginId: "demo",
          icon: null,
          itemId: "notes:work/ideas.md",
          label: "ideas.md",
        },
      },
    ]);

    fireEvent.click(screen.getByText("n-mention"));
    expect(screen.getByTestId("draft-text").textContent).toBe(
      "ideas.md ideas.md ",
    );
  });

  it("rejects provider ids containing ':' without touching the draft", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerComposerProbe("b");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ComposerCustomizationMount />
        <NewThreadDraftViewer />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("b-bad-mention"));
    expect(screen.getByTestId("draft-text").textContent).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid provider id"),
    );
  });

  it("routes experimental_submit to the composer that owns the submission, and refuses where none does", async () => {
    const submit = vi.fn(async () => {});
    let captured: PluginComposerApi | null = null;
    registerComposerProbe("submit", (composer) => {
      captured = composer;
    });
    const draft: PromptDraftState = {
      text: "ship the notes",
      mentions: [],
      attachments: [],
    };

    function Harness({ withSubmit }: { withSubmit: boolean }) {
      const host = useMemo<PluginComposerHost>(
        () => ({
          scope: { kind: "thread", threadId: "thr_submit" },
          textEffectKey: "thread:thr_submit",
          getCurrent: () => draft,
          subscribeDraft: () => () => {},
          setDraft: () => {},
          focus: () => {},
          ...(withSubmit ? { submit } : {}),
        }),
        [withSubmit],
      );
      return (
        <PluginComposerHostProvider value={host}>
          <ComposerCustomizationMount />
        </PluginComposerHostProvider>
      );
    }

    const view = render(
      <MemoryRouter initialEntries={["/threads/thr_submit"]}>
        <Harness withSubmit />
      </MemoryRouter>,
    );
    const sendAt = Date.now() + 3_600_000;
    await act(async () => {
      await captured!.experimental_submit({ sendAt });
    });
    expect(submit).toHaveBeenCalledWith({ sendAt });

    await expect(
      captured!.experimental_submit({ sendAt: Date.now() - 1 }),
    ).rejects.toThrow(/future/);
    expect(submit).toHaveBeenCalledTimes(1);

    view.unmount();
    render(
      <MemoryRouter initialEntries={["/threads/thr_submit"]}>
        <Harness withSubmit={false} />
      </MemoryRouter>,
    );
    await expect(captured!.experimental_submit({ sendAt })).rejects.toThrow(
      /cannot schedule/,
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("PluginNavSidebarItems + PluginPanelView", () => {
  function Board() {
    return <div>board panel body</div>;
  }

  function registerAutomationsPanel() {
    setPluginSlotRegistrations(
      AUTOMATIONS_PLUGIN_ID,
      registrationSet({
        navPanels: [
          {
            id: AUTOMATIONS_PLUGIN_PANEL_PATH,
            title: "Automations",
            icon: "Calendar",
            path: AUTOMATIONS_PLUGIN_PANEL_PATH,
            component: Board,
          },
        ],
      }),
    );
  }

  it("keeps the Automations row in the nav list", () => {
    registerAutomationsPanel();

    render(
      <MemoryRouter>
        <PluginNavSidebarItems />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Automations" })).toBeDefined();
  });

  it("renders a sidebar entry that routes to the plugin panel", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        navPanels: [
          {
            id: "board",
            title: "Demo board",
            icon: "columns",
            path: "board",
            component: Board,
          },
        ],
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <PluginNavSidebarItems />
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path={PLUGIN_PANEL_ROUTE_PATH} element={<PluginPanelView />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("Demo board"));
    expect(screen.getByText("board panel body")).toBeDefined();
  });

  it("releases the plugin stylesheet when navigation unmounts the panel route", async () => {
    vi.useFakeTimers();
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        navPanels: [
          {
            id: "board",
            title: "Demo board",
            icon: "columns",
            path: "board",
            component: Board,
          },
        ],
      }),
    );
    applyPluginCss("demo", "/demo.css?h=route");
    function LeavePanel() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate("/")}>
          Leave panel
        </button>
      );
    }
    render(
      <MemoryRouter initialEntries={["/plugins/demo/board"]}>
        <Routes>
          <Route
            path={PLUGIN_PANEL_ROUTE_PATH}
            element={
              <>
                <LeavePanel />
                <PluginPanelView />
              </>
            }
          />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Leave panel" }));
    await act(async () => {});
    expect(screen.getByText("home")).toBeDefined();
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).toBeNull();
  });

  it("shows a plugin panel's position when it is open in a split", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        navPanels: [
          {
            id: "board",
            title: "Demo board",
            icon: "columns",
            path: "board",
            component: Board,
          },
        ],
      }),
    );
    const store = createStore();
    store.set(splitLayoutAtom, {
      focusedPaneId: "pane-thread",
      root: {
        type: "split",
        dir: "row",
        sizes: [0.5, 0.5],
        children: [
          {
            type: "pane",
            paneId: "pane-plugin",
            content: {
              kind: "plugin-panel",
              pluginId: "demo",
              panelPath: "board",
              subPath: "card/1",
            },
          },
          {
            type: "pane",
            paneId: "pane-thread",
            content: {
              kind: "thread",
              projectId: "proj_test",
              threadId: "thr_test",
            },
          },
        ],
      },
    });

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={["/"]}>
          <PluginNavSidebarItems splitEnabled />
        </MemoryRouter>
      </Provider>,
    );

    const splitMap = screen.getByRole("img", {
      name: "Demo board — open in split",
    });
    const label = screen.getByText("Demo board");
    expect(label.nextElementSibling).toBe(splitMap);
  });

  it("keeps the sidebar entry active on nested plugin panel routes", () => {
    setPluginSlotRegistrations(
      "simple-notes",
      registrationSet({
        navPanels: [
          {
            id: "simple-notes",
            title: "Simple notes",
            icon: "note",
            path: "simple-notes",
            component: Board,
          },
        ],
      }),
    );
    render(
      <MemoryRouter
        initialEntries={[
          "/plugins/simple-notes/simple-notes/bb-plugin-marketplaces-and-compatible-updates.md",
        ]}
      >
        <PluginNavSidebarItems />
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("button", { name: "Simple notes" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("draws a remembered plugin row before boot and keeps the same node when the plugin registers", () => {
    resetPluginFrontendBootStateForTest();
    writeLastKnownPluginNavPanelChrome([
      {
        pluginId: "demo",
        id: "board",
        path: "board",
        title: "Demo board",
        icon: "columns",
      },
    ]);
    render(
      <MemoryRouter>
        <PluginNavSidebarItems />
      </MemoryRouter>,
    );
    const rememberedRow = screen.getByRole("button", { name: "Demo board" });

    act(() => {
      setPluginSlotRegistrations(
        "demo",
        registrationSet({
          navPanels: [
            {
              id: "board",
              title: "Demo board",
              icon: "columns",
              path: "board",
              component: Board,
            },
          ],
        }),
      );
      markPluginFrontendsSettled();
    });
    expect(screen.getByRole("button", { name: "Demo board" })).toBe(
      rememberedRow,
    );
  });

  it("drops a remembered plugin row that never registers once frontends have settled", () => {
    resetPluginFrontendBootStateForTest();
    writeLastKnownPluginNavPanelChrome([
      {
        pluginId: "ghost",
        id: "board",
        path: "board",
        title: "Ghost board",
        icon: "columns",
      },
    ]);
    render(
      <MemoryRouter>
        <PluginNavSidebarItems />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Ghost board" })).toBeDefined();
    act(() => markPluginFrontendsSettled());
    expect(screen.queryByRole("button", { name: "Ghost board" })).toBeNull();
  });

  it("stays quiet for an unknown panel until plugin frontends have booted", () => {
    resetPluginFrontendBootStateForTest();
    render(
      <MemoryRouter initialEntries={["/plugins/ghost/board"]}>
        <Routes>
          <Route path={PLUGIN_PANEL_ROUTE_PATH} element={<PluginPanelView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText(/This plugin panel is not available/)).toBeNull();

    act(() => markPluginFrontendsSettled());
    expect(
      screen.getByText(/This plugin panel is not available/),
    ).toBeDefined();
  });
});

describe("plugin panel shared title bar and full-bleed body", () => {
  function PanelBody() {
    return <div>panel body</div>;
  }

  function panelSlot(
    overrides: Partial<PluginNavPanelSlot>,
  ): PluginNavPanelSlot {
    return {
      id: "board",
      title: "Demo board",
      icon: "Columns",
      path: "board",
      component: PanelBody,
      pluginId: "demo",
      generation: 1,
      ...overrides,
    };
  }

  function renderPanelBody(route = "/plugins/demo/board") {
    return render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={PLUGIN_PANEL_ROUTE_PATH} element={<PluginPanelView />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("hides a throwing headerContent without breaking the header (no crash chip)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    function ExplodingAccessory(): never {
      throw new Error("accessory exploded");
    }
    const panel = panelSlot({ headerContent: ExplodingAccessory });
    render(
      <>
        <PluginPanelHeaderCenter chrome={panel} />
        <PluginPanelHeaderActions panel={panel} subPath="" />
      </>,
    );
    expect(screen.getByText("Demo board")).toBeDefined();
    expect(screen.queryByText(/plugin demo crashed/)).toBeNull();
  });

  it("gives headerContent independent CSS ownership without a mounted panel body", async () => {
    vi.useFakeTimers();
    function Accessory() {
      return <button type="button">Toggle sidebar</button>;
    }
    const panel = panelSlot({ headerContent: Accessory });
    applyPluginCss("demo", "/demo.css?h=header");
    const view = render(
      <>
        <PluginPanelHeaderCenter chrome={panel} />
        <PluginPanelHeaderActions panel={panel} subPath="notes/today.md" />
      </>,
    );
    expect(screen.getByText("Demo board")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).toBeDefined();
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("plugin-panel-body")).toBeNull();

    view.unmount();
    await act(async () => {});
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(
      document.head.querySelector('link[data-bb-plugin-css="demo"]'),
    ).toBeNull();
  });

  it("keys the right-panel toggle target to its owning pane", () => {
    const panel = panelSlot({});
    render(
      <PluginPanelHeaderActions panel={panel} paneId="pane-docs" subPath="" />,
    );

    expect(
      document
        .querySelector("[data-plugin-right-panel-toggle-portal]")
        ?.getAttribute("data-plugin-right-panel-toggle-portal"),
    ).toBe("plugin-panel:demo:board:pane-docs");
  });

  it("still contains a crashing panel inside the error boundary", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    function Crashes(): never {
      throw new Error("panel crashed");
    }
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        navPanels: [panelSlot({ component: Crashes })],
      }),
    );
    renderPanelBody();
    expect(screen.getByText("plugin demo crashed")).toBeDefined();
  });
});

describe("plugin thread panel actions", () => {
  function PanelProbe({ threadId, params }: PluginThreadPanelProps) {
    return (
      <div>
        panel body for {threadId} / {JSON.stringify(params)}
      </div>
    );
  }

  function NewThreadPanelProbe({
    projectId,
    params,
  }: PluginNewThreadPanelProps) {
    return (
      <div>
        new thread panel for {String(projectId)} / {JSON.stringify(params)}
      </div>
    );
  }

  function ActionsProbe({
    threadId,
    openPluginPanel,
  }: {
    threadId: string | null;
    openPluginPanel: (args: OpenPluginPanelArgs) => void;
  }) {
    const entries = usePluginPanelActions({ openPluginPanel, threadId });
    return (
      <div>
        {entries.map((entry) => (
          <button key={entry.id} type="button" onClick={entry.onSelect}>
            {entry.title}
          </button>
        ))}
      </div>
    );
  }

  it("opens and renders a panel with action context and serialized params", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          {
            id: "issue",
            title: "Issue",
            component: PanelProbe,
            run: ({ threadId, openPanel }) => {
              openPanel({
                title: `Issue for ${threadId}`,
                params: { n: 1, nested: [true, null, { label: "ok" }] },
              });
            },
          },
        ],
      }),
    );

    function ActionHarness() {
      const [tab, setTab] = useState<ReturnType<
        typeof createPluginPanelFixedPanelTab
      > | null>(null);
      return (
        <>
          <ActionsProbe
            threadId="thr_9"
            openPluginPanel={(args) =>
              setTab(createPluginPanelFixedPanelTab(args))
            }
          />
          {tab ? (
            <PluginPanelTabContent
              tab={tab}
              context={{ kind: "thread", threadId: "thr_9" }}
            />
          ) : null}
        </>
      );
    }

    render(<ActionHarness />);
    fireEvent.click(screen.getByText("Issue"));

    expect(
      screen.getByText(
        'panel body for thr_9 / {"n":1,"nested":[true,null,{"label":"ok"}]}',
      ),
    ).toBeDefined();
  });

  it("contains a throwing run and declines non-JSON params without opening", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const declines: boolean[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          {
            id: "boom",
            title: "Boom",
            component: PanelProbe,
            run: () => {
              throw new Error("action exploded");
            },
          },
          {
            id: "cyclic",
            title: "Cyclic",
            component: PanelProbe,
            run: ({ openPanel }) => {
              declines.push(openPanel({ params: cyclic as never }));
            },
          },
          {
            id: "coerced",
            title: "Coerced",
            component: PanelProbe,
            run: ({ openPanel }) => {
              declines.push(
                openPanel({ params: new Date("2026-01-01") as never }),
              );
            },
          },
        ],
      }),
    );
    const openPluginPanel = vi.fn();
    render(<ActionsProbe threadId="thr_9" openPluginPanel={openPluginPanel} />);
    fireEvent.click(screen.getByText("Boom"));
    fireEvent.click(screen.getByText("Cyclic"));
    fireEvent.click(screen.getByText("Coerced"));
    expect(openPluginPanel).not.toHaveBeenCalled();
    expect(declines).toEqual([false, false]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("reports an accepted open as true from both panel action kinds", () => {
    const accepted: boolean[] = [];
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          {
            id: "issue",
            title: "Thread action",
            component: PanelProbe,
            run: ({ openPanel }) => {
              accepted.push(openPanel({ params: { source: "thread" } }));
            },
          },
        ],
        newThreadPanelActions: [
          {
            id: "setup",
            title: "Root action",
            component: NewThreadPanelProbe,
            run: ({ openPanel }) => {
              accepted.push(openPanel({ params: { source: "root" } }));
            },
          },
        ],
      }),
    );

    function BothActionsHarness() {
      const threadEntries = usePluginPanelActions({
        openPluginPanel: () => undefined,
        threadId: "thr_9",
      });
      const rootEntries = usePluginNewThreadPanelActions({
        openPluginPanel: () => undefined,
        projectId: "proj_1",
      });
      return (
        <div>
          {[...threadEntries, ...rootEntries].map((entry) => (
            <button key={entry.id} type="button" onClick={entry.onSelect}>
              {entry.title}
            </button>
          ))}
        </div>
      );
    }

    render(<BothActionsHarness />);
    fireEvent.click(screen.getByText("Thread action"));
    fireEvent.click(screen.getByText("Root action"));

    expect(accepted).toEqual([true, true]);
  });

  it("offers no actions outside a thread context", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          { id: "issue", title: "Issue", component: PanelProbe },
        ],
      }),
    );
    render(<ActionsProbe threadId={null} openPluginPanel={vi.fn()} />);
    expect(screen.queryByText("Issue")).toBeNull();
  });

  it("offers only opted-in New thread actions on the root panel", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          { id: "issue", title: "Thread issue", component: PanelProbe },
        ],
        newThreadPanelActions: [
          {
            id: "setup",
            title: "Set up thread",
            icon: "Wand",
            component: NewThreadPanelProbe,
            run: ({ projectId, openPanel }) => {
              openPanel({
                title: `Setup for ${String(projectId)}`,
                params: { source: "root" },
              });
            },
          },
        ],
      }),
    );

    function RootActionHarness() {
      const [tab, setTab] = useState<ReturnType<
        typeof createPluginPanelFixedPanelTab
      > | null>(null);
      const entries = usePluginNewThreadPanelActions({
        openPluginPanel: (args) => setTab(createPluginPanelFixedPanelTab(args)),
        projectId: "proj_1",
      });
      return (
        <>
          <NewTabActions
            onStartTerminal={() => undefined}
            pluginActions={entries}
          />
          {tab ? (
            <PluginPanelTabContent
              tab={tab}
              context={{ kind: "new-thread", projectId: "proj_1" }}
            />
          ) : null}
        </>
      );
    }

    const root = render(<RootActionHarness />);
    expect(screen.getByText("Start terminal")).toBeDefined();
    expect(screen.getByText("Set up thread")).toBeDefined();
    expect(screen.queryByText("Thread issue")).toBeNull();
    fireEvent.click(screen.getByText("Set up thread"));
    expect(
      screen.getByText('new thread panel for proj_1 / {"source":"root"}'),
    ).toBeDefined();
    root.unmount();

    render(<ActionsProbe threadId="thr_9" openPluginPanel={vi.fn()} />);
    expect(screen.getByText("Thread issue")).toBeDefined();
    expect(screen.queryByText("Set up thread")).toBeNull();
  });

  it("degrades to a placeholder when the tab's action is gone", () => {
    const tab = createPluginPanelFixedPanelTab({
      actionId: "issue",
      paramsJson: null,
      pluginId: "ghost",
      title: "Issue",
    });
    render(
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: "thr_9" }}
      />,
    );
    expect(screen.getByText(/This plugin tab is not available/)).toBeDefined();
  });

  it("narrows invalid persisted params to null before rendering plugin code", () => {
    setPluginSlotRegistrations(
      "demo",
      registrationSet({
        threadPanelActions: [
          { id: "issue", title: "Issue", component: PanelProbe },
        ],
      }),
    );
    const tab = createPluginPanelFixedPanelTab({
      actionId: "issue",
      paramsJson: "1e999",
      pluginId: "demo",
      title: "Issue",
    });

    render(
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: "thr_9" }}
      />,
    );
    expect(screen.getByText("panel body for thr_9 / null")).toBeDefined();
  });
});

describe("plugin file opener tabs", () => {
  function MarkdownEditorProbe({
    path,
    source,
  }: {
    path: string;
    source: { kind: string; environmentId: string | null };
  }) {
    return (
      <div>
        editor {path} @ {source.kind}:{String(source.environmentId)}
      </div>
    );
  }

  it("renders a registered opener with parsed path and source", () => {
    setPluginSlotRegistrations(
      "notes",
      registrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component: MarkdownEditorProbe,
          },
        ],
      }),
    );
    const tab = {
      ...createPluginPanelFixedPanelTab({
        actionId: "file-opener:editor",
        paramsJson: JSON.stringify({
          path: "notes/todo.md",
          source: {
            kind: "workspace",
            threadId: null,
            environmentId: "env_1",
            projectId: null,
          },
        }),
        pluginId: "notes",
        title: "todo.md",
      }),
      fileOpenerOwner: {
        kind: "workspace-file-preview" as const,
        environmentId: "env_1",
        projectId: null,
        tab: {
          lineRange: { startLineNumber: 7, endLineNumber: 9 },
          path: "notes/todo.md",
          source: { kind: "working-tree" as const },
          statusLabel: null,
        },
        threadId: null,
      },
    };

    render(
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "new-thread", projectId: null }}
        fileOpenerOriginal={<div>native preview</div>}
      />,
    );

    expect(
      screen.getByText("editor notes/todo.md @ workspace:env_1"),
    ).toBeDefined();
  });

  it("lets an opener delegate to the exact native preview node", () => {
    function DelegatingEditor({ Original }: PluginFileOpenerProps) {
      return <Original />;
    }
    setPluginSlotRegistrations(
      "notes",
      registrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component: DelegatingEditor,
          },
        ],
      }),
    );
    const tab = buildFileOpenerPanelTab(
      { id: "editor", pluginId: "notes" },
      {
        path: "notes/todo.md",
        source: {
          kind: "workspace",
          environmentId: "env_1",
          projectId: null,
          threadId: "thr_1",
        },
      },
      {
        kind: "workspace-file-preview",
        environmentId: "env_1",
        projectId: null,
        tab: {
          lineRange: { startLineNumber: 7, endLineNumber: 9 },
          path: "notes/todo.md",
          source: { kind: "working-tree" },
          statusLabel: null,
        },
        threadId: "thr_1",
      },
    );

    render(
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: "thr_1" }}
        fileOpenerOriginal={
          <button type="button">Native line 7 and editor actions</button>
        }
      />,
    );

    expect(screen.getByRole("button").textContent).toBe(
      "Native line 7 and editor actions",
    );
  });

  it("uses the owner when the opener is gone and a placeholder for junk params", () => {
    const orphanTab = {
      ...createPluginPanelFixedPanelTab({
        actionId: "file-opener:gone",
        paramsJson: JSON.stringify({
          path: "a.md",
          source: {
            kind: "workspace",
            threadId: null,
            environmentId: "env_1",
            projectId: null,
          },
        }),
        pluginId: "ghost",
        title: "a.md",
      }),
      fileOpenerOwner: {
        kind: "workspace-file-preview" as const,
        environmentId: "env_1",
        projectId: null,
        tab: {
          lineRange: { startLineNumber: 3, endLineNumber: 4 },
          path: "a.md",
          source: { kind: "working-tree" as const },
          statusLabel: null,
        },
        threadId: null,
      },
    };
    const { unmount } = render(
      <PluginPanelTabContent
        tab={orphanTab}
        context={{ kind: "new-thread", projectId: null }}
        fileOpenerOriginal={
          <button type="button">Native preview actions for a.md</button>
        }
      />,
    );
    expect(screen.getByRole("button").textContent).toBe(
      "Native preview actions for a.md",
    );
    unmount();

    setPluginSlotRegistrations(
      "notes",
      registrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component: MarkdownEditorProbe,
          },
        ],
      }),
    );
    const junkParamsTab = createPluginPanelFixedPanelTab({
      actionId: "file-opener:editor",
      paramsJson: "not json",
      pluginId: "notes",
      title: "junk",
    });
    render(
      <PluginPanelTabContent
        tab={junkParamsTab}
        context={{ kind: "new-thread", projectId: null }}
        fileOpenerOriginal={<div>must not render</div>}
      />,
    );
    expect(screen.getByText(/file opener is not available/)).toBeDefined();
  });

  it("restores the exact native preview node when the opener crashes", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    function CrashingEditor(): never {
      throw new Error("editor crashed");
    }
    setPluginSlotRegistrations(
      "notes",
      registrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component: CrashingEditor,
          },
        ],
      }),
    );
    const tab = {
      ...createPluginPanelFixedPanelTab({
        actionId: "file-opener:editor",
        paramsJson: JSON.stringify({
          path: "notes/todo.md",
          source: {
            kind: "workspace",
            threadId: "thr_1",
            environmentId: "env_1",
            projectId: null,
          },
        }),
        pluginId: "notes",
        title: "todo.md",
      }),
      fileOpenerOwner: {
        kind: "workspace-file-preview" as const,
        environmentId: "env_1",
        projectId: null,
        tab: {
          lineRange: { startLineNumber: 7, endLineNumber: 9 },
          path: "notes/todo.md",
          source: { kind: "working-tree" as const },
          statusLabel: null,
        },
        threadId: "thr_1",
      },
    };

    render(
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: "thr_1" }}
        fileOpenerOriginal={
          <button type="button">Native selection and editor actions</button>
        }
      />,
    );

    expect(screen.getByRole("button").textContent).toBe(
      "Native selection and editor actions",
    );
  });
});

describe("file opener experimental_Original alias", () => {
  beforeEach(() => {
    resetDeprecatedAliasWarningsForTests();
  });

  function registerOpener(
    component: (props: PluginFileOpenerProps) => React.ReactNode,
  ) {
    setPluginSlotRegistrations(
      "notes",
      registrationSet({
        fileOpeners: [
          {
            id: "editor",
            title: "Notes editor",
            extensions: ["md"],
            component,
          },
        ],
      }),
    );
  }

  const tab = buildFileOpenerPanelTab(
    { id: "editor", pluginId: "notes" },
    {
      path: "notes/todo.md",
      source: {
        kind: "workspace",
        environmentId: "env_1",
        projectId: null,
        threadId: "thr_1",
      },
    },
    {
      kind: "workspace-file-preview",
      environmentId: "env_1",
      projectId: null,
      tab: {
        lineRange: { startLineNumber: 7, endLineNumber: 9 },
        path: "notes/todo.md",
        source: { kind: "working-tree" },
        statusLabel: null,
      },
      threadId: "thr_1",
    },
  );

  function renderOpener(nativePreview: string) {
    return (
      <PluginPanelTabContent
        tab={tab}
        context={{ kind: "thread", threadId: "thr_1" }}
        fileOpenerOriginal={<button type="button">{nativePreview}</button>}
      />
    );
  }

  it("delegates to the native preview through the alias and warns once across renders", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let renders = 0;
    registerOpener(({ experimental_Original: LegacyOriginal }) => {
      renders += 1;
      return LegacyOriginal === undefined ? (
        <div>alias missing</div>
      ) : (
        <LegacyOriginal />
      );
    });

    const { rerender } = render(renderOpener("Native preview and actions"));
    expect(screen.getByRole("button").textContent).toBe(
      "Native preview and actions",
    );

    rerender(renderOpener("Native preview for line 7"));
    expect(screen.getByRole("button").textContent).toBe(
      "Native preview for line 7",
    );
    expect(renders).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "experimental_Original is deprecated; use Original. Removed in bb 0.42",
    );
  });

  it("never warns for an opener that reads Original", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerOpener(({ Original }) => <Original />);

    render(renderOpener("Native preview and actions"));

    expect(screen.getByRole("button").textContent).toBe(
      "Native preview and actions",
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
