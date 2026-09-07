import { describe, expect, it, vi } from "vitest";
import {
  fetchOAuthRefresh,
  TransientOAuthRefreshError,
} from "./provider-adapter.js";

describe("OAuth refresh transport", () => {
  it("classifies rejected responses even when cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    await expect(
      fetchOAuthRefresh(
        {
          fetch: async () =>
            new Response(new ReadableStream({ cancel }), { status: 503 }),
          now: () => 0,
        },
        "https://auth.example/token",
        { refresh_token: "refresh" },
      ),
    ).rejects.toBeInstanceOf(TransientOAuthRefreshError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["request", "body"])(
    "bounds a %s transport that ignores abort",
    async (stage) => {
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(controller.signal);
      try {
        const refresh = fetchOAuthRefresh(
          {
            fetch: async () =>
              stage === "request"
                ? new Promise<Response>(() => {})
                : new Response(new ReadableStream()),
            now: () => 0,
          },
          "https://auth.example/token",
          { refresh_token: "refresh" },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort(
          new DOMException("OAuth request timed out", "TimeoutError"),
        );
        await expect(refresh).rejects.toBeInstanceOf(
          TransientOAuthRefreshError,
        );
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it.each([
    { status: 400, transient: false },
    { status: 401, transient: false },
    { status: 408, transient: true },
    { status: 429, transient: true },
    { status: 500, transient: true },
    { status: 503, transient: true },
  ])(
    "cancels HTTP $status responses before classifying them",
    async ({ status, transient }) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "retry-after": "120" },
      });
      const refresh = fetchOAuthRefresh(
        { fetch: async () => response, now: () => 1_800_000_000_000 },
        "https://auth.example/token",
        { refresh_token: "refresh" },
      );
      await expect(refresh).rejects.toThrow(
        `OAuth refresh failed with HTTP ${status}.`,
      );
      if (transient) {
        await expect(refresh).rejects.toBeInstanceOf(
          TransientOAuthRefreshError,
        );
        await expect(refresh).rejects.toMatchObject({ retryAfterMs: 120_000 });
      } else {
        await expect(refresh).rejects.not.toBeInstanceOf(
          TransientOAuthRefreshError,
        );
      }
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["request", "response"])(
    "classifies a broken %s connection as transient",
    async (stage) => {
      const refresh = fetchOAuthRefresh(
        {
          fetch: async () => {
            if (stage === "request") throw new TypeError("fetch failed");
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError("socket closed"));
                },
              }),
            );
          },
          now: () => 1_800_000_000_000,
        },
        "https://auth.example/token",
        { refresh_token: "refresh" },
      );
      await expect(refresh).rejects.toBeInstanceOf(TransientOAuthRefreshError);
    },
  );

  it("times out a pending OAuth request independently of its callers", async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal);
    try {
      const refresh = fetchOAuthRefresh(
        {
          fetch: async (_input, init) => {
            const signal = init?.signal;
            if (signal === null || signal === undefined)
              return Response.json({});
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
          now: () => 1_800_000_000_000,
        },
        "https://auth.example/token",
        { refresh_token: "refresh" },
      );
      controller.abort(
        new DOMException("OAuth request timed out", "TimeoutError"),
      );
      await expect(refresh).rejects.toBeInstanceOf(TransientOAuthRefreshError);
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
