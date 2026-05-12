import { AbortError } from "p-retry";
import { describe, expect, it, vi } from "vitest";
import type { PendingInteractionCreate } from "@bb/domain";
import { createServerClient, ServerResponseError } from "./server-client.js";

function createLogger() {
  return {
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
  it("refuses to fetch runtime material over insecure non-loopback HTTP", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
      serverUrl: "http://bb.example.test",
    });

    await expect(
      client.fetchRuntimeMaterial({
        version: "runtime-version-1",
      }),
    ).rejects.toBeInstanceOf(AbortError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to fetch project attachments over insecure non-loopback HTTP", async () => {
    const fetchFn = vi.fn<typeof fetch>();
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
    const fetchFn = vi.fn<typeof fetch>();
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

  it("fetches runtime material over HTTPS", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      expect(url).toContain("/internal/session/runtime-material");
      expect(url).toContain("sessionId=session-1");
      expect(url).toContain("version=runtime-version-1");
      return new Response(
        JSON.stringify({
          env: {
            OPENAI_API_KEY: "test-openai-key",
          },
          files: [
            {
              contents: "{}\n",
              managedBy: "bb-runtime-material",
              mode: 0o600,
              path: "~/.codex/auth.json",
            },
          ],
          version: "runtime-version-1",
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
      client.fetchRuntimeMaterial({
        version: "runtime-version-1",
      }),
    ).resolves.toEqual({
      env: {
        OPENAI_API_KEY: "test-openai-key",
      },
      files: [
        {
          contents: "{}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fetches project attachment bytes over HTTPS", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
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

  it("rejects project attachment responses with unexpected byte length", async () => {
    const fetchFn = vi.fn<typeof fetch>(
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
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
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
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toContain("/internal/session/events");
      return new Response(
        JSON.stringify({
          acceptedEvents: [
            {
              producerEventId: "hdevt_23456789abcdefghijkm",
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
          producerEventId: "hdevt_23456789abcdefghijkm",
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
          producerEventId: "hdevt_23456789abcdefghijkm",
          sequence: 6,
          threadId: "thr_123",
        },
      ],
      kind: "accepted",
      rejectedEvents: [],
    });
  });

  it("retries retryable interactive request registration responses after the attempt hook", async () => {
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
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
    const fetchFn = vi.fn<typeof fetch>(
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
