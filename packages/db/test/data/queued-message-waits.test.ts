/**
 * The queue's wait columns: `send_at`, the typed `waiting_on`, and the
 * `wait_holder` denormalization that exists purely so the orphan sweep can ask
 * "which rows does this plugin hold?" with an indexed lookup.
 *
 * What is worth pinning here is the set of guards a drain depends on and that
 * a refactor could quietly drop: waits only mutate LIVE rows (a claimed row is
 * already on its way to a provider, so queueing it would be a lost update), the
 * due sweep's boundary is inclusive and excludes threads the user threw away,
 * and `wait_holder` is derived from `waiting_on` rather than passed in, so the
 * two can never disagree.
 */
import { describe, expect, it } from "vitest";
import type { PromptInput } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessage,
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  listDueScheduledQueuedThreadMessages,
  listQueuedThreadMessagesByWaitHolder,
  listQueuedThreadMessagesWaitingOnKind,
  setQueuedThreadMessageWaitingOn,
} from "../../src/data/queued-thread-messages.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  deleteThread,
} from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  return { db, project, thread };
}

function queue(
  db: ReturnType<typeof setup>["db"],
  threadId: string,
  text = "hello",
) {
  return createQueuedThreadMessage(db, noopNotifier, {
    threadId,
    content: textInput(text),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
}

describe("queued message waits", () => {
  it("defaults a fresh row to an inline message with no wait", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);

    expect(row.sendAt).toBeNull();
    expect(row.waitingOn).toBeNull();
    expect(row.waitHolder).toBeNull();
    expect(row.payloadKind).toBe("inline");
    expect(row.retryOfTurnRequestId).toBeNull();
    expect(row.retryAttempt).toBeNull();
  });

  it("derives wait_holder from a plugin wait and clears it for a core wait", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);

    const queued = setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: {
        kind: "plugin",
        pluginId: "concurrency-limit",
        reason: "4 of 4 running",
      },
      sendAt: null,
    });
    expect(queued?.waitHolder).toBe("plugin:concurrency-limit");
    expect(JSON.parse(queued!.waitingOn!)).toEqual({
      kind: "plugin",
      pluginId: "concurrency-limit",
      reason: "4 of 4 running",
    });

    // Re-queueing onto a core wait must retire the previous holder, or the
    // orphan sweep would keep finding a row that plugin no longer holds.
    const requeued = setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });
    expect(requeued?.waitHolder).toBeNull();
    expect(JSON.parse(requeued!.waitingOn!)).toEqual({ kind: "provisioning" });
  });

  it("clears sendAt when a wait is replaced by a non-time wait", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);

    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 9_000,
    });
    const requeued = setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
    });
    expect(requeued?.sendAt).toBeNull();
  });

  it("refuses to write or clear a wait on a claimed row", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(claimQueuedThreadMessage(db, noopNotifier, row.id)).not.toBeNull();

    expect(
      setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "interaction" },
        sendAt: null,
      }),
    ).toBeNull();
    expect(
      clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
      }),
    ).toBeNull();

    // The claimed row keeps the wait it was waiting on: neither call touched it.
    const after = getQueuedThreadMessage(db, row.id);
    expect(JSON.parse(after!.waitingOn!)).toEqual({ kind: "provisioning" });
  });

  it("refuses to write a wait on a row belonging to another thread", () => {
    const { db, project, thread } = setup();
    const other = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const row = queue(db, thread.id);

    expect(
      setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: other.id,
        waitingOn: { kind: "provisioning" },
        sendAt: null,
      }),
    ).toBeNull();
  });

  it("clears a wait back to an ordinary queued row", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 9_000,
    });

    const cleared = clearQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
    });
    expect(cleared?.waitingOn).toBeNull();
    expect(cleared?.waitHolder).toBeNull();
    expect(cleared?.sendAt).toBeNull();
  });
});

describe("listDueScheduledQueuedThreadMessages", () => {
  it("includes a row due exactly now and excludes one due a millisecond later", () => {
    const { db, thread } = setup();
    const due = queue(db, thread.id, "due");
    const notYet = queue(db, thread.id, "not yet");
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: due.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 5_000,
    });
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: notYet.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 5_001,
    });

    expect(
      listDueScheduledQueuedThreadMessages(db, 5_000).map((row) => row.id),
    ).toEqual([due.id]);
  });

  it("ignores rows with no schedule at all", () => {
    const { db, thread } = setup();
    queue(db, thread.id);

    expect(listDueScheduledQueuedThreadMessages(db, 9_999_999)).toEqual([]);
  });

  it("orders oldest-due first", () => {
    const { db, thread } = setup();
    const later = queue(db, thread.id, "later");
    const earlier = queue(db, thread.id, "earlier");
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: later.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 2_000,
    });
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: earlier.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 1_000,
    });

    expect(
      listDueScheduledQueuedThreadMessages(db, 5_000).map((row) => row.id),
    ).toEqual([earlier.id, later.id]);
  });

  it("skips claimed rows", () => {
    const { db, thread } = setup();
    const row = queue(db, thread.id);
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: row.id,
      threadId: thread.id,
      waitingOn: { kind: "time" },
      sendAt: 1_000,
    });
    claimQueuedThreadMessage(db, noopNotifier, row.id);

    expect(listDueScheduledQueuedThreadMessages(db, 5_000)).toEqual([]);
  });

  it("skips rows on archived and deleted threads", () => {
    const { db, project } = setup();
    for (const [name, dispose] of [
      ["archived", archiveThread],
      ["deleted", deleteThread],
    ] as const) {
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
      });
      const row = queue(db, thread.id, name);
      setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id: row.id,
        threadId: thread.id,
        waitingOn: { kind: "time" },
        sendAt: 1_000,
      });
      expect(
        listDueScheduledQueuedThreadMessages(db, 5_000).map((r) => r.id),
      ).toEqual([row.id]);

      dispose(db, noopNotifier, thread.id);
      expect(listDueScheduledQueuedThreadMessages(db, 5_000)).toEqual([]);
    }
  });
});

describe("wait lookups", () => {
  it("finds only the rows a given plugin holds, and only while they are live", () => {
    const { db, thread } = setup();
    const mine = queue(db, thread.id, "mine");
    const theirs = queue(db, thread.id, "theirs");
    const core = queue(db, thread.id, "core");
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: mine.id,
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "limiter", reason: "full" },
      sendAt: null,
    });
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: theirs.id,
      threadId: thread.id,
      waitingOn: { kind: "plugin", pluginId: "router", reason: "picking" },
      sendAt: null,
    });
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: core.id,
      threadId: thread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(
      listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter").map(
        (row) => row.id,
      ),
    ).toEqual([mine.id]);

    claimQueuedThreadMessage(db, noopNotifier, mine.id);
    expect(listQueuedThreadMessagesByWaitHolder(db, "plugin:limiter")).toEqual(
      [],
    );
  });

  it("lists a thread's rows by wait kind, in queue order, scoped to that thread", () => {
    const { db, project, thread } = setup();
    const otherThread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const first = queue(db, thread.id, "first");
    const second = queue(db, thread.id, "second");
    const otherKind = queue(db, thread.id, "other kind");
    const elsewhere = queue(db, otherThread.id, "elsewhere");
    for (const id of [first.id, second.id]) {
      setQueuedThreadMessageWaitingOn(db, noopNotifier, {
        id,
        threadId: thread.id,
        waitingOn: { kind: "provisioning" },
        sendAt: null,
      });
    }
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: otherKind.id,
      threadId: thread.id,
      waitingOn: { kind: "interaction" },
      sendAt: null,
    });
    setQueuedThreadMessageWaitingOn(db, noopNotifier, {
      id: elsewhere.id,
      threadId: otherThread.id,
      waitingOn: { kind: "provisioning" },
      sendAt: null,
    });

    expect(
      listQueuedThreadMessagesWaitingOnKind(db, {
        kind: "provisioning",
        threadId: thread.id,
      }).map((row) => row.id),
    ).toEqual([first.id, second.id]);
  });

  it("does not mistake a row with no wait for any wait kind", () => {
    const { db, thread } = setup();
    queue(db, thread.id);

    for (const kind of [
      "time",
      "thread-busy",
      "turn-starting",
      "provisioning",
      "interaction",
      "plugin",
    ] as const) {
      expect(
        listQueuedThreadMessagesWaitingOnKind(db, { kind, threadId: thread.id }),
      ).toEqual([]);
    }
  });
});
