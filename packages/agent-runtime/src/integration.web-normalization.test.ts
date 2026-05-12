import { describe, expect, it } from "vitest";
import type {
  ThreadEvent,
  ThreadEventWebFetchItem,
  ThreadEventWebSearchItem,
} from "@bb/domain";
import {
  cleanup,
  createTestRuntime,
  describeRuntimeDiagnostics,
  getEventsForThread,
  newThreadId,
  resolveRuntimeOptions,
  waitForThreadTurnCompleted,
} from "./test/runtime-integration-harness.js";

const webQuery = "IANA example domains";
const webUrl = "https://example.com";
const codexOpenPageUrl = "https://example.com/?bb-web-normalization=open-page";

type ThreadItemLifecycleEvent = Extract<
  ThreadEvent,
  { type: "item/started" | "item/completed" }
>;

type WebSearchLifecycleEvent = ThreadItemLifecycleEvent & {
  item: ThreadEventWebSearchItem;
};

type WebFetchLifecycleEvent = ThreadItemLifecycleEvent & {
  item: ThreadEventWebFetchItem;
};

function isWebSearchLifecycleEvent(
  event: ThreadEvent,
): event is WebSearchLifecycleEvent {
  return (
    (event.type === "item/started" || event.type === "item/completed") &&
    event.item.type === "webSearch"
  );
}

function isWebFetchLifecycleEvent(
  event: ThreadEvent,
): event is WebFetchLifecycleEvent {
  return (
    (event.type === "item/started" || event.type === "item/completed") &&
    event.item.type === "webFetch"
  );
}

function matchesExpectedWebQuery(item: ThreadEventWebSearchItem): boolean {
  return item.queries.some((query) =>
    query.toLowerCase().includes("example domains"),
  );
}

function matchesExpectedWebUrl(item: ThreadEventWebFetchItem): boolean {
  return item.url.includes("example.com");
}

function buildClaudeWebPrompt(): string {
  return (
    `Use the WebSearch tool to search the web for exactly "${webQuery}". ` +
    `Then use the WebFetch tool to fetch ${webUrl}. ` +
    "Do not use Bash or any other tool when the web tools can do the work. " +
    'After both tools complete, reply with exactly "DONE".'
  );
}

function buildCodexSearchPrompt(): string {
  return (
    `Use the native web search tool to search the web for exactly "${webQuery}". ` +
    "Do not answer from memory. Do not use shell commands. " +
    'After the search completes, reply with exactly "DONE".'
  );
}

function buildCodexOpenPagePrompt(): string {
  return (
    `Use the native web tool to open exactly ${codexOpenPageUrl}. ` +
    "Do not answer from memory. Do not use shell commands. " +
    'After the open-page tool completes, reply with exactly "DONE".'
  );
}

describe("web normalization integration", () => {
  it("normalizes Codex native web search activity", async () => {
    const providerId = "codex";
    const ctx = createTestRuntime(providerId);
    const threadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx,
        providerId,
        preset: "full",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId,
        options,
      });

      await ctx.runtime.runTurn({
        threadId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: buildCodexSearchPrompt() }],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 60_000,
        label: "codex web normalization turn/completed",
      });

      const threadEvents = getEventsForThread(ctx.events, threadId);
      const webSearchEvents = threadEvents.filter(isWebSearchLifecycleEvent);
      const providerUnhandledEvents = threadEvents.filter(
        (event) =>
          event.type === "provider/unhandled" &&
          (event.rawType === "item/started" ||
            event.rawType === "item/completed"),
      );

      expect(
        webSearchEvents.some((event) => matchesExpectedWebQuery(event.item)),
        describeRuntimeDiagnostics({ ctx, threadId }),
      ).toBe(true);
      expect(providerUnhandledEvents).toEqual([]);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 90_000);

  it("normalizes Codex native open-page activity", async () => {
    const providerId = "codex";
    const ctx = createTestRuntime(providerId);
    const threadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx,
        providerId,
        preset: "full",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId,
        options,
      });

      await ctx.runtime.runTurn({
        threadId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: buildCodexOpenPagePrompt() }],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 60_000,
        label: "codex open-page normalization turn/completed",
      });

      const threadEvents = getEventsForThread(ctx.events, threadId);
      const webSearchEvents = threadEvents.filter(isWebSearchLifecycleEvent);
      const completedWebFetch = threadEvents.find(
        (event): event is WebFetchLifecycleEvent =>
          isWebFetchLifecycleEvent(event) &&
          event.type === "item/completed" &&
          matchesExpectedWebUrl(event.item),
      );
      const providerUnhandledEvents = threadEvents.filter(
        (event) =>
          event.type === "provider/unhandled" &&
          (event.rawType === "item/started" ||
            event.rawType === "item/completed"),
      );

      expect(
        completedWebFetch,
        describeRuntimeDiagnostics({ ctx, threadId }),
      ).toBeDefined();
      expect(
        webSearchEvents,
        describeRuntimeDiagnostics({ ctx, threadId }),
      ).toEqual([]);
      expect(providerUnhandledEvents).toEqual([]);
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 90_000);

  it("normalizes Claude web search and web fetch activity", async () => {
    const providerId = "claude-code";
    const ctx = createTestRuntime(providerId);
    const threadId = newThreadId();

    try {
      const options = await resolveRuntimeOptions({
        ctx,
        providerId,
        preset: "full",
      });
      await ctx.runtime.startThread({
        environmentId: "env-1",
        threadId,
        projectId: "test-project",
        providerId,
        options,
      });

      await ctx.runtime.runTurn({
        threadId,
        clientRequestId: "creq_23456789ab",
        input: [{ type: "text", text: buildClaudeWebPrompt() }],
        options,
      });

      await waitForThreadTurnCompleted({
        ctx,
        threadId,
        timeoutMs: 60_000,
        label: "claude web normalization turn/completed",
      });

      const threadEvents = getEventsForThread(ctx.events, threadId);
      const completedWebSearch = threadEvents.find(
        (event): event is WebSearchLifecycleEvent =>
          isWebSearchLifecycleEvent(event) &&
          event.type === "item/completed" &&
          matchesExpectedWebQuery(event.item),
      );
      const completedWebFetch = threadEvents.find(
        (event): event is WebFetchLifecycleEvent =>
          isWebFetchLifecycleEvent(event) &&
          event.type === "item/completed" &&
          matchesExpectedWebUrl(event.item),
      );

      expect(
        completedWebSearch,
        describeRuntimeDiagnostics({ ctx, threadId }),
      ).toBeDefined();
      expect(completedWebSearch?.item.resultText).toBeTruthy();

      expect(
        completedWebFetch,
        describeRuntimeDiagnostics({ ctx, threadId }),
      ).toBeDefined();
      expect(completedWebFetch?.item.resultText).toBeTruthy();
    } finally {
      await ctx.runtime.shutdown();
      cleanup(ctx);
    }
  }, 90_000);
});
