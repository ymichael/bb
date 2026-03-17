import { describe, expect, it } from "vitest";
import { ProviderToolHost } from "../provider-tool-host.js";

describe("ProviderToolHost", () => {
  it("lists provider-visible tool specs", () => {
    const host = new ProviderToolHost([
      {
        name: "echo",
        description: "Echo input",
        inputSchema: { type: "object" },
        execute: () => "ok",
      },
    ]);

    expect(host.listTools()).toEqual([
      {
        name: "echo",
        description: "Echo input",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("normalizes string tool results to successful text content", async () => {
    const host = new ProviderToolHost([
      {
        name: "echo",
        description: "Echo input",
        inputSchema: { type: "object" },
        execute: () => "hello",
      },
    ]);

    await expect(
      host.execute({
        call: {
          requestId: 1,
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "echo",
          arguments: {},
        },
        context: {
          projectId: "proj-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "hello",
        },
      ],
    });
  });

  it("returns structured failure for unknown tools", async () => {
    const host = new ProviderToolHost([]);

    await expect(
      host.execute({
        call: {
          requestId: 1,
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "missing",
          arguments: {},
        },
        context: {
          projectId: "proj-1",
          threadId: "thread-1",
        },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Unknown tool: missing",
        },
      ],
    });
  });
});
