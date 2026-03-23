import { describe, expect, it } from "vitest";
import {
  createHostDaemonClient,
  hostDaemonCommandSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
} from "../src/index.js";

describe("host-daemon command schemas", () => {
  it("parses valid workspace and provisioning commands", () => {
    expect(
      hostDaemonCommandSchema.parse({
        type: "workspace.commit",
        message: "Checkpoint work",
        includeUnstaged: true,
      }),
    ).toMatchObject({
      type: "workspace.commit",
      message: "Checkpoint work",
    });

    expect(
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        projectId: "proj_123",
        strategy: "worktree",
        sourcePath: "/tmp/project",
        targetPath: "/tmp/project/.bb/env",
        branchName: "bb/env-123",
      }),
    ).toMatchObject({
      type: "environment.provision",
      strategy: "worktree",
    });
  });

  it("rejects invalid command payloads", () => {
    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "workspace.commit",
        message: "",
      }),
    ).toThrow();

    expect(() =>
      hostDaemonCommandSchema.parse({
        type: "environment.provision",
        projectId: "proj_123",
        strategy: "clone",
        targetPath: "/tmp/project/.bb/env",
      }),
    ).not.toThrow();
  });
});

describe("host-daemon session schemas", () => {
  it("parses valid session open and event batch payloads", () => {
    expect(
      hostDaemonSessionOpenRequestSchema.parse({
        hostId: "host_123",
        instanceId: "instance_1",
        hostName: "Michael's MacBook",
        hostType: "persistent",
        protocolVersion: 1,
        activeThreads: [
          {
            environmentId: "env_123",
            threadId: "thr_123",
            providerThreadId: "provider_thr_123",
          },
        ],
      }),
    ).toMatchObject({
      hostId: "host_123",
      hostType: "persistent",
    });

    expect(
      hostDaemonSessionOpenResponseSchema.parse({
        sessionId: "session_123",
        heartbeatIntervalMs: 5_000,
        leaseTimeoutMs: 30_000,
      }),
    ).toMatchObject({
      sessionId: "session_123",
    });

    expect(
      hostDaemonEventBatchRequestSchema.parse({
        sessionId: "session_123",
        events: [
          {
            id: "evt_1",
            environmentId: "env_123",
            threadId: "thr_123",
            sequence: 1,
            createdAt: 1,
            event: {
              type: "system/error",
              threadId: "thr_123",
              message: "boom",
            },
          },
        ],
      }),
    ).toMatchObject({
      sessionId: "session_123",
    });
  });

  it("builds an internal client rooted at /internal", () => {
    const client = createHostDaemonClient("http://localhost:3334", "secret");

    expect(client.session.open.$url().pathname).toBe("/internal/session/open");
    expect(client.session.commands.$url().pathname).toBe(
      "/internal/session/commands",
    );
  });
});
