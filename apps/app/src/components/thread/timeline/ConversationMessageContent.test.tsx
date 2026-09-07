// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  MessageDirectiveRegistryProvider,
  type MessageDirectiveRegistry,
} from "@/components/ui/markdown-message-directives";
import { ConversationMessageContent } from "./ConversationMessageContent";
import { USER_MESSAGE_CHAR_CAP } from "@bb/client-core";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry as makeThreadListEntryFixture } from "@bb/test-helpers/domain-fixtures";

afterEach(cleanup);

function threadListEntry(
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

describe("ConversationMessageContent assistant images", () => {
  it("serves local Markdown images through the thread host-file route", () => {
    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ConversationMessageContent
            role="assistant"
            attachments={null}
            id="msg_image"
            threadId="thr_image"
            turnId="turn_image"
            showActions={false}
            mobileActionDisplay="overflow"
            streaming={false}
            text="![Generated diagram](/workspace/output/diagram.png)"
          />
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("img", { name: "Generated diagram" })
        .getAttribute("src"),
    ).toBe(
      "/api/v1/threads/thr_image/host-files/content?path=%2Fworkspace%2Foutput%2Fdiagram.png",
    );
  });
});

describe("ConversationMessageContent assistant thread mentions", () => {
  it("renders an agent-authored thread token with the referenced thread title", () => {
    const mentionedThread = threadListEntry({
      id: "thr_xpxxt2ipz8",
      projectId: "proj_personal",
      title: "Plugin composer support on root new-thread page",
    });
    const messageDirectiveRegistry: MessageDirectiveRegistry = new Map([
      [
        "inline-vis",
        { status: "collision", pluginIds: ["plugin-a", "plugin-b"] },
      ],
    ]);

    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <MessageDirectiveRegistryProvider
              registry={messageDirectiveRegistry}
            >
              <ConversationMessageContent
                role="assistant"
                attachments={null}
                id="msg_spawned"
                threadId="thr_parent"
                turnId="turn_spawned"
                showActions={false}
                mobileActionDisplay="overflow"
                streaming={false}
                text="Spawned and parented: @thread:thr_xpxxt2ipz8"
              />
            </MessageDirectiveRegistryProvider>
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    const mentionLink = screen.getByRole("link", {
      name: "Plugin composer support on root new-thread page",
    });
    expect(mentionLink.getAttribute("href")).toBe("/threads/thr_xpxxt2ipz8");
    expect(screen.queryByText("@thread", { exact: false })).toBeNull();
  });
});

describe("ConversationMessageContent long user messages", () => {
  const rawThreadId = "thr_dcwivn5n8w";
  const mentionedThread = threadListEntry({
    id: rawThreadId,
    projectId: "proj_target",
    title: "Should stay code",
  });

  function renderLongUserMessage(text: string) {
    const { wrapper } = createQueryClientTestHarness();
    return render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <ConversationMessageContent
              role="user"
              attachments={null}
              originKind={null}
              initiator="user"
              mentions={[]}
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              systemMessageKind="unlabeled"
              systemMessageSubject={null}
              text={text}
              turnRequest={{
                isGrouped: false,
                kind: "message",
                status: "accepted",
              }}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
      { wrapper },
    );
  }

  it("renders the complete message after expanding a capped preview", () => {
    const hiddenTail = "FULL_MESSAGE_TAIL";
    const text = `${"a".repeat(USER_MESSAGE_CHAR_CAP)}\n\n${hiddenTail}`;

    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ConversationMessageContent
            role="user"
            attachments={null}
            originKind={null}
            initiator="user"
            mentions={[]}
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text={text}
            turnRequest={{
              isGrouped: false,
              kind: "message",
              status: "accepted",
            }}
          />
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByText(hiddenTail)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.getByText(hiddenTail)).not.toBeNull();
    expect(screen.queryByText("[truncated]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(screen.queryByText(hiddenTail)).toBeNull();
  });

  it("does not manufacture a pill when an inline-code span crosses the collapsed cap", () => {
    const text = `\`${rawThreadId} ${"x".repeat(USER_MESSAGE_CHAR_CAP)}\` tail`;
    const { container } = renderLongUserMessage(text);

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain(rawThreadId);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain(rawThreadId);
  });

  it("does not close a capped mixed code span into an exact raw-id pill", () => {
    const prefix = "x".repeat(USER_MESSAGE_CHAR_CAP - rawThreadId.length - 1);
    const text = `${prefix}\`${rawThreadId} remains mixed\` tail`;
    const { container } = renderLongUserMessage(text);

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toContain(`\`${rawThreadId}`);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      `${rawThreadId} remains mixed`,
    );
  });

  it("preserves unmatched backticks in short and fully expanded messages", () => {
    const shortView = renderLongUserMessage("hello `world");

    expect(shortView.container.querySelector("code")).toBeNull();
    expect(shortView.container.textContent).toContain("hello `world");
    shortView.unmount();

    const longText = `hello \`world ${"tail ".repeat(USER_MESSAGE_CHAR_CAP)}`;
    const longView = renderLongUserMessage(longText);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(longView.container.querySelector("code")).toBeNull();
    expect(longView.container.textContent).toContain("hello `world");
  });

  it("does not manufacture a pill when a path suffix falls beyond the collapsed cap", () => {
    const prefix = `${"a".repeat(
      USER_MESSAGE_CHAR_CAP - rawThreadId.length - 1,
    )} `;
    const text = `${prefix}${rawThreadId}/path`;
    const { container } = renderLongUserMessage(text);

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.textContent).not.toContain(rawThreadId);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(screen.queryByRole("link", { name: "Should stay code" })).toBeNull();
    expect(container.textContent).toContain(`${rawThreadId}/path`);
  });
});

describe("ConversationMessageContent user thread mentions", () => {
  it("renders an exact raw thread id inline-code span as a linked mention pill", () => {
    const mentionedThread = threadListEntry({
      id: "thr_dcwivn5n8w",
      projectId: "proj_personal",
      title: "Inline user mention target",
    });

    const { container } = render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <ConversationMessageContent
              role="user"
              attachments={null}
              originKind={null}
              initiator="user"
              mentions={[]}
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              systemMessageKind="unlabeled"
              systemMessageSubject={null}
              text="Use `thr_dcwivn5n8w` for the follow-up."
              turnRequest={{
                isGrouped: false,
                kind: "message",
                status: "accepted",
              }}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Inline user mention target" }),
    ).not.toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });

  it("renders a raw thread id in message text as a linked mention pill", () => {
    const mentionedThread = threadListEntry({
      id: "thr_dcwivn5n8w",
      projectId: "proj_personal",
      title: "Raw ID mention target",
    });

    const { wrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <ConversationMessageContent
              role="user"
              attachments={null}
              originKind={null}
              initiator="user"
              mentions={[]}
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              systemMessageKind="unlabeled"
              systemMessageSubject={null}
              text="Continue in thr_dcwivn5n8w when this is ready."
              turnRequest={{
                isGrouped: false,
                kind: "message",
                status: "accepted",
              }}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
      { wrapper },
    );

    const mentionLink = screen.getByRole("link", {
      name: "Raw ID mention target",
    });
    expect(mentionLink.getAttribute("href")).toBe("/threads/thr_dcwivn5n8w");
    expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
  });

  it("renders a raw thread token as the canonical pill when structured mentions are empty", () => {
    const mentionedThread = threadListEntry({
      id: "thr_ti4st72wgs",
      projectId: "proj_personal",
      title: "Mention pill QA thread",
    });

    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <ConversationMessageContent
              role="user"
              attachments={null}
              originKind={null}
              initiator="user"
              mentions={[]}
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              systemMessageKind="unlabeled"
              systemMessageSubject={null}
              text="Why was @thread:thr_ti4st72wgs not a pill?"
              turnRequest={{
                isGrouped: false,
                kind: "message",
                status: "accepted",
              }}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    const mentionLink = screen.getByRole("link", {
      name: "Mention pill QA thread",
    });
    expect(mentionLink.getAttribute("href")).toBe("/threads/thr_ti4st72wgs");
    expect(screen.queryByText("@thread", { exact: false })).toBeNull();
  });

  it("routes a raw thread token through the target thread project", () => {
    const mentionedThread = threadListEntry({
      id: "thr_cross_project",
      projectId: "proj_target",
      title: "Cross-project mention",
    });

    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map([[mentionedThread.id, mentionedThread]])}
          >
            <ConversationMessageContent
              role="user"
              attachments={null}
              originKind={null}
              initiator="user"
              mentions={[]}
              resolveSegmentLinkHref={(link) =>
                link.kind === "thread"
                  ? `/projects/proj_current/threads/${link.threadId}`
                  : null
              }
              senderThreadId={null}
              senderThreadTitle={null}
              senderIsPluginSideChat={false}
              systemMessageKind="unlabeled"
              systemMessageSubject={null}
              text="See @thread:thr_cross_project for the result."
              turnRequest={{
                isGrouped: false,
                kind: "message",
                status: "accepted",
              }}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );

    expect(
      screen
        .getByRole("link", { name: "Cross-project mention" })
        .getAttribute("href"),
    ).toBe("/projects/proj_target/threads/thr_cross_project");
  });
});
