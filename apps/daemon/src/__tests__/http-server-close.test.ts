import { describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  type ClosableHttpServer,
} from "../http-server-close.js";

describe("closeHttpServer", () => {
  it("resolves immediately when the server closes cleanly", async () => {
    vi.useFakeTimers();

    let closeCallback: ((error?: Error) => void) | undefined;
    const server: ClosableHttpServer = {
      close: vi.fn((callback) => {
        closeCallback = callback;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    const closed = closeHttpServer(server);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);

    closeCallback?.();
    await closed;

    await vi.advanceTimersByTimeAsync(100);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("force-closes lingering connections after a short grace period", async () => {
    vi.useFakeTimers();

    let closeCallback: ((error?: Error) => void) | undefined;
    const server: ClosableHttpServer = {
      close: vi.fn((callback) => {
        closeCallback = callback;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => {
        closeCallback?.();
      }),
    };

    const closed = closeHttpServer(server);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await closed;

    expect(server.closeIdleConnections).toHaveBeenCalledTimes(2);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("resolves when server.close throws", async () => {
    const server: ClosableHttpServer = {
      close: vi.fn(() => {
        throw new Error("close failed");
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
    expect(server.closeIdleConnections).not.toHaveBeenCalled();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });
});
