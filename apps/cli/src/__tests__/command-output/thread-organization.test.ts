import { describe, expect, it, vi } from "vitest";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread organization commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("creates a named thread section", async () => {
    const create = vi.fn(async () => ({
      id: "section-review",
      name: "Review",
      createdAt: 1,
      updatedAt: 1,
    }));
    stubServerApi({ "v1.thread-sections.$post": create });

    await runCommand(["thread", "section", "create", "Review"], register);

    expect(create).toHaveBeenCalledWith({ json: { name: "Review" } });
  });

  it("creates an explicitly queued message", async () => {
    const create = vi.fn(async () => ({
      id: "queued-1",
      threadId: "thread-1",
      position: 1,
      groupBoundary: false,
      payload: {
        input: [{ type: "text", text: "next task", mentions: [] }],
      },
      createdAt: 1,
      updatedAt: 1,
    }));
    stubServerApi({ "v1.threads.:id.queued-messages.$post": create });

    await runCommand(
      ["thread", "queue", "create", "thread-1", "next task"],
      register,
    );

    expect(create).toHaveBeenCalledWith({
      param: { id: "thread-1" },
      json: {
        input: [{ type: "text", text: "next task", mentions: [] }],
      },
    });
  });

  it("updates a queued message in place", async () => {
    const list = vi.fn(async () => [
      { id: "queued-1", updatedAt: 42 },
      { id: "queued-2", updatedAt: 43 },
    ]);
    const update = vi.fn(async () => ({ id: "queued-1" }));
    stubServerApi({
      "v1.threads.:id.queued-messages.$get": list,
      "v1.threads.:id.queued-messages.:queuedMessageId.$patch": update,
    });

    await runCommand(
      [
        "thread",
        "queue",
        "update",
        "thread-1",
        "queued-1",
        "revised task",
        "--file",
        "/tmp/spec.md",
        "--file",
        "/tmp/data.json",
        "--image",
        "/tmp/mock.png",
        "--image",
        "/tmp/detail.png",
      ],
      register,
    );

    expect(list).toHaveBeenCalledWith({ param: { id: "thread-1" } });
    expect(update).toHaveBeenCalledWith({
      param: { id: "thread-1", queuedMessageId: "queued-1" },
      json: {
        expectedUpdatedAt: 42,
        input: [
          { type: "text", text: "revised task", mentions: [] },
          { type: "localFile", path: "/tmp/spec.md" },
          { type: "localFile", path: "/tmp/data.json" },
          { type: "localImage", path: "/tmp/mock.png" },
          { type: "localImage", path: "/tmp/detail.png" },
        ],
      },
    });
    expect(list.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });

  it("rejects an update when the queued message is absent", async () => {
    const list = vi.fn(async () => [{ id: "queued-2", updatedAt: 43 }]);
    const update = vi.fn();
    stubServerApi({
      "v1.threads.:id.queued-messages.$get": list,
      "v1.threads.:id.queued-messages.:queuedMessageId.$patch": update,
    });

    await expect(
      runCommand(
        ["thread", "queue", "update", "thread-1", "queued-1", "revised"],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(console.error).toHaveBeenCalledWith(
      "Error: Queued message queued-1 not found on thread thread-1.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("reports when sending a queued message leaves it waiting", async () => {
    const send = vi.fn(async () => ({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        waitingOn: { kind: "provisioning" },
        sendAt: null,
      },
    }));
    stubServerApi({
      "v1.threads.:id.queued-messages.:queuedMessageId.send.$post": send,
    });

    await runCommand(
      ["thread", "queue", "send", "thread-1", "queued-1", "--mode", "steer"],
      register,
    );

    expect(send).toHaveBeenCalledWith({
      param: { id: "thread-1", queuedMessageId: "queued-1" },
      json: { mode: "steer" },
    });
    expect(console.log).toHaveBeenCalledWith(
      "Queued message queued-1 is still queued (waiting for the workspace)",
    );
  });

  it("reorders pinned threads with explicit neighbors", async () => {
    const reorder = vi.fn(async () => []);
    stubServerApi({ "v1.threads.:id.pin-order.$patch": reorder });

    await runCommand(
      [
        "thread",
        "reorder-pinned",
        "thread-2",
        "--after",
        "thread-1",
        "--before",
        "thread-3",
      ],
      register,
    );

    expect(reorder).toHaveBeenCalledWith({
      param: { id: "thread-2" },
      json: {
        previousThreadId: "thread-1",
        nextThreadId: "thread-3",
      },
    });
  });
});
