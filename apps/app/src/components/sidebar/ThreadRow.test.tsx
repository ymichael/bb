// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { createStore, Provider } from "jotai";
import type { ThreadListEntry } from "@bb/domain";
import type { PluginComposerThreadRowStatus } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSidebarTitleDoubleClickForTest,
  ThreadRow,
  type ThreadRowOptions,
} from "./ThreadRow";

const mocks = vi.hoisted(() => ({
  renameThread: vi.fn(),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    renameThread: mocks.renameThread,
  }),
}));
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import {
  SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
  SIDEBAR_WORKING_STATUS_COLOR_CLASS,
} from "./sidebarRowClasses";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  SidebarThreadShortcutKeysContext,
} from "./sidebarThreadShortcuts";
import {
  resetPluginThreadRowStatusesForTest,
  setPluginThreadRowStatus,
} from "@/lib/plugin-thread-row-status";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { SPLIT_LAYOUT_STORAGE_KEY } from "@/lib/split-layout/persistence";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "@bb/client-core";
import { sdk } from "@/lib/sdk";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";

vi.mock("@/components/thread/ThreadActionsMenu", () => ({
  ThreadActionsContextMenu: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ThreadActionsMenu: () => null,
  ThreadArchiveQuickAction: () => null,
}));

function createThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntryFixture({
    id: "thr_test",
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

const DEFAULT_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isCompact: false,
};

function ThreadRowTestHarness({
  crossProjectId = null,
  hasComposerDraft = false,
  isActive = false,
  options = DEFAULT_OPTIONS,
  shortcutKey,
  thread,
}: {
  crossProjectId?: string | null;
  hasComposerDraft?: boolean;
  isActive?: boolean;
  options?: ThreadRowOptions;
  shortcutKey?: string;
  thread: ThreadListEntry;
}) {
  const shortcutKeys = shortcutKey
    ? new Map([
        [
          thread.id,
          { ariaKeyshortcuts: `Meta+${shortcutKey}`, label: `⌘${shortcutKey}` },
        ],
      ])
    : EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS;

  return (
    <MemoryRouter>
      <TooltipProvider>
        <SidebarThreadShortcutKeysContext.Provider value={shortcutKeys}>
          <ThreadRow
            projectId={thread.projectId}
            thread={thread}
            crossProjectId={crossProjectId}
            isActive={isActive}
            hasComposerDraft={hasComposerDraft}
            options={options}
          />
        </SidebarThreadShortcutKeysContext.Provider>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function renderThreadRow({
  hasComposerDraft = false,
  isActive = false,
  options = DEFAULT_OPTIONS,
  shortcutKey,
  thread = createThread(),
}: {
  hasComposerDraft?: boolean;
  isActive?: boolean;
  options?: ThreadRowOptions;
  shortcutKey?: string;
  thread?: ThreadListEntry;
}) {
  const result = render(
    <ThreadRowTestHarness
      hasComposerDraft={hasComposerDraft}
      isActive={isActive}
      options={options}
      shortcutKey={shortcutKey}
      thread={thread}
    />,
  );
  return {
    ...result,
    rerenderThreadRow(nextThread: ThreadListEntry) {
      result.rerender(
        <ThreadRowTestHarness
          hasComposerDraft={hasComposerDraft}
          isActive={isActive}
          options={options}
          shortcutKey={shortcutKey}
          thread={nextThread}
        />,
      );
    },
  };
}

function renderSplitThreadRow({
  hasComposerDraft = false,
  options = DEFAULT_OPTIONS,
  pluginStatus,
  shortcutKey,
  thread = createThread(),
}: {
  hasComposerDraft?: boolean;
  options?: ThreadRowOptions;
  pluginStatus?: PluginComposerThreadRowStatus;
  shortcutKey?: string;
  thread?: ThreadListEntry;
} = {}) {
  if (pluginStatus) {
    setPluginThreadRowStatus(thread.id, "split-status-test", pluginStatus);
  }
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
          paneId: "pane-thread",
          content: {
            kind: "thread",
            projectId: thread.projectId,
            threadId: thread.id,
          },
        },
        {
          type: "pane",
          paneId: "pane-compose",
          content: { kind: "new-thread" },
        },
      ],
    },
  });

  return render(
    <Provider store={store}>
      <ThreadRowTestHarness
        hasComposerDraft={hasComposerDraft}
        options={options}
        shortcutKey={shortcutKey}
        thread={thread}
      />
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.renameThread.mockReset();
  resetSidebarTitleDoubleClickForTest();
  resetPluginThreadRowStatusesForTest();
  expect(vi.isMockFunction(sdk.threads.resolveMentions)).toBe(false);
  window.localStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
  window.sessionStorage.removeItem(SPLIT_LAYOUT_STORAGE_KEY);
});

describe("ThreadRow", () => {
  const splitWorkingCases: Array<{
    label: string;
    pluginStatus?: PluginComposerThreadRowStatus;
    thread: ThreadListEntry;
  }> = [
    {
      label: "runtime + pending input",
      thread: createThread({
        status: "active",
        hasPendingInteraction: true,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    },
    {
      label: "workflow + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    },
    {
      label: "background agent + unread error",
      thread: createThread({
        status: "error",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    },
    {
      label: "background command + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    },
    {
      label: "plan mode + unread error",
      thread: createThread({
        status: "error",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 1,
          activeGoalCount: 0,
        },
      }),
    },
    {
      label: "goal + pending input",
      thread: createThread({
        hasPendingInteraction: true,
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 1,
        },
      }),
    },
    {
      label: "plugin running + unread error",
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin running",
        tone: "running",
      },
      thread: createThread({ status: "error" }),
    },
  ];

  it.each(splitWorkingCases)(
    "shimmers the split map for $label",
    ({ pluginStatus, thread }) => {
      const { container } = renderSplitThreadRow({ pluginStatus, thread });

      const splitMap = screen.getByRole("img", { name: /open in split/ });
      expect(Array.from(splitMap.classList)).toContain("animate-shine-icon");
      expect(
        splitMap.closest("[data-sidebar-thread-trailing-indicator]"),
      ).not.toBeNull();
      expect(container.querySelector('[data-icon="Loading"]')).toBeNull();
    },
  );

  it.each([
    ["idle", createThread()],
    ["unread error only", createThread({ status: "error" })],
  ])("keeps the split map static for %s", (_label, thread) => {
    renderSplitThreadRow({ thread });

    const splitMap = screen.getByRole("img", { name: /open in split/ });
    expect(Array.from(splitMap.classList)).not.toContain("animate-shine-icon");
  });

  it.each([
    {
      label: "pending input",
      expectedStatus: "Thread needs user input",
      thread: createThread({ hasPendingInteraction: true }),
    },
    {
      label: "unread error",
      expectedStatus: "Unread thread failed",
      thread: createThread({ status: "error" }),
    },
    {
      label: "plugin status",
      expectedStatus: "Plugin improving draft",
      pluginStatus: {
        icon: "AiContentGenerator01" as const,
        label: "Plugin improving draft",
      },
      thread: createThread(),
    },
    {
      label: "collapsed child workflow",
      expectedStatus: "Workflow running",
      options: {
        kind: "parent" as const,
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          ...NO_COLLAPSED_CHILD_ACTIVITY,
          workflow: true,
        },
        onToggleCollapsed: vi.fn(),
      },
      thread: createThread(),
    },
  ])(
    "preserves the $label status in the split map accessible name",
    ({ expectedStatus, options, pluginStatus, thread }) => {
      renderSplitThreadRow({ options, pluginStatus, thread });

      expect(
        screen
          .getByRole("img", { name: /open in split/ })
          .getAttribute("aria-label"),
      ).toBe(`Thread — open in split; ${expectedStatus}`);
    },
  );

  it("puts the draft icon in the trailing status slot", () => {
    const { container } = renderThreadRow({ hasComposerDraft: true });

    const draftIcon = container.querySelector('[data-icon="Edit"]');
    expect(draftIcon).not.toBeNull();
    expect(
      draftIcon?.closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread (unsubmitted draft)" }),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Thread has unsubmitted draft")).toBeNull();
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });

  it("replaces the draft icon with a plugin status and restores it when cleared", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AiContentGenerator01",
      label: "Plugin improving draft",
    });
    const { container } = renderThreadRow({ hasComposerDraft: true });

    const runningIcon = screen.getByLabelText("Plugin improving draft");
    expect(runningIcon.getAttribute("data-icon")).toBe("AiContentGenerator01");
    expect(container.querySelector('[data-icon="Edit"]')).toBeNull();

    act(() => {
      setPluginThreadRowStatus("thr_test", "composer-status-test", null);
    });

    expect(screen.queryByLabelText("Plugin improving draft")).toBeNull();
    expect(container.querySelector('[data-icon="Edit"]')).not.toBeNull();
  });

  it("shows a keyboard shortcut in place of a plugin status", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AiContentGenerator01",
      label: "Plugin improving draft",
    });

    renderThreadRow({ shortcutKey: "3" });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(screen.queryByLabelText("Plugin improving draft")).toBeNull();
  });

  it("shows a keyboard shortcut in place of a split mini-map", () => {
    renderSplitThreadRow({ shortcutKey: "3" });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(screen.queryByRole("img", { name: /open in split/ })).toBeNull();
  });

  it("renders a plugin status with the semantic success tone", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AiContentGenerator01",
      label: "Plugin improving draft",
      tone: "success",
    });
    renderThreadRow({ hasComposerDraft: true });

    const runningIcon = screen.getByLabelText("Plugin improving draft");
    expect(runningIcon.getAttribute("data-icon")).toBe("AiContentGenerator01");
    expect(Array.from(runningIcon.classList)).toContain(
      SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
    );
    expect(Array.from(runningIcon.classList)).not.toContain(
      SIDEBAR_WORKING_STATUS_COLOR_CLASS,
    );
  });

  it("automatically shimmers a plugin status with the running tone", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AiContentGenerator01",
      label: "Plugin running",
      tone: "running",
    });
    renderThreadRow({ hasComposerDraft: true });

    const runningIcon = screen.getByLabelText("Plugin running");
    expect(runningIcon.getAttribute("data-icon")).toBe("AiContentGenerator01");
    expect(Array.from(runningIcon.classList)).toContain("animate-shine-icon");
    expect(Array.from(runningIcon.classList)).toContain(
      "motion-safe:[animation-duration:1.5s]",
    );
    expect(Array.from(runningIcon.classList)).not.toContain(
      "animate-shine-icon-status",
    );
    expect(Array.from(runningIcon.parentElement?.classList ?? [])).toContain(
      "text-success",
    );
    expect(Array.from(runningIcon.parentElement?.classList ?? [])).toContain(
      "motion-safe:animate-pulse",
    );
  });

  it("renders a static destructive plugin status with the error tone", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AlertCircle",
      label: "Plugin failed",
      tone: "error",
    });
    renderThreadRow({ hasComposerDraft: true });

    const errorIcon = screen.getByLabelText("Plugin failed");
    expect(errorIcon.getAttribute("data-icon")).toBe("AlertCircle");
    expect(Array.from(errorIcon.classList)).toContain("text-destructive");
    expect(Array.from(errorIcon.classList)).not.toContain("animate-shine-icon");
  });

  it("keeps the runtime spinner ahead of a plugin status", () => {
    setPluginThreadRowStatus("thr_test", "composer-status-test", {
      icon: "AiContentGenerator01",
      label: "Plugin improving draft",
    });
    const { container } = renderThreadRow({
      hasComposerDraft: false,
      thread: createThread({
        status: "active",
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    });

    const runningIcon = screen.getByLabelText("Thread working");
    expect(runningIcon.getAttribute("data-icon")).toBe("Loading");
    expect(Array.from(runningIcon.classList)).toContain("animate-spin");
    expect(screen.queryByLabelText("Plugin improving draft")).toBeNull();
    expect(
      container.querySelector("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
  });

  it.each([true, false] as const)(
    "keeps the working-draft pencil ahead of the runtime spinner when isActive=%s",
    (isActive) => {
      renderThreadRow({
        hasComposerDraft: true,
        isActive,
        thread: createThread({
          status: "active",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
        }),
      });

      const draftIcon = screen.getByLabelText(
        "Thread working with unsubmitted draft",
      );
      expect(draftIcon.getAttribute("data-icon")).toBe("Edit");
      expect(Array.from(draftIcon.classList)).toContain("animate-shine-icon");
      expect(Array.from(draftIcon.classList)).toContain(
        SIDEBAR_WORKING_STATUS_COLOR_CLASS,
      );
      expect(screen.queryByLabelText("Thread working")).toBeNull();
    },
  );

  it.each([
    "activeWorkflowCount",
    "activeBackgroundAgentCount",
    "activeBackgroundCommandCount",
    "activePlanModeCount",
    "activeGoalCount",
  ] as const)("uses the shimmering draft pencil with %s", (activityKey) => {
    renderThreadRow({
      hasComposerDraft: true,
      isActive: false,
      thread: createThread({
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
          [activityKey]: 1,
        },
      }),
    });

    const draftIcon = screen.getByLabelText(
      "Thread working with unsubmitted draft",
    );
    expect(Array.from(draftIcon.classList)).toContain("animate-shine-icon");
    expect(Array.from(draftIcon.classList)).toContain(
      SIDEBAR_WORKING_STATUS_COLOR_CLASS,
    );
  });

  it("renders serialized title mentions as non-interactive pills", () => {
    const mentionedThread = createThread({
      id: "thr_mentioned",
      projectId: "proj_mentioned",
      title: "Mention target",
      titleFallback: "Mention target",
    });

    render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={
          new Map([
            ["sec_mentioned", "Mention section"],
            ["sec_legacy", "Legacy section"],
          ])
        }
        projectNamesById={new Map([["proj_mentioned", "Mention project"]])}
        threadById={new Map([[mentionedThread.id, mentionedThread]])}
      >
        <ThreadRowTestHarness
          thread={createThread({
            title:
              "Compare @thread:thr_mentioned in @project:proj_mentioned, @section:sec_mentioned, legacy @folder:sec_legacy, and @apps/app/src/ThreadRow.tsx",
            titleFallback:
              "Compare @thread:thr_mentioned in @project:proj_mentioned, @section:sec_mentioned, legacy @folder:sec_legacy, and @apps/app/src/ThreadRow.tsx",
          })}
        />
      </ThreadTitleMentionResourcesProvider>,
    );

    expect(screen.getByText("Mention target").closest("a")).toBeNull();
    expect(screen.getByText("Mention project").closest("a")).toBeNull();
    expect(screen.getByText("Mention section").closest("a")).toBeNull();
    expect(screen.getByText("Legacy section").closest("a")).toBeNull();
    expect(screen.getByTitle("apps/app/src/ThreadRow.tsx")).not.toBeNull();
    expect(screen.queryByText("@thread:thr_mentioned")).toBeNull();
    const resolvedTitle =
      "Compare Mention target in Mention project, Mention section, legacy Legacy section, and ThreadRow.tsx";
    expect(
      screen.getByRole("link", { name: `Open ${resolvedTitle}` }),
    ).not.toBeNull();
    expect(screen.getByTitle(resolvedTitle)).not.toBeNull();
  });

  it("resolves a serialized thread title mention outside the sidebar cache", async () => {
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([
        {
          threadId: "thr_dcwivn5n8w",
          projectId: "proj_mentioned",
          label: "Mention target",
        },
      ]);

    try {
      render(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map()}
        >
          <ThreadRowTestHarness
            thread={createThread({
              title: "Continue from @thread:thr_dcwivn5n8w",
              titleFallback: "Continue from @thread:thr_dcwivn5n8w",
            })}
          />
        </ThreadTitleMentionResourcesProvider>,
      );

      expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
      expect(
        screen.getByRole("link", { name: "Open Continue from Thread" }),
      ).not.toBeNull();
      await waitFor(() => expect(resolveMentions).toHaveBeenCalledTimes(1));
      expect(screen.getByText("Mention target")).not.toBeNull();
      expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
      expect(
        screen.getByRole("link", {
          name: "Open Continue from Mention target",
        }),
      ).not.toBeNull();
    } finally {
      resolveMentions.mockRestore();
    }
  });

  it("keeps missing naked thread ids literal across sidebar labels", async () => {
    const missingThreadId = "thr_dcwivn5n8w";
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([]);

    try {
      render(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map()}
        >
          <ThreadRowTestHarness
            thread={createThread({
              id: "thr_canonical",
              title: `Canonical @thread:${missingThreadId}`,
              titleFallback: `Canonical @thread:${missingThreadId}`,
            })}
          />
          <ThreadRowTestHarness
            thread={createThread({
              id: "thr_naked",
              title: `Naked ${missingThreadId}`,
              titleFallback: `Naked ${missingThreadId}`,
            })}
          />
        </ThreadTitleMentionResourcesProvider>,
      );

      await waitFor(() => expect(resolveMentions).toHaveBeenCalledTimes(1));
      expect(
        await screen.findByRole("link", {
          name: "Open Canonical Unavailable thread",
        }),
      ).not.toBeNull();
      expect(screen.getByTitle("Canonical Unavailable thread")).not.toBeNull();

      const nakedTitle = `Naked ${missingThreadId}`;
      expect(
        screen.getByRole("link", { name: `Open ${nakedTitle}` }),
      ).not.toBeNull();
      expect(screen.getByTitle(nakedTitle).textContent).toBe(nakedTitle);
    } finally {
      resolveMentions.mockRestore();
    }
  });

  it("marks a child from another project with the project name", () => {
    const { container } = render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map([["proj_other", "Web App"]])}
        threadById={new Map()}
      >
        <ThreadRowTestHarness
          crossProjectId="proj_other"
          thread={createThread({
            parentThreadId: "thr_parent",
            projectId: "proj_other",
          })}
        />
      </ThreadTitleMentionResourcesProvider>,
    );

    const marker = container.querySelector(
      "[data-sidebar-thread-cross-project]",
    );
    expect(marker?.getAttribute("aria-label")).toBe("In project Web App");
    expect(marker?.querySelector('[data-icon="FolderExport"]')).not.toBeNull();
    expect(
      marker?.closest("[data-sidebar-thread-trailing-indicator]"),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread" }).getAttribute("href"),
    ).toBe("/projects/proj_other/threads/thr_test");
  });

  it("opens the thread when the cross-project marker is clicked", () => {
    const { container } = render(
      <ThreadRowTestHarness
        crossProjectId="proj_other"
        thread={createThread({
          parentThreadId: "thr_parent",
          projectId: "proj_other",
        })}
      />,
    );
    const link = screen.getByRole("link", { name: "Open Thread" });
    const onLinkClick = vi.fn();
    link.addEventListener("click", onLinkClick);

    fireEvent.click(
      container.querySelector("[data-sidebar-thread-cross-project]")!,
    );

    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it("omits the cross-project marker for same-project rows", () => {
    const { container } = renderThreadRow({});
    expect(
      container.querySelector("[data-sidebar-thread-cross-project]"),
    ).toBeNull();
  });

  it("renders a complete Unicode path mention instead of an ASCII prefix", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Review @src/café.ts",
        titleFallback: "Review @src/café.ts",
      }),
    });

    expect(screen.getByTitle("src/café.ts")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-prompt-mention="true"]'),
    ).toHaveLength(1);
    expect(screen.queryByText("é.ts")).toBeNull();
  });

  it.each([
    "Review @docs/My File.md",
    "Review @docs/My Project File.md",
    "Review @docs/My Cool Project/",
    "Review @thread-storage:Release Notes/todo.md",
    "Ask @Release Notes",
    "Ask @owner/repo",
  ])("leaves an ambiguous flattened mention literal: %s", (title) => {
    const { container } = renderThreadRow({
      thread: createThread({ title, titleFallback: title }),
    });

    expect(screen.getByText(title)).not.toBeNull();
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
  });

  it("renders an entity mention before terminal punctuation", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Ask @thread:thr_worker. Next",
        titleFallback: "Ask @thread:thr_worker. Next",
      }),
    });

    expect(screen.getByText("thr_worker")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-prompt-mention="true"]'),
    ).toHaveLength(1);
    expect(screen.queryByText("@thread:thr_worker")).toBeNull();
  });

  it("keeps sentence punctuation outside a multi-segment path mention", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Review @docs/foo.test.ts.",
        titleFallback: "Review @docs/foo.test.ts.",
      }),
    });

    expect(screen.getByTitle("docs/foo.test.ts")).not.toBeNull();
    expect(
      container
        .querySelector('[data-prompt-mention="true"]')
        ?.getAttribute("data-prompt-mention-serialized-text"),
    ).toBe("@docs/foo.test.ts");
    expect(container.textContent).toBe("Review foo.test.ts.");
  });

  it("uses the circle-question glyph when the thread needs user input", () => {
    renderThreadRow({
      thread: createThread({ hasPendingInteraction: true }),
    });

    expect(
      screen
        .getByLabelText("Thread needs user input")
        .getAttribute("data-icon"),
    ).toBe("CircleQuestion");
  });

  it("clocks a thread with queued work, and drops the clock once it runs", () => {
    const { rerenderThreadRow } = renderThreadRow({
      thread: createThread({ queuedWork: "waiting" }),
    });

    expect(
      screen
        .getByLabelText("Thread has a message waiting to send")
        .getAttribute("data-icon"),
    ).toBe("Clock");

    rerenderThreadRow(
      createThread({
        queuedWork: "waiting",
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }),
    );
    expect(
      screen.queryByLabelText("Thread has a message waiting to send"),
    ).toBeNull();
    expect(
      screen.getByLabelText("Thread working").getAttribute("data-icon"),
    ).toBe("Loading");
  });

  it("gives a failed queued row the same glyph a failed thread gets", () => {
    renderThreadRow({ thread: createThread({ queuedWork: "failed" }) });
    const queueFailure = screen.getByLabelText("Queued message failed to send");

    cleanup();
    renderThreadRow({
      thread: createThread({
        status: "error",
        lastReadAt: 0,
        latestAttentionAt: 10,
      }),
    });
    const threadFailure = screen.getByLabelText("Unread thread failed");

    expect(queueFailure.getAttribute("data-icon")).toBe("CircleX");
    expect(threadFailure.getAttribute("data-icon")).toBe(
      queueFailure.getAttribute("data-icon"),
    );
    expect(queueFailure.getAttribute("class")).toBe(
      threadFailure.getAttribute("class"),
    );
  });

  it("keeps the parent-thread disclosure caret visible on mobile", () => {
    renderThreadRow({
      thread: createThread({ title: "Parent thread" }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: false,
        childCount: 1,
        childActivity: {
          pending: false,
          working: false,
          hasUnsubmittedDraft: false,
          runtimeWorking: false,
          workflow: false,
          backgroundAgent: false,
          backgroundCommand: false,
          planMode: false,
          goal: false,
          unread: false,
          unreadError: false,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(
      screen
        .getByRole("button", { name: "Collapse Parent thread threads" })
        .getAttribute("data-sidebar-hover-actions-mobile"),
    ).toBe("always");
  });

  it.each([
    { isCollapsed: true, expectedHoverReveal: false },
    { isCollapsed: false, expectedHoverReveal: true },
  ])(
    "sets parent-thread disclosure hover reveal to $expectedHoverReveal when collapsed is $isCollapsed",
    ({ expectedHoverReveal, isCollapsed }) => {
      renderThreadRow({
        thread: createThread({ title: "Parent thread" }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed,
          childCount: 1,
          childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
          onToggleCollapsed: vi.fn(),
        },
      });

      const toggle = screen.getByRole("button", {
        name: `${isCollapsed ? "Expand" : "Collapse"} Parent thread threads`,
      });
      expect(toggle.classList.contains("bb-sidebar-hover-actions")).toBe(
        expectedHoverReveal,
      );
    },
  );

  it("shows its Command shortcut in place of an active indicator", () => {
    renderThreadRow({
      shortcutKey: "3",
      thread: createThread({
        status: "active",
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    });

    const shortcut = screen.getByText("⌘3");
    expect(shortcut.className).toContain("px-1.5");
    expect(shortcut.className).toContain("py-1");
    expect(shortcut.className).toContain("opacity-60");
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Open Thread" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Meta+3");
  });

  it("shows the pending-input glyph while the runtime is still active", () => {
    renderThreadRow({
      thread: createThread({
        hasPendingInteraction: true,
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    });

    expect(screen.getByLabelText("Thread needs user input")).not.toBeNull();
    expect(screen.queryByLabelText("Thread working")).toBeNull();
  });

  it("shows runtime work before workflow and background work", () => {
    renderThreadRow({
      thread: createThread({
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
        runtime: {
          displayStatus: "active",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    });

    expect(screen.getByLabelText("Thread working")).not.toBeNull();
    expect(screen.queryByLabelText("Unread thread failed")).toBeNull();
    expect(screen.queryByLabelText("Thread needs user input")).toBeNull();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
    expect(screen.queryByLabelText("Background agent running")).toBeNull();
    expect(screen.queryByLabelText("Background command running")).toBeNull();
    expect(document.querySelector('[data-icon="Edit"]')).toBeNull();
  });

  it("shows an animated working-colored workflow glyph for an idle thread with an active workflow", () => {
    renderThreadRow({
      thread: createThread({
        title: "Workflow thread",
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    });

    const workflowIcon = screen.getByLabelText("Workflow running");
    const workflowIconClasses = Array.from(workflowIcon.classList);
    expect(workflowIconClasses).toContain("animate-shine-icon");
    expect(workflowIconClasses).toContain(SIDEBAR_WORKING_STATUS_COLOR_CLASS);
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it.each([
    ["activeWorkflowCount", "Workflow running"],
    ["activeBackgroundAgentCount", "Background agent running"],
    ["activeBackgroundCommandCount", "Background command running"],
  ] as const)(
    "shows runtime work before concurrent %s activity",
    (activityKey, secondaryLabel) => {
      renderThreadRow({
        thread: createThread({
          status: "active",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
            [activityKey]: 1,
          },
        }),
      });

      expect(screen.getByLabelText("Thread working")).not.toBeNull();
      expect(screen.queryByLabelText(secondaryLabel)).toBeNull();
    },
  );

  it.each([
    ["activePlanModeCount", "Plan mode active"],
    ["activeGoalCount", "Goal active"],
  ] as const)(
    "shows concurrent %s activity before runtime work",
    (activityKey, modeLabel) => {
      renderThreadRow({
        thread: createThread({
          status: "active",
          runtime: {
            displayStatus: "active",
            hostReconnectGraceExpiresAt: null,
          },
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
            [activityKey]: 1,
          },
        }),
      });

      expect(screen.getByLabelText(modeLabel)).not.toBeNull();
      expect(screen.queryByLabelText("Thread working")).toBeNull();
    },
  );

  it("shows an animated delegated-agent glyph for active background agent work", () => {
    renderThreadRow({
      thread: createThread({
        title: "Background agent thread",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    });

    const agentIcon = screen.getByLabelText("Background agent running");
    const agentIconClasses = Array.from(agentIcon.classList);
    expect(agentIcon.getAttribute("data-icon")).toBe("UserRoundPlus");
    expect(agentIconClasses).toContain("animate-shine-icon");
    expect(agentIconClasses).toContain(SIDEBAR_WORKING_STATUS_COLOR_CLASS);
    expect(screen.queryByLabelText("Background command running")).toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("shows workflow before background agent and command work", () => {
    renderThreadRow({
      thread: createThread({
        title: "Many background tasks thread",
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    });

    expect(screen.getByLabelText("Workflow running")).not.toBeNull();
    expect(screen.queryByLabelText("Background agent running")).toBeNull();
    expect(screen.queryByLabelText("Background command running")).toBeNull();
  });

  it("shows background agent work before background command work", () => {
    renderThreadRow({
      thread: createThread({
        title: "Agent and command thread",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    });

    expect(screen.getByLabelText("Background agent running")).not.toBeNull();
    expect(screen.queryByLabelText("Background command running")).toBeNull();
  });

  it("shows an animated terminal glyph for an active background command", () => {
    renderThreadRow({
      thread: createThread({
        title: "Background command thread",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 0,
          activeGoalCount: 0,
        },
      }),
    });

    const terminalIcon = screen.getByLabelText("Background command running");
    const terminalIconClasses = Array.from(terminalIcon.classList);
    expect(terminalIcon.getAttribute("data-icon")).toBe("Terminal");
    expect(terminalIconClasses).toContain("animate-shine-icon");
    expect(terminalIconClasses).toContain(SIDEBAR_WORKING_STATUS_COLOR_CLASS);
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("shows an animated plan-mode glyph when the plan banner is active", () => {
    renderThreadRow({
      thread: createThread({
        title: "Plan mode thread",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 1,
          activeGoalCount: 0,
        },
      }),
    });

    const planIcon = screen.getByLabelText("Plan mode active");
    const planIconClasses = Array.from(planIcon.classList);
    expect(planIcon.getAttribute("data-icon")).toBe("ListTodo");
    expect(planIconClasses).toContain("animate-shine-icon");
    expect(planIconClasses).toContain(SIDEBAR_WORKING_STATUS_COLOR_CLASS);
    expect(screen.queryByLabelText("Background command running")).toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("shows an animated goal glyph when the goal banner is active", () => {
    renderThreadRow({
      thread: createThread({
        title: "Goal thread",
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 1,
        },
      }),
    });

    const goalIcon = screen.getByLabelText("Goal active");
    const goalIconClasses = Array.from(goalIcon.classList);
    expect(goalIcon.getAttribute("data-icon")).toBe("Target");
    expect(goalIconClasses).toContain("animate-shine-icon");
    expect(goalIconClasses).toContain(SIDEBAR_WORKING_STATUS_COLOR_CLASS);
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
    expect(screen.queryByLabelText("Agent working")).toBeNull();
  });

  it("shows Plan before a concurrent Goal", () => {
    renderThreadRow({
      thread: createThread({
        activity: {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 1,
          activeGoalCount: 1,
        },
      }),
    });

    expect(screen.getByLabelText("Plan mode active")).not.toBeNull();
    expect(screen.queryByLabelText("Goal active")).toBeNull();
  });

  it.each([
    {
      flag: "workflow" as const,
      label: "Workflow running",
      icon: "Workflow",
    },
    {
      flag: "backgroundAgent" as const,
      label: "Background agent running",
      icon: "UserRoundPlus",
    },
    {
      flag: "backgroundCommand" as const,
      label: "Background command running",
      icon: "Terminal",
    },
    {
      flag: "planMode" as const,
      label: "Plan mode active",
      icon: "ListTodo",
    },
    {
      flag: "goal" as const,
      label: "Goal active",
      icon: "Target",
    },
  ])(
    "shows the $label glyph for collapsed parent rows with hidden child activity",
    ({ flag, icon, label }) => {
      renderThreadRow({
        thread: createThread({
          title: "Parent thread",
          lastReadAt: 1,
          latestAttentionAt: 1,
        }),
        options: {
          kind: "parent",
          depth: 1,
          isCompact: false,
          isCollapsed: true,
          childCount: 1,
          childActivity: {
            pending: false,
            working: true,
            hasUnsubmittedDraft: false,
            runtimeWorking: false,
            workflow: false,
            backgroundAgent: false,
            backgroundCommand: false,
            planMode: false,
            goal: false,
            unread: false,
            unreadError: false,
            [flag]: true,
          },
          onToggleCollapsed: vi.fn(),
        },
      });

      expect(screen.getByLabelText(label).getAttribute("data-icon")).toBe(icon);
      expect(screen.queryByLabelText("Thread working")).toBeNull();
    },
  );

  it("shows a working draft for collapsed descendants before named work", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      options: {
        kind: "parent",
        depth: 1,
        isCompact: false,
        isCollapsed: true,
        childCount: 1,
        childActivity: {
          pending: false,
          working: true,
          hasUnsubmittedDraft: true,
          runtimeWorking: false,
          workflow: false,
          backgroundAgent: false,
          backgroundCommand: false,
          planMode: true,
          goal: true,
          unread: false,
          unreadError: false,
        },
        onToggleCollapsed: vi.fn(),
      },
    });

    expect(
      screen.getByLabelText("Thread working with unsubmitted draft"),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });

  it("renders an already-unread successful thread as a settled dot on initial load", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
      }),
    });

    expect(screen.getByLabelText("Unread thread succeeded")).not.toBeNull();
    expect(container.querySelector('[data-icon="CircleCheck"]')).toBeNull();
  });

  it("switches directly from working to the settled done dot after finishing", () => {
    const thread = createThread({
      status: "active",
      lastReadAt: 1_000,
      latestAttentionAt: 1_000,
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
    });
    const { container, rerenderThreadRow } = renderThreadRow({ thread });

    expect(screen.getByLabelText("Thread working")).not.toBeNull();

    rerenderThreadRow({
      ...thread,
      status: "idle",
      latestAttentionAt: 2_000,
      runtime: {
        displayStatus: "idle",
        hostReconnectGraceExpiresAt: null,
      },
    });

    expect(container.querySelector('[data-icon="CircleCheck"]')).toBeNull();
    expect(screen.getByLabelText("Unread thread succeeded")).not.toBeNull();
  });

  it("edits the row title inline after a double click and commits on Enter", () => {
    renderThreadRow({
      thread: createThread({ title: "Thread", titleFallback: "Thread" }),
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    expect(input).toHaveProperty("value", "Thread");

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.renameThread).toHaveBeenCalledWith(
      "thr_test",
      "Renamed thread",
    );
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Thread")).not.toBeNull();
  });

  it("cancels an inline row rename on Escape without saving", () => {
    renderThreadRow({
      thread: createThread({ title: "Thread", titleFallback: "Thread" }),
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = screen.getByRole("textbox", { name: "Thread name" });
    fireEvent.change(input, { target: { value: "Scratch name" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mocks.renameThread).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Thread")).not.toBeNull();
  });

  it("starts a rename from a second click after the row remounts", () => {
    const thread = createThread({ title: "Thread", titleFallback: "Thread" });
    const { rerenderThreadRow } = renderThreadRow({ thread });
    const link = screen.getByRole("link", { name: "Open Thread" });

    fireEvent.click(link);
    rerenderThreadRow(thread);
    fireEvent.click(screen.getByRole("link", { name: "Open Thread" }));

    expect(screen.getByRole("textbox", { name: "Thread name" })).toHaveProperty(
      "value",
      "Thread",
    );
  });
});
