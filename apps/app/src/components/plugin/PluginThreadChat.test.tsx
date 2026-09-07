// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { PluginSlotMount } from "./PluginSlotMount";

const mocks = vi.hoisted(() => ({
  embeddedChatProps: [] as Array<Record<string, unknown>>,
  timelinePanelProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { get: vi.fn() },
    environments: { get: vi.fn() },
    providers: { list: vi.fn(async () => []) },
  },
  BbHttpError: class BbHttpError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useHostListRealtimeSubscription: vi.fn(),
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
  useEnvironmentDetailRealtimeSubscription: vi.fn(),
  useSystemRealtimeSubscription: vi.fn(),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ isLocalDaemonHost: () => true }),
}));

vi.mock("@/components/thread/embedded-chat", () => ({
  EmbeddedThreadChat: (props: Record<string, unknown>) => {
    mocks.embeddedChatProps.push(props);
    return <div data-testid="embedded-thread-chat" />;
  },
}));

vi.mock("@/components/thread/timeline", () => ({
  ThreadTimelinePanelContent: (props: Record<string, unknown>) => {
    mocks.timelinePanelProps.push(props);
    return <div data-testid="timeline-panel-content" />;
  },
}));

const THREAD_FIXTURE = {
  id: "thr_demo",
  projectId: "proj_demo",
  providerId: "provider_demo",
  environmentId: null,
  status: "active",
  runtime: { displayStatus: "idle" },
};

function DemoPluginPage({ threadId }: { threadId: string }) {
  const ThreadChat = pluginSdkAppImplementation.ThreadChat;
  return <ThreadChat threadId={threadId} variant="compact" />;
}

function DemoPluginPageWithExtensions({
  threadId,
  run,
}: {
  threadId: string;
  run: () => void;
}) {
  const ThreadChat = pluginSdkAppImplementation.ThreadChat;
  return (
    <ThreadChat
      threadId={threadId}
      variant="compact"
      leadingContent={<div data-testid="replying-to">Replying to</div>}
      messageActions={[
        {
          id: "send-to-main",
          title: "Send to main thread",
          icon: "ArrowTurnBackward",
          roles: ["assistant"],
          run,
        },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.embeddedChatProps = [];
  mocks.timelinePanelProps = [];
  vi.mocked(sdk.threads.get).mockResolvedValue(THREAD_FIXTURE as never);
});

describe("PluginThreadChat", () => {
  it("gives a plugin page a working query client and sdk-backed thread context", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <MemoryRouter>
          <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="page">
            <DemoPluginPage threadId="thr_demo" />
          </PluginSlotMount>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("embedded-thread-chat")).toBeTruthy(),
    );
    expect(sdk.threads.get).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_demo" }),
    );
    const props = mocks.embeddedChatProps.at(-1)!;
    expect(props.projectId).toBe("proj_demo");
    expect(props.providerId).toBe("provider_demo");
    expect(props.variant).toBe("compact");
    expect(props.measure).toBe("panel");
    expect(props.surfaceTone).toBe("sidebar");
    expect(props.composer).toEqual(
      expect.objectContaining({
        permissionPolicy: "snapshot",
        draftScope: {
          kind: "thread",
          projectId: "proj_demo",
          threadId: "thr_demo",
        },
      }),
    );
  });

  it("hands the permission picker to the user only when asked", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" permissionPolicy="editable" />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("embedded-thread-chat")).toBeTruthy(),
    );
    expect(mocks.embeddedChatProps.at(-1)!.composer).toEqual(
      expect.objectContaining({ permissionPolicy: "editable" }),
    );
  });

  it("uses the surrounding thread detail navigation for timeline links", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const onOpenLink = vi.fn(() => true);
    const onOpenLocalFileLink = vi.fn(() => true);
    const workspaceMentionHandler = vi.fn();
    const resolveMentionLink = vi.fn(() => workspaceMentionHandler);

    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadTimelineNavigationProvider
            environmentId={null}
            onOpenLink={onOpenLink}
            onOpenLocalFileLink={onOpenLocalFileLink}
            resolveMentionLink={resolveMentionLink}
            workspaceRootPath="/workspace"
          >
            <DemoPluginPage threadId="thr_demo" />
          </ThreadTimelineNavigationProvider>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("embedded-thread-chat")).toBeTruthy(),
    );
    const props = mocks.embeddedChatProps.at(-1)!;
    expect(props).toEqual(
      expect.objectContaining({
        onOpenLink,
        onOpenLocalFileLink,
        workspaceRootPath: "/workspace",
      }),
    );

    const embeddedResolveMentionLink = props.resolveMentionLink as (resource: {
      kind: "path";
      source: "workspace";
      entryKind: "file";
      path: string;
      label: string;
    }) => (() => void) | null;
    const workspaceMention = {
      kind: "path" as const,
      source: "workspace" as const,
      entryKind: "file" as const,
      path: "README.md",
      label: "README.md",
    };
    expect(embeddedResolveMentionLink(workspaceMention)).toBe(
      workspaceMentionHandler,
    );
    expect(resolveMentionLink).toHaveBeenCalledWith(workspaceMention);
  });

  it("maps variant timeline to a composer-less transcript", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" variant="timeline" />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("timeline-panel-content")).toBeTruthy(),
    );
    expect(mocks.embeddedChatProps).toHaveLength(0);
    expect(mocks.timelinePanelProps.at(-1)).toEqual(
      expect.objectContaining({ threadId: "thr_demo" }),
    );
  });

  it("forwards leadingContent and maps messageActions to consumer actions", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const run = vi.fn();
    render(
      <Wrapper>
        <MemoryRouter>
          <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="page">
            <DemoPluginPageWithExtensions threadId="thr_demo" run={run} />
          </PluginSlotMount>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("embedded-thread-chat")).toBeTruthy(),
    );
    const props = mocks.embeddedChatProps.at(-1)!;
    expect(props.leadingContent).toBeTruthy();
    const actions = props.consumerMessageActions as Array<
      Record<string, unknown>
    >;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(
      expect.objectContaining({
        id: "send-to-main",
        pluginId: null,
        icon: "ArrowTurnBackward",
        label: "Send to main thread",
        roles: ["assistant"],
        run,
      }),
    );
  });

  it("maps variant full to the page measure and forwards focus requests", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" layout="document" focusRequest={3} />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("embedded-thread-chat")).toBeTruthy(),
    );
    const props = mocks.embeddedChatProps.at(-1)!;
    expect(props.measure).toBe("page");
    expect(props.layout).toBe("document");
    expect(props.composer).toEqual(
      expect.objectContaining({ focusRequestKey: 3 }),
    );
  });
});
