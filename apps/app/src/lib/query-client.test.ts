// @vitest-environment jsdom

import { QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppQueryClient,
  installAppQueryClientBrowserEvents,
} from "./query-client";

describe("createAppQueryClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refetches active failed queries after a mobile history restore", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    queryClient.mount();

    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("mobile page restore interrupted fetch"))
      .mockResolvedValueOnce("loaded");
    const observer = new QueryObserver(queryClient, {
      queryKey: ["mobile-restore"],
      queryFn,
      refetchOnWindowFocus: true,
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().isError).toBe(true);
    });

    window.dispatchEvent(new Event("pageshow"));

    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(observer.getCurrentResult().data).toBe("loaded");
    });

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("cancels active query fetches before mobile page suspension can fail them", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    const lifecycleEvents = installAppQueryClientBrowserEvents(queryClient);
    queryClient.mount();

    const signals: AbortSignal[] = [];
    const resolveFetches: Array<(value: string) => void> = [];
    const queryFn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          signals.push(signal);
          resolveFetches.push(resolve);
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const observer = new QueryObserver(queryClient, {
      queryKey: ["mobile-suspend"],
      queryFn,
      refetchOnWindowFocus: true,
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
    });

    window.dispatchEvent(new Event("pagehide"));

    await vi.waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
      expect(observer.getCurrentResult().isError).toBe(false);
      expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    });

    window.dispatchEvent(new Event("pageshow"));

    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    resolveFetches[1]?.("loaded");

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("loaded");
    });

    unsubscribe();
    lifecycleEvents.cleanup();
    queryClient.unmount();
    queryClient.clear();
  });

  it("keeps the default focus refetch when no gate is configured", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    queryClient.mount();

    const queryFn = vi.fn(() => Promise.resolve("data"));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["focus-ungated"],
      queryFn,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("data");
    });

    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("skips the default focus refetch while the gate reports realtime coverage", async () => {
    let realtimeConnected = true;
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      shouldRefetchOnWindowFocus: () => !realtimeConnected,
      showMutationErrorToasts: false,
    });
    queryClient.mount();

    const queryFn = vi.fn(() => Promise.resolve("data"));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["focus-gated"],
      queryFn,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("data");
    });
    expect(queryFn).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("pageshow"));
    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(1);

    realtimeConnected = false;
    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("keeps the default reconnect refetch when no gate is configured", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    queryClient.mount();

    const queryFn = vi.fn(() => Promise.resolve("data"));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["reconnect-ungated"],
      queryFn,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("data");
    });

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("skips the default reconnect refetch while the gate reports realtime coverage", async () => {
    let realtimeConnected = true;
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      shouldRefetchOnWindowFocus: () => !realtimeConnected,
      showMutationErrorToasts: false,
    });
    queryClient.mount();

    const queryFn = vi.fn(() => Promise.resolve("data"));
    const observer = new QueryObserver(queryClient, {
      queryKey: ["reconnect-gated"],
      queryFn,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("data");
    });
    expect(queryFn).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(1);

    realtimeConnected = false;
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });

    unsubscribe();
    queryClient.unmount();
    queryClient.clear();
  });

  it("resumes a suspend-cancelled fetch that no focus refetch would restart", async () => {
    const queryClient = createAppQueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
      showMutationErrorToasts: false,
    });
    const lifecycleEvents = installAppQueryClientBrowserEvents(queryClient);
    queryClient.mount();

    const resolveFetches: Array<(value: string) => void> = [];
    const queryFn = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          resolveFetches.push(resolve);
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const observer = new QueryObserver(queryClient, {
      queryKey: ["realtime-owned-first-load"],
      queryFn,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    });
    const unsubscribe = observer.subscribe(() => {});
    const settledFn = vi.fn(() => Promise.resolve("settled"));
    const settledObserver = new QueryObserver(queryClient, {
      queryKey: ["settled"],
      queryFn: settledFn,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    });
    const unsubscribeSettled = settledObserver.subscribe(() => {});

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().fetchStatus).toBe("fetching");
      expect(settledObserver.getCurrentResult().data).toBe("settled");
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(observer.getCurrentResult().fetchStatus).toBe("idle");
      expect(observer.getCurrentResult().data).toBeUndefined();
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(queryFn).toHaveBeenCalledTimes(2);
    });
    resolveFetches[1]?.("loaded");
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe("loaded");
    });
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(settledFn).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribeSettled();
    lifecycleEvents.cleanup();
    queryClient.unmount();
    queryClient.clear();
    Reflect.deleteProperty(document, "visibilityState");
  });
});
