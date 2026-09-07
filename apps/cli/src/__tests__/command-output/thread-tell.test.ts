import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread tell command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("bb thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-json-tell", "hello", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      threadId: "thread-json-tell",
      ok: true,
      delivery: "sent",
      mode: "steer",
    });
  });

  it("bb thread tell names the typed reason a message queued for", async () => {
    // The server says WHY, so the CLI stops inferring it from the flags it
    // sent — which is what let the old four-way delivery enum collapse.
    const post = vi.fn(async () => ({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        id: "qm_1",
        waitingOn: { kind: "interaction" },
        sendAt: null,
      },
    }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-blocked", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-blocked message queued (waiting for a pending interaction); it dispatches when that clears",
    );
  });

  it("bb thread tell names the plugin a message is waiting on", async () => {
    const post = vi.fn(async () => ({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        id: "qm_2",
        waitingOn: {
          kind: "plugin",
          pluginId: "concurrency-limit",
          reason: "4 of 4 running",
        },
        sendAt: null,
      },
    }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-limited", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-limited message queued (concurrency-limit: 4 of 4 running); it dispatches when that clears",
    );
  });

  it("bb thread tell keeps the steered wording for servers that only report ok", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-legacy", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-legacy steered",
    );
  });

  it("bb thread tell --mode queue preserves non-urgent queued delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-queue-tell", "hello", "--mode", "queue"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-queue-tell" },
      json: {
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "queue-if-active",
      },
    });
  });

  it("bb thread tell --mode auto preserves explicit legacy auto delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-auto-tell", "hello", "--mode", "auto"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-auto-tell" },
      json: {
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "auto",
      },
    });
  });

  it("bb thread tell forwards execution options", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-execution-options",
        "hello",
        "--model",
        "gpt-5.5",
        "--service-tier",
        "fast",
        "--reasoning-level",
        "high",
        "--permission-mode",
        "accept-edits",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-execution-options" },
      json: {
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "steer-if-active",
        model: "gpt-5.5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      },
    });
  });

  it("bb thread tell forwards automatic review mode", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-auto-review",
        "hello",
        "--permission-mode",
        "auto",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-auto-review" },
      json: {
        input: [{ type: "text", text: "hello", mentions: [] }],
        mode: "steer-if-active",
        permissionMode: "auto",
      },
    });
  });

  it("bb thread tell --plan sends the composer's /plan command mention", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-plan",
        "add a README",
        "--plan",
        "--file",
        "/tmp/report.pdf",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-plan" },
      json: {
        input: [
          {
            type: "text",
            text: "/plan add a README",
            mentions: [
              {
                start: 0,
                end: 5,
                resource: {
                  kind: "command",
                  trigger: "/",
                  name: "plan",
                  source: "command",
                  origin: "builtin",
                  label: "plan",
                  argumentHint: null,
                },
              },
            ],
          },
          { type: "localFile", path: "/tmp/report.pdf" },
        ],
        mode: "steer-if-active",
      },
    });
  });

  it("bb thread tell forwards host-readable paths without reading them on the CLI machine", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-attachments",
        "review these",
        "--file",
        "/tmp/report.pdf",
        "--image",
        "/tmp/screenshot.png",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-attachments" },
      json: {
        input: [
          { type: "text", text: "review these", mentions: [] },
          { type: "localFile", path: "/tmp/report.pdf" },
          { type: "localImage", path: "/tmp/screenshot.png" },
        ],
        mode: "steer-if-active",
      },
    });
  });

  it("bb thread tell includes sender thread metadata when run inside another thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-sender");
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-receiver", "hello from sender"],
      register,
    );

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-receiver" },
      json: {
        input: [{ type: "text", text: "hello from sender", mentions: [] }],
        mode: "steer-if-active",
        senderThreadId: "thread-sender",
      },
    });
  });

  it("bb thread tell omits sender metadata when targeting the current thread", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-self");
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-self", "self note"], register);

    expect(post).toHaveBeenCalledWith({
      param: { id: "thread-self" },
      json: {
        input: [{ type: "text", text: "self note", mentions: [] }],
        mode: "steer-if-active",
      },
    });
  });
});
