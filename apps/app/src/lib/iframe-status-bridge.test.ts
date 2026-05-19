// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  executeIframeStatusRead,
  executeIframeStatusWrite,
  handleIframeStatusRequest,
  parseIframeStatusBridgeRequest,
} from "./iframe-status-bridge";

function jsonResponse(
  body: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("parseIframeStatusBridgeRequest", () => {
  it("accepts well-formed read messages", () => {
    expect(
      parseIframeStatusBridgeRequest({
        id: 1,
        type: "bb-status:read",
        path: "STATUS_DATA.json",
      }),
    ).toEqual({
      id: 1,
      type: "bb-status:read",
      path: "STATUS_DATA.json",
    });
  });

  it("accepts write messages and preserves the data payload", () => {
    expect(
      parseIframeStatusBridgeRequest({
        id: 7,
        type: "bb-status:write",
        path: "STATUS_DATA.json",
        data: { hello: "world" },
      }),
    ).toEqual({
      id: 7,
      type: "bb-status:write",
      path: "STATUS_DATA.json",
      data: { hello: "world" },
    });
  });

  it("rejects malformed messages", () => {
    expect(parseIframeStatusBridgeRequest(null)).toBeNull();
    expect(parseIframeStatusBridgeRequest("hello")).toBeNull();
    expect(parseIframeStatusBridgeRequest({ id: "x" })).toBeNull();
    expect(
      parseIframeStatusBridgeRequest({
        id: 1,
        type: "other",
        path: "STATUS_DATA.json",
      }),
    ).toBeNull();
    expect(
      parseIframeStatusBridgeRequest({
        id: 1,
        type: "bb-status:read",
        path: "",
      }),
    ).toBeNull();
  });
});

describe("executeIframeStatusRead", () => {
  it("parses JSON responses to objects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ todos: ["a"] }));

    const result = await executeIframeStatusRead({
      fetchImpl,
      path: "STATUS_DATA.json",
      threadId: "thr_xyz",
    });

    expect(result).toEqual({ todos: ["a"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [requestedUrl, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(requestedUrl)).toContain(
      "/api/v1/threads/thr_xyz/thread-storage/content",
    );
    expect(String(requestedUrl)).toContain("path=STATUS_DATA.json");
    expect(init).toMatchObject({ method: "GET" });
  });

  it("returns null on 404", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 404 }));

    await expect(
      executeIframeStatusRead({
        fetchImpl,
        path: "STATUS_DATA.json",
        threadId: "thr_xyz",
      }),
    ).resolves.toBeNull();
  });

  it("throws on other HTTP failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(
      executeIframeStatusRead({
        fetchImpl,
        path: "STATUS_DATA.json",
        threadId: "thr_xyz",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("executeIframeStatusWrite", () => {
  it("sends a JSON-stringified payload with application/json", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, path: "STATUS_DATA.json", sizeBytes: 9 }),
      );

    await executeIframeStatusWrite({
      data: { todos: [] },
      fetchImpl,
      path: "STATUS_DATA.json",
      threadId: "thr_xyz",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ todos: [] }),
    });
  });

  it("sends strings as text/plain without re-encoding", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ ok: true, path: "NOTES.txt", sizeBytes: 5 }),
      );

    await executeIframeStatusWrite({
      data: "hello",
      fetchImpl,
      path: "NOTES.txt",
      threadId: "thr_xyz",
    });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
  });

  it("throws on non-OK responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 413 }));

    await expect(
      executeIframeStatusWrite({
        data: { huge: true },
        fetchImpl,
        path: "STATUS_DATA.json",
        threadId: "thr_xyz",
      }),
    ).rejects.toThrow(/HTTP 413/);
  });
});

describe("handleIframeStatusRequest", () => {
  it("relays a read request and returns ok=true with data", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ hi: "there" }));

    const result = await handleIframeStatusRequest({
      fetchImpl,
      request: { id: 1, type: "bb-status:read", path: "STATUS_DATA.json" },
      threadId: "thr_xyz",
    });

    expect(result).toEqual({
      id: 1,
      type: "bb-status:result",
      ok: true,
      data: { hi: "there" },
    });
  });

  it("relays a write request and returns ok=true", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: true }));

    const result = await handleIframeStatusRequest({
      fetchImpl,
      request: {
        id: 9,
        type: "bb-status:write",
        path: "STATUS_DATA.json",
        data: { v: 1 },
      },
      threadId: "thr_xyz",
    });

    expect(result).toEqual({ id: 9, type: "bb-status:result", ok: true });
  });

  it("returns ok=false with the error message on failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("oops", { status: 500 }));

    const result = await handleIframeStatusRequest({
      fetchImpl,
      request: { id: 2, type: "bb-status:read", path: "STATUS_DATA.json" },
      threadId: "thr_xyz",
    });

    expect(result).toMatchObject({
      id: 2,
      type: "bb-status:result",
      ok: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("HTTP 500");
    }
  });
});
