import { describe, expect, it, vi } from "vitest";
import * as domain from "@bb/domain";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  readlineMocks,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

interface RetryRequest {
  param: { id: string };
  json: { turnRequestId: string | null; sendAt: number | null; reason: string };
}

describe("bb thread action command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("bb thread archive sends the thread id from args", async () => {
    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-archive-1"],
    }));
    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "thread-archive-1"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived",
    );
  });

  it("bb thread archive reports related threads when cascading", async () => {
    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-child-1", "thread-archive-1"],
    }));
    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "thread-archive-1"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-archive-1 archived (1 related thread also archived)",
    );
  });

  it("bb thread archive --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-archive-2");
    const archivePost = vi.fn(async () => ({
      ok: true,
      archivedThreadIds: ["thread-archive-2"],
    }));
    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await runCommand(["thread", "archive", "--self"], register);

    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-2" },
    });
  });

  it("bb thread archive prefixes failures with thread context", async () => {
    const archivePost = vi.fn(async () => {
      throw new Error("HTTP 404: missing");
    });
    stubServerApi({ "v1.threads.:id.archive-all.$post": archivePost });

    await expect(
      runCommand(["thread", "archive", "thread-archive-1"], register),
    ).rejects.toThrow("process.exit:1");

    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Failed to archive thread thread-archive-1: HTTP 404: missing",
    );
    expect(archivePost).toHaveBeenCalledWith({
      param: { id: "thread-archive-1" },
    });
  });

  it("bb thread unarchive --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-unarchive-1");
    const unarchivePost = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.unarchive.$post": unarchivePost });

    await runCommand(["thread", "unarchive", "--self"], register);

    expect(unarchivePost).toHaveBeenCalledWith({
      param: { id: "thread-unarchive-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unarchive-1 unarchived",
    );
  });

  it("bb thread edit-message targets the latest editable message by default", async () => {
    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));
    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      ["thread", "edit-message", "thread-edit-1", "--message", "Replacement"],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-1" },
      json: {
        operationId: expect.any(String),
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-edit-1 message replaced; workspace changes were kept",
    );
  });

  it("bb thread edit-message preserves an agent caller when targeting another thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-agent-caller");
    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));
    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      [
        "thread",
        "edit-message",
        "thread-edit-target",
        "--message",
        "Replacement",
        "--expected-request-sequence",
        "41",
      ],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-target" },
      json: expect.objectContaining({
        senderThreadId: "thread-agent-caller",
      }),
    });
  });

  it("bb thread edit-message accepts an explicit stale-edit guard", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-edit-self");
    const submitEdit = vi.fn(async () => ({
      ok: true,
      operationId: "edit-op-server",
      requestSequence: 43,
    }));
    stubServerApi({
      "v1.threads.:id.edit-message.$post": submitEdit,
    });

    await runCommand(
      [
        "thread",
        "edit-message",
        "--self",
        "--message",
        "Replacement",
        "--expected-request-sequence",
        "41",
        "--json",
      ],
      register,
    );

    expect(submitEdit).toHaveBeenCalledWith({
      param: { id: "thread-edit-self" },
      json: expect.objectContaining({ expectedRequestSequence: 41 }),
    });
    expect(
      JSON.parse(collectLogLines(vi.mocked(console.log)).join("\n")),
    ).toMatchObject({
      threadId: "thread-edit-self",
      ok: true,
      requestSequence: 43,
    });
  });

  it("bb thread edit-message rejects a partially numeric request sequence", async () => {
    const submitEdit = vi.fn();
    stubServerApi({ "v1.threads.:id.edit-message.$post": submitEdit });

    await expect(
      runCommand(
        [
          "thread",
          "edit-message",
          "thread-edit-1",
          "--message",
          "Replacement",
          "--expected-request-sequence",
          "41abc",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(submitEdit).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: --expected-request-sequence must be a non-negative integer.",
    );
  });

  it("bb thread pin sends the thread id from args", async () => {
    const pinnedThread = fixtures.makeThread({
      id: "thread-pin-1",
      projectId: "proj-1",
      providerId: "codex",
      pinnedAt: 1,
    });
    const pinPost = vi.fn(async () => pinnedThread);
    stubServerApi({ "v1.threads.:id.pin.$post": pinPost });

    await runCommand(["thread", "pin", "thread-pin-1"], register);

    expect(pinPost).toHaveBeenCalledWith({
      param: { id: "thread-pin-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-pin-1 pinned",
    );
  });

  it("bb thread unpin --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-unpin-1");
    const unpinnedThread = fixtures.makeThread({
      id: "thread-unpin-1",
      projectId: "proj-1",
      providerId: "codex",
      pinnedAt: null,
    });
    const unpinPost = vi.fn(async () => unpinnedThread);
    stubServerApi({ "v1.threads.:id.unpin.$post": unpinPost });

    await runCommand(["thread", "unpin", "--self"], register);

    expect(unpinPost).toHaveBeenCalledWith({
      param: { id: "thread-unpin-1" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-unpin-1 unpinned",
    );
  });

  it("bb thread delete prompts before deleting", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-1",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      title: "Delete me",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });
    readlineMocks.question.mockResolvedValue("yes");

    await runCommand(["thread", "delete", "thread-delete-1"], register);

    expect(get).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
    });
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-1" },
      json: { childThreadsConfirmed: false },
    });
    expect(readlineMocks.question).toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-1 deleted",
    );
  });

  it("bb thread delete cancels when confirmation is declined", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-2",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });
    readlineMocks.question.mockResolvedValue("no");

    await runCommand(["thread", "delete", "thread-delete-2"], register);

    expect(deleteFn).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-delete-2 deletion cancelled",
    );
  });

  it("bb thread delete --yes skips confirmation (requires explicit id)", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-3",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });

    await runCommand(
      ["thread", "delete", "thread-delete-3", "--yes"],
      register,
    );

    expect(readlineMocks.question).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-3" },
      json: { childThreadsConfirmed: false },
    });
  });

  it("bb thread delete forwards explicit child-thread confirmation", async () => {
    const thread: domain.Thread = fixtures.makeThread({
      id: "thread-delete-children",
      projectId: "proj-1",
      providerId: "codex",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    const get = vi.fn(async () => thread);
    const deleteFn = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.$delete": deleteFn,
    });

    await runCommand(
      [
        "thread",
        "delete",
        "thread-delete-children",
        "--yes",
        "--confirm-child-threads",
      ],
      register,
    );

    expect(deleteFn).toHaveBeenCalledWith({
      param: { id: "thread-delete-children" },
      json: { childThreadsConfirmed: true },
    });
  });

  it("bb thread stop lets the server no-op when the thread is already idle", async () => {
    const get = vi.fn(async () =>
      fixtures.makeThread({
        id: "thread-stop-idle",
        projectId: "proj-1",
        providerId: "codex",
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.stop.$post": stopPost,
    });

    await runCommand(["thread", "stop", "thread-stop-idle"], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-stop-idle stopped",
    );
    expect(get).not.toHaveBeenCalled();
    expect(stopPost).toHaveBeenCalledTimes(1);
  });

  it("bb thread stop lets the server no-op when the thread is in error", async () => {
    const get = vi.fn(async () =>
      fixtures.makeThread({
        id: "thread-stop-error",
        projectId: "proj-1",
        providerId: "codex",
        status: "error",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.stop.$post": stopPost,
    });

    await runCommand(["thread", "stop", "thread-stop-error"], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-stop-error stopped",
    );
    expect(get).not.toHaveBeenCalled();
    expect(stopPost).toHaveBeenCalledTimes(1);
  });

  it("bb thread stop still stops active threads", async () => {
    const get = vi.fn(async () =>
      fixtures.makeThread({
        id: "thread-stop-active",
        projectId: "proj-1",
        providerId: "codex",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const stopPost = vi.fn(async () => ({ ok: true }));
    stubServerApi({
      "v1.threads.:id.$get": get,
      "v1.threads.:id.stop.$post": stopPost,
    });

    await runCommand(["thread", "stop", "thread-stop-active"], register);

    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-stop-active stopped",
    );
    expect(stopPost).toHaveBeenCalledTimes(1);
  });

  it("bb thread compact calls the manual compaction endpoint", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.compact.$post": post });

    await runCommand(["thread", "compact", "thread-compact"], register);

    expect(post).toHaveBeenCalledWith({ param: { id: "thread-compact" } });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-compact context compaction requested",
    );
  });

  it("bb thread clear invokes the context clear action", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.context.clear.$post": post });

    await runCommand(["thread", "clear", "thread-clear"], register);

    expect(post).toHaveBeenCalledWith({ param: { id: "thread-clear" } });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-clear context cleared",
    );
  });

  it.each([
    ["cancel-plan", "plan.cancel", "exited Plan mode"],
    ["clear-goal", "goal.clear", "cleared its Goal"],
  ])(
    "bb thread %s calls the authoritative banner action",
    async (command, route, output) => {
      const post = vi.fn(async () => ({ ok: true }));
      stubServerApi({ [`v1.threads.:id.${route}.$post`]: post });

      await runCommand(["thread", command, "thread-banner"], register);

      expect(post).toHaveBeenCalledWith({ param: { id: "thread-banner" } });
      expect(collectLogLines(vi.mocked(console.log))).toContain(
        `Thread thread-banner ${output}`,
      );
    },
  );
  it("bb thread retry defaults the turn and the reason at the boundary", async () => {
    const retryPost = vi.fn(async () => ({
      ok: true,
      delivery: "sent",
      turnRequestId: "creq_2222222222",
      attempt: 2,
    }));
    stubServerApi({ "v1.threads.:id.retry.$post": retryPost });

    await runCommand(["thread", "retry", "thread-retry-1"], register);

    // No `--turn` means "whichever turn failed", which the server resolves;
    // the reason is filled rather than sent as an absent field.
    expect(retryPost).toHaveBeenCalledWith({
      param: { id: "thread-retry-1" },
      json: { turnRequestId: null, sendAt: null, reason: "Retry" },
    });
    expect(collectLogLines(vi.mocked(console.log))).toContain(
      "Thread thread-retry-1 retrying turn creq_2222222222 (attempt 2)",
    );
  });

  it("bb thread retry names the turn, the instant and the reason when asked", async () => {
    const retryPost = vi.fn(async (_request: RetryRequest) => ({
      ok: true,
      delivery: "queued",
      turnRequestId: "creq_3333333333",
      attempt: 3,
      queuedMessageId: "queued_1",
      waitingOn: { kind: "time" },
      sendAt: 1,
    }));
    stubServerApi({ "v1.threads.:id.retry.$post": retryPost });

    await runCommand(
      [
        "thread",
        "retry",
        "thread-retry-2",
        "--turn",
        "creq_3333333333",
        "--send-at",
        "10m",
        "--reason",
        "Rate limited",
      ],
      register,
    );

    const call = retryPost.mock.calls[0]?.[0];
    expect(call?.param).toEqual({ id: "thread-retry-2" });
    expect(call?.json.turnRequestId).toBe("creq_3333333333");
    expect(call?.json.reason).toBe("Rate limited");
    // `--send-at` is the same grammar `bb thread tell` uses: a duration from
    // now becomes an absolute instant at the boundary.
    expect(call?.json.sendAt).toBeGreaterThan(Date.now());
    expect(collectLogLines(vi.mocked(console.log)).join("\n")).toContain(
      "retry of turn creq_3333333333 (attempt 3) queued",
    );
  });
});
