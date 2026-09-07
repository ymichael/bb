// @vitest-environment jsdom

import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PromptTextMention } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type { TimelineTitleLink } from "@bb/thread-view";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  ThreadTitleMentionResourcesProvider,
  ThreadTitleMentions,
} from "@/components/thread/ThreadTitleMentions";
import {
  type MarkdownMessageDirectives,
  type MessageDirectiveRegistry,
} from "@/components/ui/markdown-message-directives";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { setPreferredTheme } from "@/hooks/useTheme";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        get: vi.fn(() => Promise.reject(new Error("Thread not found"))),
        resolveMentions: vi.fn(async () => []),
      },
    },
  };
});

function markdownTree(node: ReactNode) {
  return (
    <MemoryRouter>
      <RouteNavigationProvider>{node}</RouteNavigationProvider>
    </MemoryRouter>
  );
}

function resolveThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}`
    : null;
}

function resolveUpdatedThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}?updated=1`
    : null;
}

function threadResponse(
  overrides: Partial<ThreadResponse> = {},
): ThreadResponse {
  return makeThreadResponse({
    id: "thr_child",
    projectId: "proj_demo",
    environmentId: null,
    title: "Rebuild comments",
    titleFallback: "Rebuild comments",
    lastReadAt: 0,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function renderMarkdown(
  node: ReactNode,
  cachedThreads: readonly ThreadResponse[] = [threadResponse()],
) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  for (const thread of cachedThreads) {
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
  }
  const threadById = new Map(
    cachedThreads.map((thread) => [
      thread.id,
      makeThreadListEntry({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        titleFallback: thread.titleFallback,
      }),
    ]),
  );
  return {
    ...render(
      markdownTree(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={threadById}
        >
          {node}
        </ThreadTitleMentionResourcesProvider>,
      ),
      { wrapper },
    ),
    queryClient,
  };
}

const THREAD_MENTION: PromptTextMention = {
  start: 0,
  end: "@thread:thr_child".length,
  resource: {
    kind: "thread",
    threadId: "thr_child",
    projectId: "proj_demo",
    label: "Rebuild comments",
  },
};

const UPDATED_THREAD_MENTION: PromptTextMention = {
  ...THREAD_MENTION,
  resource: {
    ...THREAD_MENTION.resource,
    label: "Updated child",
  },
};

const MESSAGE_DIRECTIVE_REGISTRY: MessageDirectiveRegistry = new Map([
  ["inline-vis", { status: "collision", pluginIds: ["plugin-a", "plugin-b"] }],
]);

const ACTIVE_MESSAGE_DIRECTIVES: MarkdownMessageDirectives = {
  registry: MESSAGE_DIRECTIVE_REGISTRY,
  message: {
    id: "msg_thread_mention",
    threadId: "thr_parent",
    turnId: "turn_thread_mention",
    projectId: "proj_demo",
  },
  openWorkspaceFile: null,
  openThreadPanel: null,
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  setPreferredTheme("system");
});

describe("MarkdownPreview thread mentions", () => {
  it("leaves an unresolvable raw thread id as text", async () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="Continue in thr_2222222222 when this is ready."
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    });

    expect(container.textContent).toContain("thr_2222222222");
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("resolves many unknown raw ids in one bounded request", async () => {
    const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
    const threadIds = Array.from({ length: 40 }, (_, index) => {
      const high = alphabet[Math.floor(index / alphabet.length)] ?? "2";
      const low = alphabet[index % alphabet.length] ?? "2";
      return `thr_22222222${high}${low}`;
    });
    const content = [...threadIds, threadIds[0]].join(" ");
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={content}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    });
    const request = vi.mocked(sdk.threads.resolveMentions).mock.calls[0]?.[0];
    expect(request?.threadIds).toEqual(threadIds.slice(0, 32));
    expect(new Set(request?.threadIds).size).toBe(32);
    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(container.textContent).toBe(content);
  });

  it("renders an exact raw-id inline-code span as a linked pill", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="`thr_dcwivn5n8w`"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Inline code target",
          titleFallback: "Inline code target",
        }),
      ],
    );

    const pill = screen.getByRole("link", { name: "Inline code target" });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(container.querySelector("code")).toBeNull();
    expect(sdk.threads.resolveMentions).not.toHaveBeenCalled();
  });

  it("renders a standalone formatted raw id as a linked pill", () => {
    renderMarkdown(
      <MarkdownPreview
        content="Continue in **thr_dcwivn5n8w**."
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Formatted target",
          titleFallback: "Formatted target",
        }),
      ],
    );

    expect(
      screen.getByRole("link", { name: "Formatted target" }),
    ).not.toBeNull();
  });

  it("leaves an unresolvable exact raw-id inline-code span as code", async () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="`thr_2222222222`"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    });

    expect(container.querySelector("code")?.textContent).toBe("thr_2222222222");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("leaves mixed inline code and fenced code untouched", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={[
          "Run `bb thread show thr_dcwivn5n8w`.",
          "",
          "```text",
          "thr_dcwivn5n8w",
          "```",
        ].join("\n")}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          title: "Known code target",
          titleFallback: "Known code target",
        }),
      ],
    );

    const codeNodes = container.querySelectorAll("code");
    expect(codeNodes).toHaveLength(2);
    expect(
      Array.from(codeNodes).every((node) =>
        node.textContent?.includes("thr_dcwivn5n8w"),
      ),
    ).toBe(true);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("matches only the exact thread id prefix, alphabet, length, and boundaries", () => {
    const untouched = [
      "env_dcwivn5n8w",
      "thr_dcwivn5n8o",
      "thr_dcwivn5n8",
      "thr_dcwivn5n8w2",
      "prefixthr_dcwivn5n8w",
      "thr_dcwivn5n8w.md",
      "thr_dcwivn5n8w/path",
      "/tmp/thr_dcwivn5n8w",
      "docs/thr_dcwivn5n8w",
      "C:\\tmp\\thr_dcwivn5n8w",
      "docs\\thr_dcwivn5n8w",
      "thr_dcwivn5n8w\\logs",
    ].join(" ");
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={untouched}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
    );

    expect(container.textContent).toBe(untouched);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(sdk.threads.resolveMentions).not.toHaveBeenCalled();
  });

  it("checks raw-id boundaries across formatting and Markdown link labels", () => {
    const id = "thr_dcwivn5n8w";
    const content = [
      `prefix**${id}**`,
      `/tmp/**${id}**`,
      `docs/**${id}**`,
      String.raw`C:\\tmp\\**${id}**`,
      String.raw`docs\\**${id}**`,
      `**${id}**/logs`,
      String.raw`**${id}**\\logs`,
      `[prefix**${id}**](https://example.com/word)`,
      `[/tmp/**${id}**](https://example.com/unix)`,
      `[**${id}**/logs](https://example.com/continuation)`,
      String.raw`[C:\\tmp\\**${id}**](https://example.com/windows)`,
    ].join("\n\n");
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={content}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    expect(container.textContent).toContain(`prefix${id}`);
    expect(container.textContent).toContain(`/tmp/${id}`);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(sdk.threads.resolveMentions).not.toHaveBeenCalled();
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("preserves the existing serialized mention behavior before a backslash", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="@thread:thr_child\\logs"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Rebuild comments" }),
    ).not.toBeNull();
    expect(container.textContent).toContain("Rebuild comments\\logs");
    expect(sdk.threads.resolveMentions).not.toHaveBeenCalled();
  });

  it.each([
    ["straight closing quote", 'He said "Continue in thr_dcwivn5n8w."'],
    ["curly closing quote", "He said “Continue in thr_dcwivn5n8w.”"],
  ])(
    "recognizes a sentence-final raw thread id before a %s",
    (_label, content) => {
      renderMarkdown(
        <MarkdownPreview
          content={content}
          threadMentions={{ mentions: [], preserveSoftBreaks: true }}
        />,
        [
          threadResponse({
            id: "thr_dcwivn5n8w",
            projectId: "proj_target",
            title: "Quoted target",
            titleFallback: "Quoted target",
          }),
        ],
      );

      expect(
        screen
          .getByRole("link", { name: "Quoted target" })
          .getAttribute("href"),
      ).toBe("/projects/proj_target/threads/thr_dcwivn5n8w");
    },
  );

  it("routes a known raw id through its resolved project instead of the timeline resolver", () => {
    renderMarkdown(
      <MarkdownPreview
        content="Continue in thr_dcwivn5n8w."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Cross-project raw target",
          titleFallback: "Cross-project raw target",
        }),
      ],
    );

    expect(
      screen
        .getByRole("link", { name: "Cross-project raw target" })
        .getAttribute("href"),
    ).toBe("/projects/proj_target/threads/thr_dcwivn5n8w");
  });

  it("routes a batch-resolved raw id through the queried thread project", async () => {
    vi.mocked(sdk.threads.resolveMentions).mockResolvedValueOnce([
      {
        threadId: "thr_dcwivn5n8w",
        projectId: "proj_target",
        label: "Queried cross-project target",
      },
    ]);
    renderMarkdown(
      <MarkdownPreview
        content="Continue in thr_dcwivn5n8w."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [],
    );

    const pill = await screen.findByRole("link", {
      name: "Queried cross-project target",
    });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    expect(sdk.threads.resolveMentions).toHaveBeenCalledWith(
      expect.objectContaining({ threadIds: ["thr_dcwivn5n8w"] }),
    );
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("resolves raw ids introduced by a later streamed render without requesting earlier ids again", async () => {
    const firstId = "thr_2222222222";
    const secondId = "thr_2222222223";
    vi.mocked(sdk.threads.resolveMentions)
      .mockResolvedValueOnce([
        {
          threadId: firstId,
          projectId: "proj_target",
          label: "First streamed target",
        },
      ])
      .mockResolvedValueOnce([
        {
          threadId: secondId,
          projectId: "proj_target",
          label: "Later streamed target",
        },
      ]);
    const { wrapper } = createQueryClientTestHarness();
    const renderTree = (content: string) =>
      markdownTree(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map()}
        >
          <MarkdownPreview
            content={content}
            threadMentions={{ mentions: [], preserveSoftBreaks: true }}
          />
        </ThreadTitleMentionResourcesProvider>,
      );
    const view = render(renderTree(`First ${firstId}`), { wrapper });

    expect(
      await screen.findByRole("link", { name: "First streamed target" }),
    ).not.toBeNull();
    view.rerender(renderTree(`First ${firstId}; later ${secondId}`));

    expect(
      await screen.findByRole("link", { name: "Later streamed target" }),
    ).not.toBeNull();
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(sdk.threads.resolveMentions).mock.calls[0]?.[0].threadIds,
    ).toEqual([firstId]);
    expect(
      vi.mocked(sdk.threads.resolveMentions).mock.calls[1]?.[0].threadIds,
    ).toEqual([secondId]);
  });

  it("reschedules an uncached raw-id batch after the StrictMode effect cycle", async () => {
    const threadId = "thr_2222222222";
    vi.mocked(sdk.threads.resolveMentions).mockResolvedValueOnce([
      {
        threadId,
        projectId: "proj_target",
        label: "Strict mode target",
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    render(
      <StrictMode>
        {markdownTree(
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map()}
          >
            <MarkdownPreview
              content={`Continue in ${threadId}`}
              threadMentions={{ mentions: [], preserveSoftBreaks: true }}
            />
          </ThreadTitleMentionResourcesProvider>,
        )}
      </StrictMode>,
      { wrapper },
    );

    expect(
      await screen.findByRole("link", { name: "Strict mode target" }),
    ).not.toBeNull();
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
  });

  it("retries a failed title mention batch once", async () => {
    vi.useFakeTimers();
    try {
      const threadId = "thr_2222222222";
      vi.mocked(sdk.threads.resolveMentions)
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockRejectedValueOnce(new Error("temporary failure"));
      renderMarkdown(
        <ThreadTitleMentions title={`Review @thread:${threadId}`} />,
        [],
      );

      await act(async () => vi.advanceTimersByTimeAsync(60));
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an omitted title mention unavailable", async () => {
    const threadId = "thr_2222222222";
    vi.mocked(sdk.threads.resolveMentions).mockResolvedValueOnce([]);
    renderMarkdown(
      <ThreadTitleMentions title={`Review @thread:${threadId}`} />,
      [],
    );

    expect(await screen.findByText("Unavailable thread")).not.toBeNull();
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
  });

  it("shares one raw-id resolution across sibling messages and a title", async () => {
    const threadId = "thr_2222222222";
    vi.mocked(sdk.threads.resolveMentions).mockResolvedValueOnce([
      {
        threadId,
        projectId: "proj_target",
        label: "Shared mention target",
      },
    ]);
    const { wrapper } = createQueryClientTestHarness();
    const tree = markdownTree(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map()}
      >
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map()}
        >
          <ThreadTitleMentions title={`Title ${threadId}`} />
        </ThreadTitleMentionResourcesProvider>
        <MarkdownPreview
          content={`Message one ${threadId}`}
          threadMentions={{ mentions: [], preserveSoftBreaks: true }}
        />
        <MarkdownPreview
          content={`Message two ${threadId}`}
          threadMentions={{ mentions: [], preserveSoftBreaks: true }}
        />
      </ThreadTitleMentionResourcesProvider>,
    );
    const view = render(tree, { wrapper });

    await waitFor(() => {
      expect(screen.getAllByText("Shared mention target")).toHaveLength(3);
    });
    expect(
      screen.getAllByRole("link", { name: "Shared mention target" }),
    ).toHaveLength(2);
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);

    view.rerender(tree);
    await act(async () => Promise.resolve());
    expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
  });

  it("resolves and links a thread absent from sidebar resources through the authoritative thread query", () => {
    const queriedThread = threadResponse({
      id: "thr_archived",
      projectId: "proj_archive",
      title: "Archived investigation",
      titleFallback: "Archived investigation",
      archivedAt: 10,
    });
    renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_archived for the report."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
        }}
      />,
      [queriedThread],
    );

    const pill = screen.getByText("Archived investigation").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_archive/threads/thr_archived",
    );
  });

  it("updates rendered mention pills when thread mention props change without content changing", () => {
    const { queryClient, rerender } = renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_child for the report."
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
    );

    expect(screen.getByText("Rebuild comments")).toBeTruthy();

    act(() => {
      queryClient.setQueryData(
        threadQueryKey("thr_child"),
        threadResponse({ title: "Updated child" }),
      );
    });

    rerender(
      markdownTree(
        <MarkdownPreview
          content="See @thread:thr_child for the report."
          threadMentions={{
            mentions: [UPDATED_THREAD_MENTION],
            preserveSoftBreaks: true,
            resolveLinkHref: resolveUpdatedThreadLink,
          }}
        />,
      ),
    );

    expect(screen.queryByText("Rebuild comments")).toBeNull();
    const pill = screen.getByText("Updated child").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_demo/threads/thr_child?updated=1",
    );
  });

  it("falls back to the thread id when no mention resource matches", () => {
    renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_unknown please."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_unknown",
          title: "thr_unknown",
          titleFallback: "thr_unknown",
        }),
      ],
    );

    const pill = screen.getByText("thr_unknown").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_demo/threads/thr_unknown",
    );
  });

  it("leaves a labeled text directive on the authored directive rendering path", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="@thread:thr_child[label]"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe("@thread:thr_child[label]");
    expect(paragraph?.querySelector("a")).toBeNull();
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves an attributed text directive on the authored directive rendering path", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="@thread:thr_child{#authored-directive}"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(
      "@thread:thr_child{#authored-directive}",
    );
    expect(paragraph?.querySelector("a")).toBeNull();
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves a raw thread token inside an authored Markdown link", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[@thread:thr_child](https://example.com)"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "@thread:thr_child" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("replaces a resolvable raw-id Markdown link label with one thread pill", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[thr_dcwivn5n8w](https://example.com)"
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Linked-label target",
          titleFallback: "Linked-label target",
        }),
      ],
    );

    const pill = screen.getByRole("link", { name: "Linked-label target" });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(pill.querySelector("a")).toBeNull();
  });

  it("lifts a raw id out of a mixed authored Markdown link label", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[Open thr_dcwivn5n8w details](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Mixed-label target",
          titleFallback: "Mixed-label target",
        }),
      ],
    );

    const pill = screen.getByRole("link", { name: "Mixed-label target" });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(
      screen.getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("https://example.com");
    expect(
      screen.getByRole("link", { name: "details" }).getAttribute("href"),
    ).toBe("https://example.com");
    expect(pill.querySelector("a")).toBeNull();
  });

  it("replaces a formatted raw-id Markdown link label without nesting links", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[**thr_dcwivn5n8w**](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Formatted-label target",
          titleFallback: "Formatted-label target",
        }),
      ],
    );

    const pill = screen.getByRole("link", { name: "Formatted-label target" });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(pill.querySelector("a")).toBeNull();
  });

  it("keeps a raw id in an authored code-span link label untouched", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[`thr_dcwivn5n8w`](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          title: "Code-label target",
          titleFallback: "Code-label target",
        }),
      ],
    );

    const link = screen.getByRole("link", { name: "thr_dcwivn5n8w" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.querySelector("code")).not.toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("preserves an unresolvable raw-id Markdown link", async () => {
    renderMarkdown(
      <MarkdownPreview
        content="[thr_2222222222](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    });

    const link = screen.getByRole("link", { name: "thr_2222222222" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("preserves one external link for an unresolvable raw id in a mixed label", async () => {
    renderMarkdown(
      <MarkdownPreview
        content="[Open thr_2222222222 details](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(sdk.threads.resolveMentions).toHaveBeenCalledTimes(1);
    });

    const link = screen.getByRole("link", {
      name: "Open thr_2222222222 details",
    });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("reconstructs a directive-split thread token inside an authored Markdown link", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[@thread:thr_child](https://example.com)"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    const link = screen.getByRole("link", { name: "@thread:thr_child" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves assistant content (no mentions prop) untouched — token stays literal", () => {
    renderMarkdown(
      <MarkdownPreview content="See @thread:thr_child for the report." />,
    );

    expect(screen.queryByText("Rebuild comments")).toBeNull();
    expect(
      screen.getByText(/@thread:thr_child/u, { exact: false }),
    ).toBeTruthy();
  });

  it.each([
    ["without message directives", undefined],
    ["with message directives", ACTIVE_MESSAGE_DIRECTIVES],
  ])("uses complete token boundaries %s", (_label, messageDirectives) => {
    const content =
      "foo@thread:thr_embedded @thread:thr_continued/path @thread:thr_child";
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={content}
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={messageDirectives}
      />,
    );

    expect(screen.getAllByText("Rebuild comments")).toHaveLength(1);
    expect(container.textContent).toContain("foo@thread:thr_embedded");
    expect(container.textContent).toContain("@thread:thr_continued/path");
  });
});
