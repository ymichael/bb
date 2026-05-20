// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemVersionResponse } from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

const { toastFn, toastDismissFn } = vi.hoisted(() => ({
  toastFn: vi.fn(),
  toastDismissFn: vi.fn(),
}));

vi.mock("sonner", () => {
  const toast = Object.assign(toastFn, { dismiss: toastDismissFn });
  return { toast };
});

interface CapturedToastInvocation {
  message: string;
  options: {
    id: string;
    description: string;
    action: { label: string; onClick: () => void };
    onDismiss?: () => void;
  };
}

function readToastInvocation(callIndex: number): CapturedToastInvocation {
  const call = toastFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`No toast call at index ${callIndex}`);
  }
  const [message, options] = call as [
    string,
    CapturedToastInvocation["options"],
  ];
  return { message, options };
}

function stubFetchOnce(response: SystemVersionResponse): void {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function loadHook() {
  const { useUpdateAvailableToast } = await import("./useUpdateAvailableToast");
  return { useUpdateAvailableToast };
}

afterEach(() => {
  cleanup();
  toastFn.mockReset();
  toastDismissFn.mockReset();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  vi.resetModules();
});

describe("useUpdateAvailableToast", () => {
  beforeEach(() => {
    window.localStorage.clear();
    toastFn.mockReset();
    toastDismissFn.mockReset();
  });

  it("shows the toast when an update is available and not yet dismissed", async () => {
    stubFetchOnce({
      currentVersion: "0.0.5",
      latestVersion: "0.0.6",
      source: "npm",
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
    const invocation = readToastInvocation(0);
    expect(invocation.message).toBe("Update available: bb-app 0.0.6");
    expect(invocation.options.description).toContain("npx bb-app@latest");
    expect(invocation.options.id).toBe("bb-update-available:0.0.6");
    expect(invocation.options.action.label).toBe("Dismiss");
  });

  it("never shows the toast in development mode", async () => {
    stubFetchOnce({
      currentVersion: "0.0.0-dev",
      latestVersion: null,
      source: "npm",
      updateAvailable: false,
      isDevelopment: true,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toastFn).not.toHaveBeenCalled();
  });

  it("does not show the toast when updateAvailable is false", async () => {
    stubFetchOnce({
      currentVersion: "0.0.6",
      latestVersion: "0.0.6",
      source: "npm",
      updateAvailable: false,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toastFn).not.toHaveBeenCalled();
  });

  it("respects an existing dismissal for the same latest version", async () => {
    window.localStorage.setItem(
      "bb:update-toast:dismissed:0.0.6",
      "true",
    );
    stubFetchOnce({
      currentVersion: "0.0.5",
      latestVersion: "0.0.6",
      source: "npm",
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(toastFn).not.toHaveBeenCalled();
  });

  it("persists the dismissal in localStorage when the user clicks Dismiss", async () => {
    stubFetchOnce({
      currentVersion: "0.0.5",
      latestVersion: "0.0.6",
      source: "npm",
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
    const invocation = readToastInvocation(0);
    invocation.options.action.onClick();
    expect(
      window.localStorage.getItem("bb:update-toast:dismissed:0.0.6"),
    ).toBe("true");
    expect(toastDismissFn).toHaveBeenCalledWith("bb-update-available:0.0.6");
  });

  it("shows the toast again when npm reports a newer version after a prior dismissal", async () => {
    window.localStorage.setItem(
      "bb:update-toast:dismissed:0.0.6",
      "true",
    );
    stubFetchOnce({
      currentVersion: "0.0.5",
      latestVersion: "0.0.7",
      source: "npm",
      updateAvailable: true,
      isDevelopment: false,
      upgradeCommand: "npx bb-app@latest",
    });
    const { useUpdateAvailableToast } = await loadHook();
    const { wrapper } = createQueryClientTestHarness();
    renderHook(() => useUpdateAvailableToast(), { wrapper });

    await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
    const invocation = readToastInvocation(0);
    expect(invocation.message).toBe("Update available: bb-app 0.0.7");
  });

  it("fails open when localStorage throws on read and write", async () => {
    const originalGetItem = window.localStorage.getItem.bind(
      window.localStorage,
    );
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    const getItemSpy = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("private mode: getItem disabled");
      });
    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("private mode: setItem disabled");
      });

    try {
      stubFetchOnce({
        currentVersion: "0.0.5",
        latestVersion: "0.0.6",
        source: "npm",
        updateAvailable: true,
        isDevelopment: false,
        upgradeCommand: "npx bb-app@latest",
      });
      const { useUpdateAvailableToast } = await loadHook();
      const { wrapper } = createQueryClientTestHarness();
      renderHook(() => useUpdateAvailableToast(), { wrapper });

      await waitFor(() => expect(toastFn).toHaveBeenCalledTimes(1));
      const invocation = readToastInvocation(0);
      // Dismiss must not throw even though setItem will throw.
      expect(() => invocation.options.action.onClick()).not.toThrow();
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
      window.localStorage.getItem = originalGetItem;
      window.localStorage.setItem = originalSetItem;
    }
  });
});
