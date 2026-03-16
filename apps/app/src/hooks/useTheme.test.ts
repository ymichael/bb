import { afterEach, describe, expect, it, vi } from "vitest"

interface ThemeTestEnvironment {
  classes: Set<string>
  storage: Map<string, string>
}

function setupThemeEnvironment({
  storedTheme,
  prefersDark = false,
}: {
  storedTheme?: "light" | "dark"
  prefersDark?: boolean
} = {}): ThemeTestEnvironment {
  const classes = new Set<string>()
  const storage = new Map<string, string>()

  if (storedTheme) {
    storage.set("bb.theme", storedTheme)
  }

  const classList = {
    contains: (token: string) => classes.has(token),
    toggle: (token: string, force?: boolean) => {
      const shouldAdd = force ?? !classes.has(token)
      if (shouldAdd) {
        classes.add(token)
      } else {
        classes.delete(token)
      }
      return shouldAdd
    },
  }

  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
    clear: () => {
      storage.clear()
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size
    },
  } satisfies Storage

  const mediaQuery = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList

  vi.stubGlobal(
    "window",
    {
      localStorage,
      matchMedia: vi.fn().mockReturnValue(mediaQuery),
      addEventListener: vi.fn(),
    } as unknown as Window & typeof globalThis,
  )
  vi.stubGlobal(
    "document",
    {
      documentElement: {
        classList,
      },
    } as unknown as Document,
  )

  class MockMutationObserver {
    constructor(_callback: MutationCallback) {}
    disconnect() {}
    observe() {}
    takeRecords() {
      return []
    }
  }

  vi.stubGlobal("MutationObserver", MockMutationObserver)

  return { classes, storage }
}

describe("theme persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("applies the stored dark theme during initialization", async () => {
    const env = setupThemeEnvironment({ storedTheme: "dark" })
    const theme = await import("./useTheme")

    theme.initializePreferredTheme()

    expect(env.classes.has("dark")).toBe(true)
  })

  it("applies system dark mode when no explicit preference is stored", async () => {
    const env = setupThemeEnvironment({ prefersDark: true })
    const theme = await import("./useTheme")

    theme.initializePreferredTheme()

    expect(env.classes.has("dark")).toBe(true)
  })

  it("stores and applies selected theme changes", async () => {
    const env = setupThemeEnvironment()
    const theme = await import("./useTheme")

    theme.setPreferredTheme("dark")

    expect(env.storage.get(theme.THEME_STORAGE_KEY)).toBe("dark")
    expect(env.classes.has("dark")).toBe(true)
  })
})
