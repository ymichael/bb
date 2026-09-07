// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ResolvedThreadExecutionOptions } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadDefaultExecutionOptions } from "./thread-default-execution-options-query";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      defaultExecutionOptions: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

const RESOLVED: ResolvedThreadExecutionOptions = {
  model: "gpt-5.6-sol",
  serviceTier: "default",
  reasoningLevel: "xhigh",
  permissionMode: "full",
  source: "client/turn/start",
};

const pendingForever = () => new Promise<never>(() => {});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("useThreadDefaultExecutionOptions", () => {
  it("replays the thread's last resolution as placeholder data on the next mount", async () => {
    vi.mocked(sdk.threads.defaultExecutionOptions).mockResolvedValue(RESOLVED);
    const first = createQueryClientTestHarness();
    const warm = renderHook(() => useThreadDefaultExecutionOptions("thr_1"), {
      wrapper: first.wrapper,
    });
    await waitFor(() => expect(warm.result.current.data).toEqual(RESOLVED));
    expect(warm.result.current.isPlaceholderData).toBe(false);
    warm.unmount();

    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      pendingForever,
    );
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadDefaultExecutionOptions("thr_1"),
      { wrapper: reload.wrapper },
    );
    expect(result.current.data).toEqual(RESOLVED);
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() =>
      expect(sdk.threads.defaultExecutionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thr_1" }),
      ),
    );
  });

  it("does not replay one thread's resolution for another", async () => {
    vi.mocked(sdk.threads.defaultExecutionOptions).mockResolvedValue(RESOLVED);
    const first = createQueryClientTestHarness();
    const warm = renderHook(() => useThreadDefaultExecutionOptions("thr_1"), {
      wrapper: first.wrapper,
    });
    await waitFor(() => expect(warm.result.current.data).toEqual(RESOLVED));
    warm.unmount();

    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      pendingForever,
    );
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadDefaultExecutionOptions("thr_2"),
      { wrapper: reload.wrapper },
    );
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it("does not remember an unresolved (null) answer", async () => {
    vi.mocked(sdk.threads.defaultExecutionOptions).mockResolvedValue(null);
    const first = createQueryClientTestHarness();
    const warm = renderHook(() => useThreadDefaultExecutionOptions("thr_1"), {
      wrapper: first.wrapper,
    });
    await waitFor(() => expect(warm.result.current.data).toBeNull());
    warm.unmount();

    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      pendingForever,
    );
    const reload = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadDefaultExecutionOptions("thr_1"),
      { wrapper: reload.wrapper },
    );
    expect(result.current.data).toBeUndefined();
  });

  it("ignores a stored value that no longer matches the schema", async () => {
    window.localStorage.setItem(
      "bb.thread-execution-options.1.thr_1",
      JSON.stringify({ model: "gpt-5.6-sol", reasoningLevel: "cosmic" }),
    );
    vi.mocked(sdk.threads.defaultExecutionOptions).mockImplementation(
      pendingForever,
    );
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadDefaultExecutionOptions("thr_1"),
      { wrapper },
    );
    expect(result.current.data).toBeUndefined();
  });
});
