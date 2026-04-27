import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
import type { AgentRuntimeRawProviderEventCaptureEntry } from "./capture-types.js";
import { replayRawProviderEvents } from "./replay-translation.js";

interface RawEventArgs {
  captureId: string;
  method: string;
  params: object;
  sourceThreadId?: string;
}

function rawEvent(
  args: RawEventArgs,
): AgentRuntimeRawProviderEventCaptureEntry {
  return {
    kind: "raw-provider-event",
    capturedAt: 1_000,
    providerId: "codex",
    captureId: args.captureId,
    rawLine: "{}",
    rawEvent: {
      jsonrpc: "2.0",
      method: args.method,
      params: args.params,
    },
    ...(args.sourceThreadId ? { sourceThreadId: args.sourceThreadId } : {}),
  };
}

describe("replayRawProviderEvents", () => {
  it("remaps provider thread ids to the requested bb thread id", () => {
    const translated = replayRawProviderEvents({
      bbThreadId: "thr-replay",
      providerId: "codex",
      rawProviderEvents: [
        rawEvent({
          captureId: "raw-1",
          method: "turn/started",
          params: {
            threadId: "provider-thread-1",
            turn: {
              id: "turn-1",
              items: [],
              status: "inProgress",
              error: null,
            },
          },
        }),
      ],
    });

    expect(translated).toHaveLength(1);
    expect(translated[0]?.rawCaptureId).toBe("raw-1");
    expect(translated[0]?.event).toMatchObject({
      type: "turn/started",
      threadId: "thr-replay",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
    });
  });

  it("stamps later events with provider thread identity discovered from thread identity", () => {
    const translated = replayRawProviderEvents({
      bbThreadId: "thr-replay",
      providerId: "codex",
      rawProviderEvents: [
        rawEvent({
          captureId: "raw-identity",
          method: "thread/started",
          params: {
            thread: {
              id: "provider-thread-1",
              preview: "Fix the tests",
              ephemeral: false,
              modelProvider: "openai",
              createdAt: 0,
              updatedAt: 0,
              status: { type: "idle" },
              path: null,
              cwd: "/tmp",
              cliVersion: "0.1",
              source: "appServer",
              agentNickname: null,
              agentRole: null,
              gitInfo: null,
              name: null,
              turns: [],
            },
          },
        }),
        rawEvent({
          captureId: "raw-turn",
          method: "turn/started",
          params: {
            threadId: "provider-thread-1",
            turn: {
              id: "turn-1",
              items: [],
              status: "inProgress",
              error: null,
            },
          },
        }),
        rawEvent({
          captureId: "raw-unscoped",
          method: "debug/no-thread-context",
          params: {
            message: "provider event without thread identity fields",
          },
        }),
      ],
    });

    const identity = translated.find(
      (entry) => entry.event.type === "thread/identity",
    );
    const turnStarted = translated.find(
      (entry) => entry.event.type === "turn/started",
    );
    const unscoped = translated.find(
      (entry) => entry.rawCaptureId === "raw-unscoped",
    );

    expect(identity?.event).toMatchObject({
      type: "thread/identity",
      threadId: "thr-replay",
      providerThreadId: "provider-thread-1",
    });
    expect(turnStarted?.event).toMatchObject({
      type: "turn/started",
      threadId: "thr-replay",
      providerThreadId: "provider-thread-1",
    });
    expect(unscoped?.event).toMatchObject({
      type: "provider/unhandled",
      threadId: "thr-replay",
      providerThreadId: "provider-thread-1",
    });
  });
});
