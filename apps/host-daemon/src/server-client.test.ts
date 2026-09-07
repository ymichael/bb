import { AbortError } from "p-retry";
import { describe, expect, it, vi } from "vitest";
import type { PendingInteractionCreate } from "@bb/domain";
import { HOST_ARTIFACT_MAX_BYTES } from "@bb/host-daemon-contract/protocol";
import {
  createServerClient,
  readHostArtifactBytes,
  ServerResponseError,
  type FetchFn,
} from "./server-client.js";

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function createInteractiveRequest(): PendingInteractionCreate {
  return {
    threadId: "thr_123",
    turnId: "turn_123",
    providerId: "codex",
    providerThreadId: "provider-thread-123",
    providerRequestId: "request-123",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-123",
        command: "git push",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

describe("createServerClient", () => {
  it("narrows a protocol update retry request from error details", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      Response.json(
        {
          code: "protocol_version_mismatch",
          details: { retryUpdate: true },
          message: "protocol mismatch",
        },
        { status: 400 },
      ),
    );
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    const result = client.openSession({
      hostId: "host-1",
      hostName: "Host",
      hostType: "persistent",
      dataDir: "/tmp/bb",
      instanceId: "instance-1",
      localApiPort: null,
      activeThreads: [],
      loadedEnvironments: [],
    });

    await expect(result).rejects.toMatchObject({
      code: "protocol_version_mismatch",
      protocolUpdateRetryRequested: true,
    });
  });

  it.each([
    { machineCredential: "bbcm_machine", hasMachineCredential: true },
    { machineCredential: undefined, hasMachineCredential: false },
  ])(
    "reports live machine-credential capability as $hasMachineCredential",
    async ({ machineCredential, hasMachineCredential }) => {
      const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          hasMachineCredential,
          localApiPort: 38_888,
        });
        return Response.json(
          {
            sessionId: "session-1",
            heartbeatIntervalMs: 5_000,
            leaseTimeoutMs: 30_000,
          },
          { status: 201 },
        );
      });
      const client = createServerClient({
        fetchFn,
        getSessionId: () => "session-1",
        hostKey: "host-key",
        logger: createLogger(),
        ...(machineCredential !== undefined ? { machineCredential } : {}),
        serverUrl: "https://bb.example.test",
      });

      await client.openSession({
        hostId: "host-1",
        hostName: "Host",
        hostType: "persistent",
        dataDir: "/tmp/bb",
        instanceId: "instance-1",
        localApiPort: 38_888,
        activeThreads: [],
        loadedEnvironments: [],
      });
      expect(fetchFn).toHaveBeenCalledOnce();
    },
  );

  it("refuses to fetch project attachments over insecure non-loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://bb.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to fetch project attachments when the server URL is malformed", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "not a url",
    });

    await expect(
      client.fetchProjectAttachment({
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches project attachment bytes over HTTPS", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");
      expect(url.searchParams.get("sessionId")).toBe("session-1");
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      expect(url.searchParams.get("projectId")).toBe("project-1");
      expect(url.searchParams.get("path")).toBe("network-tab.har");
      return new Response("attachment-body", {
        headers: {
          "content-type": "application/octet-stream",
        },
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    const attachment = await client.fetchProjectAttachment({
      expectedSizeBytes: 15,
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe(
      "attachment-body",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetches and parses a skill tree over authenticated LAN HTTP", async () => {
    const treeHash = "a".repeat(64);
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/internal/skills/tree/${treeHash}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-key",
      );
      expect(new Headers(init?.headers).get("x-bb-connect-machine")).toBeNull();
      return new Response(
        JSON.stringify({
          treeHash,
          entries: [
            { path: "SKILL.md", mode: 0o644, contentBase64: "dHJlZQ==" },
          ],
        }),
        { status: 200 },
      );
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://192.168.1.10:3000",
    });

    await expect(client.fetchSkillTree(treeHash)).resolves.toEqual({
      treeHash,
      entries: [{ path: "SKILL.md", mode: 0o644, contentBase64: "dHJlZQ==" }],
    });
  });

  it("rejects oversized host artifacts before fetching them", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.fetchPluginHostArtifact({
        pluginId: "fixture",
        digest: "a".repeat(64),
        expectedByteLength: HOST_ARTIFACT_MAX_BYTES + 1,
      }),
    ).rejects.toThrow(/exceeds the .* byte limit/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stops a chunked host artifact response at the byte limit", async () => {
    const chunkBytes = 1024 * 1024;
    const maxBytes = chunkBytes * 2;
    let emittedChunks = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          emittedChunks += 1;
          controller.enqueue(new Uint8Array(chunkBytes));
          if (emittedChunks === 32) controller.close();
        },
        cancel,
      }),
      { status: 200 },
    );

    await expect(
      readHostArtifactBytes(response, maxBytes + chunkBytes * 2, maxBytes),
    ).rejects.toThrow(/exceeds the .* byte limit/u);
    expect(emittedChunks).toBeLessThan(32);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("adds the connect machine credential to internal HTTP requests", async () => {
    const treeHash = "b".repeat(64);
    const fetchFn = vi.fn<FetchFn>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer host-key");
      expect(headers.get("x-bb-connect-machine")).toBe("bbcm_machine");
      return new Response(JSON.stringify({ treeHash, entries: [] }), {
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      machineCredential: "bbcm_machine",
      serverUrl: "https://bb.example.test",
    });

    await client.fetchSkillTree(treeHash);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects project attachment responses with unexpected byte length", async () => {
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response("too-large", {
          status: 200,
        }),
    );
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.fetchProjectAttachment({
        expectedSizeBytes: 4,
        maxBytes: 25,
        projectId: "project-1",
        threadId: "thread-1",
        path: "network-tab.har",
      }),
    ).rejects.toThrow("Project attachment size mismatch");
  });

  it("fetches project attachment bytes over loopback HTTP", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/internal/session/project-attachment-content");
      return new Response("loopback-body", {
        status: 200,
      });
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://127.0.0.1:3334",
    });

    const attachment = await client.fetchProjectAttachment({
      maxBytes: 25,
      projectId: "project-1",
      threadId: "thread-1",
      path: "network-tab.har",
    });

    expect(Buffer.from(attachment.bytes).toString("utf8")).toBe(
      "loopback-body",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns accepted event mappings when posting events", async () => {
    const fetchFn = vi.fn<FetchFn>(async (input, init) => {
      expect(String(input)).toContain("/internal/session/events");
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: "session-1",
        eventGroups: [
          {
            threadId: "thr_123",
            events: [
              {
                type: "turn/started",
                threadId: "thr_123",
                providerThreadId: "provider-thread",
                scope: { kind: "turn", turnId: "turn-1" },
              },
            ],
          },
        ],
      });
      return new Response(
        JSON.stringify({
          acceptedEvents: [
            {
              eventIndex: 0,
              sequence: 6,
              threadId: "thr_123",
            },
          ],
          rejectedEvents: [],
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.postEvents([
        {
          threadId: "thr_123",
          event: {
            type: "turn/started",
            threadId: "thr_123",
            providerThreadId: "provider-thread",
            scope: { kind: "turn", turnId: "turn-1" },
          },
        },
      ]),
    ).resolves.toEqual({
      acceptedEvents: [
        {
          eventIndex: 0,
          sequence: 6,
          threadId: "thr_123",
        },
      ],
      rejectedEvents: [],
    });
  });

  it("retries retryable interactive request registration responses after the attempt hook", async () => {
    let calls = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            code: "turn_start_not_ready",
            message:
              "Turn start has not been stored yet; retry interactive request registration",
            retryable: true,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        );
      }

      return new Response(
        JSON.stringify({
          outcome: "created",
          interactionId: "pint_123",
          status: "pending",
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      );
    });
    const beforeAttempt = vi.fn(async () => undefined);
    const logger = createLogger();
    const client = createServerClient({
      beforeInteractiveRequestRegistrationAttempt: beforeAttempt,
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://bb.example.test",
    });

    await expect(
      client.registerInteractiveRequest(createInteractiveRequest()),
    ).resolves.toEqual({
      outcome: "created",
      interactionId: "pint_123",
      status: "pending",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        retriesLeft: expect.any(Number),
      }),
      "interactive request registration failed, retrying",
    );
  });

  it("does not retry non-retryable 503 interactive request registration responses", async () => {
    const fetchFn = vi.fn<FetchFn>(
      async () =>
        new Response(
          JSON.stringify({
            code: "maintenance",
            message: "Registration is disabled for this session",
            retryable: false,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 503,
          },
        ),
    );
    const logger = createLogger();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger,
      serverUrl: "https://bb.example.test",
    });

    const result = client.registerInteractiveRequest(
      createInteractiveRequest(),
    );

    await expect(result).rejects.toBeInstanceOf(ServerResponseError);
    await expect(result).rejects.toMatchObject({
      code: "maintenance",
      retryable: false,
      status: 503,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
