import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemePreference } from "./useTheme";

interface ThemeTestEnvironment {
  classes: Set<string>;
  setSystemTheme: (prefersDark: boolean) => void;
  storage: Map<string, string>;
}

type MediaChangeListener = () => void;

function setupThemeEnvironment({
  storedTheme,
  prefersDark = false,
}: {
  storedTheme?: ThemePreference;
  prefersDark?: boolean;
} = {}): ThemeTestEnvironment {
  const classes = new Set<string>();
  const storage = new Map<string, string>();
  let mediaChangeListener: MediaChangeListener | null = null;

  if (storedTheme) {
    storage.set("bb.theme", storedTheme);
  }

  const classList = {
    contains: (token: string) => classes.has(token),
    toggle: (token: string, force?: boolean) => {
      const shouldAdd = force ?? !classes.has(token);
      if (shouldAdd) {
        classes.add(token);
      } else {
        classes.delete(token);
      }
      return shouldAdd;
    },
  };

  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  } satisfies Storage;

  const mediaQuery = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(
      (eventName: string, listener: MediaChangeListener) => {
        if (eventName === "change") {
          mediaChangeListener = listener;
        }
      },
    ),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  vi.stubGlobal("window", {
    localStorage,
    matchMedia: vi.fn().mockReturnValue(mediaQuery),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
    },
  });

  return {
    classes,
    setSystemTheme: (nextPrefersDark: boolean) => {
      mediaQuery.matches = nextPrefersDark;
      mediaChangeListener?.();
    },
    storage,
  };
}

describe("theme persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("applies the stored dark theme during initialization", async () => {
    const env = setupThemeEnvironment({ storedTheme: "dark" });
    const theme = await import("./useTheme");

    theme.initializePreferredTheme();

    expect(env.classes.has("dark")).toBe(true);
  });

  it("applies system dark mode when no explicit preference is stored", async () => {
    const env = setupThemeEnvironment({ prefersDark: true });
    const theme = await import("./useTheme");

    theme.initializePreferredTheme();

    expect(env.classes.has("dark")).toBe(true);
  });

  it("stores and applies selected theme changes", async () => {
    const env = setupThemeEnvironment();
    const theme = await import("./useTheme");

    theme.setPreferredTheme("dark");

    expect(env.storage.get(theme.THEME_STORAGE_KEY)).toBe("dark");
    expect(env.classes.has("dark")).toBe(true);
  });

  it("stores and applies system theme changes", async () => {
    const env = setupThemeEnvironment({ storedTheme: "dark" });
    const theme = await import("./useTheme");

    theme.initializePreferredTheme();
    theme.setPreferredTheme("system");

    expect(env.storage.get(theme.THEME_STORAGE_KEY)).toBe("system");
    expect(env.classes.has("dark")).toBe(false);
  });

  it("tracks system color scheme changes when system is selected", async () => {
    const env = setupThemeEnvironment({ prefersDark: true });
    const theme = await import("./useTheme");

    theme.initializePreferredTheme();
    expect(env.classes.has("dark")).toBe(true);

    env.setSystemTheme(false);

    expect(env.classes.has("dark")).toBe(false);
  });

  it("keeps an explicit theme during system color scheme changes", async () => {
    const env = setupThemeEnvironment({ storedTheme: "dark" });
    const theme = await import("./useTheme");

    theme.initializePreferredTheme();
    env.setSystemTheme(false);

    expect(env.classes.has("dark")).toBe(true);
  });
});
