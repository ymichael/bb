import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandFetchLoop } from "./app.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createCommandFetchLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries fetching commands after transient failures", async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const fetchCommands = vi
      .fn<(_: { afterCursor: number }) => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([]);
    const handleCommands = vi.fn(async () => undefined);
    const loop = createCommandFetchLoop({
      logger,
      getCursor: () => 0,
      fetchCommands,
      handleCommands,
    });

    await loop.request();

    expect(fetchCommands).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchCommands).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(fetchCommands).toHaveBeenCalledTimes(2);
    });
    expect(handleCommands).not.toHaveBeenCalled();
  });
});
