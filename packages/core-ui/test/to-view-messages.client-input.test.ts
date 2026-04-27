import { describe, expect, it } from "vitest";
import type { ThreadEventRow, ViewMessage } from "@bb/domain";
import { getViewMessageScopeTurnId } from "../src/message-scope.js";
import { toViewMessages, toViewProjection } from "../src/to-view-messages.js";
import {
  createTimelineEventFactory,
  flattenProjectionMessages,
  fromRows,
} from "./timeline-test-harness.js";

function userMessages(
  messages: ViewMessage[],
): Extract<ViewMessage, { kind: "user" }>[] {
  return messages.filter(
    (message): message is Extract<ViewMessage, { kind: "user" }> =>
      message.kind === "user",
  );
}

describe("toViewMessages client input projection", () => {
  it("renders active-turn steers from client request sequence", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.commandCompleted({ command: "pnpm test" }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Please account for the restart",
      }),
      event.commandCompleted({
        command: "sqlite3 ~/.bb-dev/bb.db '.tables'",
        itemId: "tool-after-steer",
      }),
      event.assistantCompleted({ text: "Done." }),
      event.turnCompleted(),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const users = userMessages(flattenProjectionMessages(projection));

    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("thread-1:user-seed:3");
    expect(users[0]?.text).toBe("Please account for the restart");
    expect(users[0]?.sourceSeqStart).toBe(3);
    expect(users[0] ? getViewMessageScopeTurnId(users[0]) : null).toBe(
      "turn-1",
    );
  });

  it("uses input accepted events only to resolve the applied turn", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({ text: "Start the implementation" }),
      event.turnStarted({ turnId: "turn-2" }),
      event.inputAccepted({
        clientRequestSequence: 1,
        turnId: "turn-2",
      }),
      event.assistantCompleted({ text: "Done.", turnId: "turn-2" }),
      event.turnCompleted({ turnId: "turn-2" }),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const users = userMessages(flattenProjectionMessages(projection));

    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("thread-1:user-seed:1");
    expect(users[0]?.sourceSeqStart).toBe(1);
    expect(users[0] ? getViewMessageScopeTurnId(users[0]) : null).toBe(
      "turn-2",
    );
  });

  it("moves stale auto-send messages to the fallback turn when input acceptance references the request", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted({ turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1" }),
      event.clientTurnRequested({
        target: { kind: "auto", expectedTurnId: "turn-1" },
        text: "Continue after the previous turn finished",
      }),
      event.turnStarted({ turnId: "turn-2" }),
      event.inputAccepted({
        clientRequestSequence: 3,
        turnId: "turn-2",
      }),
      event.turnCompleted({ turnId: "turn-2" }),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });
    const users = userMessages(flattenProjectionMessages(projection));

    expect(users).toHaveLength(1);
    expect(users[0]?.sourceSeqStart).toBe(3);
    expect(users[0] ? getViewMessageScopeTurnId(users[0]) : null).toBe(
      "turn-2",
    );
  });

  it("does not render provider-native user messages without a client request", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.providerUserMessage({
        itemId: "provider-user-1",
        text: "Provider echo only",
      }),
      event.turnCompleted(),
    ];

    const projection = toViewProjection(fromRows(events), {
      threadStatus: "idle",
      turnMessageDetail: "summary",
    });

    expect(userMessages(flattenProjectionMessages(projection))).toEqual([]);
  });

  it("resolves multiple outstanding client requests by sequence", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({ text: "First request" }),
      event.clientTurnRequested({ text: "Second request" }),
      event.turnStarted({ turnId: "turn-2" }),
      event.inputAccepted({ clientRequestSequence: 2, turnId: "turn-2" }),
      event.turnCompleted({ turnId: "turn-2" }),
      event.turnStarted({ turnId: "turn-1" }),
      event.inputAccepted({ clientRequestSequence: 1, turnId: "turn-1" }),
      event.turnCompleted({ turnId: "turn-1" }),
    ];

    const users = userMessages(
      toViewMessages(fromRows(events), {
        threadStatus: "idle",
      }),
    );

    expect(users.map((user) => [user.text, getViewMessageScopeTurnId(user)])).toEqual([
      ["First request", "turn-1"],
      ["Second request", "turn-2"],
    ]);
  });

  it("does not render pure client lifecycle events", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
    });
    const events: ThreadEventRow[] = [
      event.clientThreadStart({
        requestMethod: "thread/start",
        source: "spawn",
        target: { kind: "thread-start" },
        text: "Lifecycle only",
      }),
    ];

    expect(
      userMessages(
        toViewMessages(fromRows(events), {
          threadStatus: "idle",
        }),
      ),
    ).toEqual([]);
  });

  it("renders the first thread prompt from client/turn/requested", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({
        requestMethod: "thread/start",
        source: "spawn",
        target: { kind: "thread-start" },
        text: "Fix the sidebar menu state bug",
      }),
      event.clientThreadStart({
        source: "spawn",
        text: "Fix the sidebar menu state bug",
      }),
    ];

    const projected = toViewMessages(fromRows(events), {
      threadStatus: "error",
    });
    const users = userMessages(projected);

    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe("thread-1:user-seed:1");
    expect(users[0]?.text).toBe("Fix the sidebar menu state bug");
  });

  it("preserves attachment metadata from client/turn/requested", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({
        input: [
          { type: "text", text: "check these" },
          { type: "image", url: "https://example.com/a.png" },
          { type: "localImage", path: "/tmp/local-a.png" },
          { type: "localFile", path: "/tmp/notes.md" },
        ],
        requestMethod: "thread/start",
        source: "spawn",
        target: { kind: "thread-start" },
        text: "check these",
      }),
    ];

    const users = userMessages(
      toViewMessages(fromRows(events), {
        threadStatus: "idle",
      }),
    );

    expect(users).toHaveLength(1);
    expect(users[0]?.attachments?.imageUrls).toEqual([
      "https://example.com/a.png",
    ]);
    expect(users[0]?.attachments?.localImagePaths).toEqual([
      "/tmp/local-a.png",
    ]);
    expect(users[0]?.attachments?.localFilePaths).toEqual(["/tmp/notes.md"]);
  });

  it("hides system-initiated client requests unless internal messages are enabled", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
    });
    const events: ThreadEventRow[] = [
      event.clientTurnRequested({
        initiator: "system",
        text: "[bb system] Welcome!",
      }),
    ];

    expect(toViewMessages(fromRows(events), { threadStatus: "idle" })).toEqual(
      [],
    );

    const projected = toViewMessages(fromRows(events), {
      includeInternalSystemMessages: true,
      threadStatus: "idle",
    });

    expect(userMessages(projected)).toHaveLength(1);
    expect(userMessages(projected)[0]?.text).toBe("[bb system] Welcome!");
  });

  it("projects manager user messages and suppresses raw assistant text for manager threads", () => {
    const event = createTimelineEventFactory({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const projected = toViewMessages(
      fromRows([
        event.assistantCompleted({
          itemId: "assistant-1",
          text: "internal manager chatter",
        }),
        event.managerUserMessage({
          text: "Visible manager update",
          turnId: "turn-1",
        }),
      ]),
      {
        threadStatus: "idle",
        threadType: "manager",
      },
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.kind).toBe("assistant-text");
    if (projected[0]?.kind === "assistant-text") {
      expect(projected[0].text).toBe("Visible manager update");
      expect(getViewMessageScopeTurnId(projected[0])).toBe("turn-1");
      expect(projected[0].isManagerUserMessage).toBe(true);
    }
  });

  it("rejects input accepted events without scope at the decode boundary", () => {
    const event = createTimelineEventFactory({
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const events: ThreadEventRow[] = [
      event.turnStarted(),
      event.clientTurnRequested({ text: "Turnless ack steer" }),
      {
        id: "evt-turnless-user-ack",
        threadId: "thread-1",
        seq: 3,
        type: "turn/input/accepted",
        data: {
          providerThreadId: "provider-thread-1",
          clientRequestSequence: 2,
        },
        createdAt: 3,
      },
    ];

    expect(() =>
      toViewProjection(fromRows(events), {
        threadStatus: "active",
        turnMessageDetail: "summary",
      }),
    ).toThrow(/scope/);
  });
});
