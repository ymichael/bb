import { AbortError } from "p-retry";
import { describe, expect, it, vi } from "vitest";
import type { PendingInteractionCreate } from "@bb/domain";
import { createServerClient } from "./server-client.js";

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
      kind: "command_approval",
      itemId: "item-123",
      reason: "Needs approval",
      command: "git push",
      cwd: "/tmp/project",
      commandActions: [],
      requestedPermissions: null,
      availableDecisions: ["accept", "decline", "cancel"],
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

  it("retries transient interactive request registration failures", async () => {
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("unavailable", { status: 503 });
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
    const client = createServerClient({
      fetchFn,
      getSessionId: () => "session-1",
      hostKey: "host-key",
      logger: createLogger(),
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
  });
});
