// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTimelineRendererProps } from "@get-bb/plugin-sdk";
import { sdk } from "@/lib/sdk";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { toolRow } from "@/test/fixtures/thread-timeline-rows";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  PluginSlotMount,
  resetAllCrashedPluginSlotsForTest,
} from "@/components/plugin/PluginSlotMount";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...mod,
    sdk: {
      ...mod.sdk,
      providers: { ...mod.sdk.providers, list: vi.fn() },
      threads: { ...mod.sdk.threads, get: vi.fn(), timeline: vi.fn() },
    },
  };
});
vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
  useEnvironmentDetailRealtimeSubscription: vi.fn(),
  useProjectDetailRealtimeSubscription: vi.fn(),
  useProjectListRealtimeSubscription: vi.fn(),
  useEnvironmentListRealtimeSubscription: vi.fn(),
  useHostListRealtimeSubscription: vi.fn(),
  useSystemRealtimeSubscription: vi.fn(),
}));
vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ isLocalDaemonHost: () => true }),
  useLocalHostDaemonAccess: () => ({ isLocalDaemonHost: () => true }),
}));

const THREAD_B = {
  ...makeThreadResponse({
    id: "thr_b",
    projectId: "proj_demo",
    providerId: "agent-b",
    environmentId: null,
    status: "active",
  }),
  environment: null,
  host: null,
};
const ROW_B = toolRow({
  id: "thr_b:tool:1",
  threadId: "thr_b",
  toolName: "b_only_tool",
  toolArgs: { q: 1 },
  output: "out",
});
const TIMELINE_B = makeThreadTimelineResponse({
  rows: [ROW_B],
  maxSeq: 10,
});
const PROVIDERS = [
  makeProviderInfo({
    id: "agent-b",
    pluginId: "plugin-b",
    displayName: "Agent B",
  }),
];

function PluginPanelPage({ threadId }: { threadId: string }) {
  const ThreadChat = pluginSdkAppImplementation.ThreadChat;
  return <ThreadChat threadId={threadId} variant="timeline" />;
}

function renderUnderThreadA(ui: React.ReactElement) {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  return render(
    <Wrapper>
      <MemoryRouter>
        {}
        <ThreadProviderContext.Provider
          value={{ providerId: "agent-a", pluginId: "plugin-a" }}
        >
          <PluginSlotMount
            pluginId="some-panel-plugin"
            slotKind="threadPanelAction"
            slotId="viewer"
          >
            {ui}
          </PluginSlotMount>
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </Wrapper>,
  );
}

async function expandAllRows() {
  await waitFor(() => {
    expect(
      document.querySelectorAll('[aria-expanded="false"]').length,
    ).toBeGreaterThan(0);
  });
  for (const element of Array.from(
    document.querySelectorAll('[aria-expanded="false"]'),
  )) {
    fireEvent.click(element);
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});
beforeEach(() => {
  vi.mocked(sdk.threads.get).mockResolvedValue(THREAD_B);
  vi.mocked(sdk.threads.timeline).mockResolvedValue(TIMELINE_B);
  vi.mocked(sdk.providers.list).mockResolvedValue(PROVIDERS);
});

describe("PluginThreadChat provider context", () => {
  it("scopes the embedded thread's tool rows to its own provider plugin", async () => {
    const seen: PluginTimelineRendererProps["thread"][] = [];
    function ToolRendererA({ row }: PluginTimelineRendererProps) {
      return <div data-testid="tool-renderer-a">{row.toolName}</div>;
    }
    function ToolRendererB({ row, thread }: PluginTimelineRendererProps) {
      seen.push(thread);
      return (
        <div data-testid="tool-renderer-b">
          {row.toolName}:{thread.id}:{thread.providerId}
        </div>
      );
    }
    setPluginSlotRegistrations(
      "plugin-a",
      registrationSet({
        timelineRenderers: [{ kind: "tool", component: ToolRendererA }],
      }),
    );
    setPluginSlotRegistrations(
      "plugin-b",
      registrationSet({
        timelineRenderers: [{ kind: "tool", component: ToolRendererB }],
      }),
    );

    renderUnderThreadA(<PluginPanelPage threadId="thr_b" />);
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalled());
    await expandAllRows();

    await waitFor(() =>
      expect(screen.getByTestId("tool-renderer-b")).toBeTruthy(),
    );
    expect(screen.getByTestId("tool-renderer-b").textContent).toBe(
      "b_only_tool:thr_b:agent-b",
    );
    expect(seen[0]).toEqual({ id: "thr_b", providerId: "agent-b" });
    expect(screen.queryByTestId("tool-renderer-a")).toBeNull();
  });

  it("renders the declarative base when only the embedding page's plugin has a renderer", async () => {
    function ToolRendererA({ row }: PluginTimelineRendererProps) {
      return <div data-testid="tool-renderer-a">{row.toolName}</div>;
    }
    setPluginSlotRegistrations(
      "plugin-a",
      registrationSet({
        timelineRenderers: [{ kind: "tool", component: ToolRendererA }],
      }),
    );

    renderUnderThreadA(<PluginPanelPage threadId="thr_b" />);
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalled());
    await expandAllRows();

    await waitFor(() => expect(document.body.textContent).toContain("out"));
    expect(screen.queryByTestId("tool-renderer-a")).toBeNull();
  });
});
