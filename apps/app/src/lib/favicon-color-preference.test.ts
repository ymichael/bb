// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppTheme } from "@bb/domain";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY,
  FAVICON_COLOR_STORAGE_KEY,
  useFaviconColorSync,
} from "./favicon-color-preference";

const mocks = vi.hoisted(() => ({
  updateAppearance: vi.fn(),
  useSystemConfig: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: mocks.useSystemConfig,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    theme: {
      set: mocks.updateAppearance,
    },
  },
}));

function setSystemFaviconColor(
  faviconColor: typeof defaultAppTheme.faviconColor,
): void {
  mocks.useSystemConfig.mockReturnValue({
    data: {
      appearance: {
        ...defaultAppTheme,
        faviconColor,
      },
    },
  });
}

describe("favicon color server sync", () => {
  afterEach(() => {
    window.localStorage.clear();
    cleanup();
    vi.clearAllMocks();
  });

  it("migrates a cached legacy tint when the server has no stored tint yet", async () => {
    window.localStorage.setItem(FAVICON_COLOR_STORAGE_KEY, "teal");
    setSystemFaviconColor("default");
    mocks.updateAppearance.mockResolvedValue(undefined);
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useFaviconColorSync(), { wrapper });

    await waitFor(() =>
      expect(mocks.updateAppearance).toHaveBeenCalledWith({
        themeId: "default",
        faviconColor: "teal",
      }),
    );
    expect(window.localStorage.getItem(FAVICON_COLOR_STORAGE_KEY)).toBe("teal");
    expect(
      window.localStorage.getItem(FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY),
    ).toBe("true");
  });

  it("does not restore a cached tint after the server value has been seen", async () => {
    window.localStorage.setItem(FAVICON_COLOR_STORAGE_KEY, "teal");
    setSystemFaviconColor("teal");
    const { wrapper } = createQueryClientTestHarness();
    const { rerender } = renderHook(() => useFaviconColorSync(), { wrapper });

    await waitFor(() =>
      expect(
        window.localStorage.getItem(FAVICON_COLOR_SERVER_SYNCED_STORAGE_KEY),
      ).toBe("true"),
    );

    mocks.updateAppearance.mockClear();
    setSystemFaviconColor("default");
    rerender();

    await waitFor(() =>
      expect(window.localStorage.getItem(FAVICON_COLOR_STORAGE_KEY)).toBeNull(),
    );
    expect(mocks.updateAppearance).not.toHaveBeenCalled();
  });
});

describe("favicon rendering", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
  });

  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: originalGetContext,
    });
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function stubDisplayMode(standalone: boolean): void {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(display-mode: standalone)" ? standalone : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
  }

  class FakeImage {
    static created = 0;
    naturalWidth = 32;
    naturalHeight = 32;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      FakeImage.created += 1;
      queueMicrotask(() => this.onload?.());
    }
  }

  async function loadFreshModule() {
    return import("./favicon-color-preference");
  }

  it("decodes each base glyph once across badge flips", async () => {
    stubDisplayMode(false);
    FakeImage.created = 0;
    vi.stubGlobal("Image", FakeImage);
    const module = await loadFreshModule();
    module.initializeFavicon();

    const initialProps: { badge: "none" | "unread" } = { badge: "unread" };
    const { rerender, unmount } = renderHook(
      ({ badge }: { badge: "none" | "unread" }) =>
        module.useFaviconBadge(badge),
      { initialProps },
    );
    await waitFor(() => expect(FakeImage.created).toBe(2));

    rerender({ badge: "none" });
    rerender({ badge: "unread" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeImage.created).toBe(2);
    unmount();
  });

  it("skips favicon image work in standalone display mode", async () => {
    stubDisplayMode(true);
    FakeImage.created = 0;
    vi.stubGlobal("Image", FakeImage);
    const module = await loadFreshModule();
    module.initializeFavicon();

    const { unmount } = renderHook(() => module.useFaviconBadge("unread"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeImage.created).toBe(0);
    unmount();
  });
});
