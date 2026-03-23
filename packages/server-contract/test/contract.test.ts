import { describe, expect, it } from "vitest";
import {
  createPublicApiClient,
  createThreadRequestSchema,
  environmentOperationRequestSchema,
  sendMessageRequestSchema,
  timelineToolDetailsResponseSchema,
} from "../src/index.js";

describe("server-contract renamed schemas", () => {
  it("parses renamed request aliases", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        input: [{ type: "text", text: "Ship it" }],
      }),
    ).toMatchObject({
      projectId: "proj_123",
    });

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "auto",
      }),
    ).toMatchObject({
      mode: "auto",
    });

    expect(
      environmentOperationRequestSchema.parse({
        operation: "commit",
        initiatingThreadId: "thr_123",
        options: { message: "Checkpoint" },
      }),
    ).toMatchObject({
      operation: "commit",
    });

    expect(
      timelineToolDetailsResponseSchema.parse({ messages: [] }),
    ).toEqual({ messages: [] });
  });
});

describe("server-contract clients", () => {
  it("builds renamed public routes", () => {
    const publicClient = createPublicApiClient("http://localhost:3334");

    expect(
      publicClient.threads[":id"].send.$url({ param: { id: "thr_123" } })
        .pathname,
    ).toBe("/api/v1/threads/thr_123/send");
    expect(
      publicClient.threads[":id"].timeline["tool-details"].$url({
        param: { id: "thr_123" },
        query: {
          turnId: "turn_1",
          sourceSeqStart: "1",
          sourceSeqEnd: "2",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/timeline/tool-details");
  });
});
