import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, {
  EMPTY_FORK_MAX_AGE_MS,
  EMPTY_FORK_SWEEP_PAGE_SIZE,
  REPLY_SEED_PREFIX,
  resolveReplySeedText,
  timelineRowsContainUserMessage,
  type SideChatTimelineRowLike,
} from "./server";

const PLUGIN_ID = "side-chat";

function conversationRow(text: string, role = "assistant") {
  return { kind: "conversation", role, text };
}

function turnRow(children: SideChatTimelineRowLike[] | null) {
  return { kind: "turn", children };
}

function timelineResult(rows: SideChatTimelineRowLike[]) {
  return { rows };
}

async function loadPlugin(sdkThreads: Record<string, unknown>) {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: { threads: sdkThreads },
  });
  await plugin(host.bb);
  return host;
}

describe("resolveReplySeedText", () => {
  it("returns the trimmed anchor even when it is the latest source message", () => {
    expect(resolveReplySeedText("  latest answer  ")).toBe("latest answer");
  });

  it("returns the trimmed anchor for an earlier message", () => {
    expect(resolveReplySeedText(" earlier answer ")).toBe("earlier answer");
  });

  it("returns null for an empty anchor (tip forks carry no seed)", () => {
    expect(resolveReplySeedText("  ")).toBeNull();
  });
});

describe("createSideChat rpc", () => {
  it("does not read the source timeline to decide whether to include the anchor", async () => {
    const timeline = vi.fn();
    const fork = vi.fn(
      async (_args: { agentContextSeed?: Array<{ text: string }> }) =>
        makeThreadResponse({ id: "thr_fork" }),
    );
    const { harness } = await loadPlugin({ timeline, fork });

    await harness.callRpc("createSideChat", {
      sourceThreadId: "thr_src",
      sourceSeqEnd: 7,
      anchorText: "latest answer",
    });

    expect(timeline).not.toHaveBeenCalled();
    expect(fork.mock.calls[0]?.[0].agentContextSeed?.[0]?.text).toBe(
      `${REPLY_SEED_PREFIX}latest answer`,
    );
  });

  it("forks hidden+isolated with a seed when the anchor is an earlier message", async () => {
    const fork = vi.fn(async () => makeThreadResponse({ id: "thr_fork" }));
    const { harness } = await loadPlugin({
      timeline: async () =>
        timelineResult([
          conversationRow("earlier answer"),
          conversationRow("latest answer"),
        ]),
      fork,
    });

    const result = await harness.callRpc("createSideChat", {
      sourceThreadId: "thr_src",
      sourceSeqEnd: 42,
      anchorText: "earlier answer",
    });

    expect(result).toEqual({ threadId: "thr_fork" });
    expect(fork).toHaveBeenCalledWith({
      sourceThreadId: "thr_src",
      sourceSeqEnd: 42,
      visibility: "hidden",
      agentContextSeed: [
        {
          type: "text",
          text: `${REPLY_SEED_PREFIX}earlier answer`,
          mentions: [],
          visibility: "agent-only",
        },
      ],
    });
  });

  it("falls back to a tip fork when the anchor predates any provider session", async () => {
    const sessionUnavailable = Object.assign(
      new Error("HTTP 400: Cannot fork: source has no active session to clone"),
      { code: "fork_source_session_unavailable" },
    );
    const fork = vi
      .fn()
      .mockRejectedValueOnce(sessionUnavailable)
      .mockResolvedValueOnce(makeThreadResponse({ id: "thr_tip_fork" }));
    const { harness } = await loadPlugin({
      timeline: async () =>
        timelineResult([
          conversationRow("earlier answer"),
          conversationRow("latest answer"),
        ]),
      fork,
    });

    const result = await harness.callRpc("createSideChat", {
      sourceThreadId: "thr_src",
      sourceSeqEnd: 1,
      anchorText: "earlier answer",
    });

    expect(result).toEqual({ threadId: "thr_tip_fork" });
    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork.mock.calls[1]?.[0]).not.toHaveProperty("sourceSeqEnd");
    expect(fork.mock.calls[1]?.[0].agentContextSeed?.[0]?.text).toContain(
      "earlier answer",
    );
  });

  it("rethrows point-fork failures that are not missing-session errors", async () => {
    const fork = vi.fn().mockRejectedValue(new Error("HTTP 403: forbidden"));
    const { harness } = await loadPlugin({
      timeline: async () => timelineResult([conversationRow("latest answer")]),
      fork,
    });

    await expect(
      harness.callRpc("createSideChat", {
        sourceThreadId: "thr_src",
        sourceSeqEnd: 3,
        anchorText: "x",
      }),
    ).rejects.toThrow("forbidden");
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("does not fall back on message text alone — only the structured code triggers it", async () => {
    const messageOnly = new Error(
      "HTTP 400: Cannot fork: source has no active session to clone",
    );
    const fork = vi.fn().mockRejectedValue(messageOnly);
    const { harness } = await loadPlugin({
      timeline: async () => timelineResult([conversationRow("latest answer")]),
      fork,
    });

    await expect(
      harness.callRpc("createSideChat", {
        sourceThreadId: "thr_src",
        sourceSeqEnd: 3,
        anchorText: "x",
      }),
    ).rejects.toThrow("no active session");
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("forks from the tip without a seed or sourceSeqEnd for empty anchors", async () => {
    const fork = vi.fn(async () => makeThreadResponse({ id: "thr_fork" }));
    const { harness } = await loadPlugin({
      timeline: async () => timelineResult([conversationRow("latest answer")]),
      fork,
    });

    await harness.callRpc("createSideChat", {
      sourceThreadId: "thr_src",
      anchorText: "",
    });

    expect(fork).toHaveBeenCalledWith({
      sourceThreadId: "thr_src",
      visibility: "hidden",
    });
  });
});

describe("sendToMain rpc", () => {
  it("queues the text on the source thread with the fork as sender", async () => {
    const create = vi.fn(async () => ({ id: "qm_1" }));
    const { harness } = await loadPlugin({ queuedMessages: { create } });

    const result = await harness.callRpc("sendToMain", {
      sourceThreadId: "thr_src",
      senderThreadId: "thr_fork",
      text: "the answer",
    });

    expect(result).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({
      threadId: "thr_src",
      input: [{ type: "text", text: "the answer", mentions: [] }],
      senderThreadId: "thr_fork",
    });
  });
});

describe("empty-fork sweep", () => {
  it("timelineRowsContainUserMessage finds nested user rows", () => {
    expect(
      timelineRowsContainUserMessage([
        turnRow([conversationRow("hi", "user")]),
      ]),
    ).toBe(true);
    expect(
      timelineRowsContainUserMessage([conversationRow("reply", "assistant")]),
    ).toBe(false);
  });

  it("archives only old forks without user messages and logs what it drops", async () => {
    const now = Date.now();
    const old = now - EMPTY_FORK_MAX_AGE_MS - 60_000;
    const emptyOldFork = makeThreadResponse({
      id: "thr_empty_old",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: old,
    });
    const repliedOldFork = makeThreadResponse({
      id: "thr_replied_old",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: old,
    });
    const emptyYoungFork = makeThreadResponse({
      id: "thr_empty_young",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: now - 60_000,
    });
    const foreignFork = makeThreadResponse({
      id: "thr_foreign",
      originKind: "fork",
      originPluginId: "some-other-plugin",
      visibility: "hidden",
      createdAt: old,
    });
    const list = vi.fn(async () => [
      emptyOldFork,
      repliedOldFork,
      emptyYoungFork,
      foreignFork,
    ]);
    const timeline = vi.fn(async ({ threadId }: { threadId: string }) =>
      threadId === "thr_replied_old"
        ? timelineResult([turnRow([conversationRow("a reply", "user")])])
        : timelineResult([conversationRow("assistant only")]),
    );
    const archive = vi.fn(async (_args: { threadId: string }) => ({
      ok: true,
    }));
    const { harness } = await loadPlugin({
      list,
      timeline,
      archive,
      queuedMessages: { list: async () => [] },
    });

    await harness.runSchedule("empty-fork-cleanup");

    expect(list).toHaveBeenCalledWith({
      includeHidden: true,
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      archived: false,
      limit: EMPTY_FORK_SWEEP_PAGE_SIZE,
      offset: 0,
    });
    expect(archive.mock.calls.map(([args]) => args)).toEqual([
      { threadId: "thr_empty_old" },
    ]);
    expect(timeline.mock.calls.map(([args]) => args.threadId)).toEqual([
      "thr_empty_old",
      "thr_replied_old",
    ]);
  });

  it("advances the page offset by the forks it left behind", async () => {
    const now = Date.now();
    const old = now - EMPTY_FORK_MAX_AGE_MS - 60_000;
    const firstPage = Array.from(
      { length: EMPTY_FORK_SWEEP_PAGE_SIZE },
      (_unused, index) =>
        makeThreadResponse({
          id: index === 0 ? "thr_replied" : `thr_empty_${index}`,
          originKind: "fork",
          originPluginId: PLUGIN_ID,
          visibility: "hidden",
          createdAt: old,
        }),
    );
    const list = vi.fn(async ({ offset }: { offset?: number }) =>
      offset === 0 ? firstPage : [],
    );
    const { harness } = await loadPlugin({
      list,
      timeline: async ({ threadId }: { threadId: string }) =>
        threadId === "thr_replied"
          ? timelineResult([turnRow([conversationRow("a reply", "user")])])
          : timelineResult([]),
      archive: async (_args: { threadId: string }) => ({ ok: true }),
      queuedMessages: { list: async () => [] },
    });

    await harness.runSchedule("empty-fork-cleanup");

    expect(list.mock.calls.map(([args]) => args.offset)).toEqual([0, 1]);
  });

  it("keeps an old empty-timeline fork that has queued-but-unsent input", async () => {
    const now = Date.now();
    const fork = makeThreadResponse({
      id: "thr_queued_only",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: now - EMPTY_FORK_MAX_AGE_MS - 60_000,
    });
    const archive = vi.fn(async (_args: { threadId: string }) => ({
      ok: true,
    }));
    const { harness } = await loadPlugin({
      list: async () => [fork],
      timeline: async () => timelineResult([]),
      archive,
      queuedMessages: {
        list: vi.fn(async () => [{ id: "qm_1" }]),
      },
    });

    await harness.runSchedule("empty-fork-cleanup");

    expect(archive).not.toHaveBeenCalled();
  });

  it("remembers a kept fork and stops re-reading its timeline", async () => {
    const now = Date.now();
    const fork = makeThreadResponse({
      id: "thr_has_work",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: now - EMPTY_FORK_MAX_AGE_MS - 60_000,
    });
    const timeline = vi.fn(async () =>
      timelineResult([turnRow([conversationRow("a reply", "user")])]),
    );
    const archive = vi.fn(async (_args: { threadId: string }) => ({
      ok: true,
    }));
    const { harness } = await loadPlugin({
      list: async () => [fork],
      timeline,
      archive,
      queuedMessages: { list: async () => [] },
    });

    await harness.runSchedule("empty-fork-cleanup");
    await harness.runSchedule("empty-fork-cleanup");

    expect(timeline).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
  });

  it("retries a fork whose timeline read failed", async () => {
    const now = Date.now();
    const fork = makeThreadResponse({
      id: "thr_unreadable",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: now - EMPTY_FORK_MAX_AGE_MS - 60_000,
    });
    const timeline = vi.fn(async () => {
      throw new Error("timeline unavailable");
    });
    const { harness } = await loadPlugin({
      list: async () => [fork],
      timeline,
      archive: async (_args: { threadId: string }) => ({ ok: true }),
      queuedMessages: { list: async () => [] },
    });

    await harness.runSchedule("empty-fork-cleanup");
    await harness.runSchedule("empty-fork-cleanup");

    expect(timeline).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the queued-message read fails", async () => {
    const now = Date.now();
    const fork = makeThreadResponse({
      id: "thr_unreadable_queue",
      originKind: "fork",
      originPluginId: PLUGIN_ID,
      visibility: "hidden",
      createdAt: now - EMPTY_FORK_MAX_AGE_MS - 60_000,
    });
    const archive = vi.fn(async (_args: { threadId: string }) => ({
      ok: true,
    }));
    const { harness } = await loadPlugin({
      list: async () => [fork],
      timeline: async () => timelineResult([]),
      archive,
      queuedMessages: {
        list: vi.fn(async () => {
          throw new Error("queue read boom");
        }),
      },
    });

    await harness.runSchedule("empty-fork-cleanup");

    expect(archive).not.toHaveBeenCalled();
  });
});
