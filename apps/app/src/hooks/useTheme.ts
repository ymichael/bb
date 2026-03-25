import * as React from "react"
import { getDefaultStore } from "jotai"
import { atomWithStorage } from "jotai/utils"
import { createLocalStorageEnumStorage } from "@/lib/browser-storage"

export const THEME_STORAGE_KEY = "bb.theme"

type Theme = "light" | "dark"
type StoredThemePreference = "" | Theme

const themePreferenceStorage = createLocalStorageEnumStorage<StoredThemePreference>(
  (value): value is StoredThemePreference =>
    value === "" || value === "light" || value === "dark"
)
const themePreferenceAtom = atomWithStorage<StoredThemePreference>(
  THEME_STORAGE_KEY,
  "",
  themePreferenceStorage,
  { getOnInit: true },
)

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark"
}

function getStoredThemePreference(): StoredThemePreference {
  return getDefaultStore().get(themePreferenceAtom)
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", theme === "dark")
}

function getPreferredTheme(): Theme {
  const storedTheme = getStoredThemePreference()
  if (isTheme(storedTheme)) return storedTheme
  if (typeof window === "undefined") return "light"

  if (document.documentElement.classList.contains("dark")) return "dark"

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function setPreferredTheme(theme: Theme): void {
  getDefaultStore().set(themePreferenceAtom, theme)
  applyThemeClass(theme)
  emitTheme()
}

let currentTheme: Theme = "light"
const subscribers = new Set<() => void>()
let initialized = false

function emitTheme() {
  const nextTheme = getPreferredTheme()
  applyThemeClass(nextTheme)
  if (nextTheme === currentTheme) return
  currentTheme = nextTheme
  subscribers.forEach((listener) => listener())
}

function ensureThemeObserver() {
  if (initialized || typeof window === "undefined") return
  initialized = true
  currentTheme = getPreferredTheme()
  applyThemeClass(currentTheme)

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  const observer = new MutationObserver(() => {
    emitTheme()
  })

  mediaQuery.addEventListener("change", emitTheme)
  getDefaultStore().sub(themePreferenceAtom, emitTheme)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
}

export function initializePreferredTheme(): void {
  ensureThemeObserver()
}

function subscribePreferredTheme(listener: () => void): () => void {
  ensureThemeObserver()
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

export function usePreferredTheme(): Theme {
  return React.useSyncExternalStore(
    subscribePreferredTheme,
    () => {
      if (typeof window === "undefined") return "light"
      currentTheme = getPreferredTheme()
      return currentTheme
    },
    () => "light",
  )
}
