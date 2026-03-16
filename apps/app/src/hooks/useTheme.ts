import * as React from "react"

export const THEME_STORAGE_KEY = "bb.theme"

export type Theme = "light" | "dark"

function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark"
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return
  document.documentElement.classList.toggle("dark", theme === "dark")
}

export function getPreferredTheme(): Theme {
  if (typeof window === "undefined") return "light"

  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (isTheme(storedTheme)) return storedTheme

  if (document.documentElement.classList.contains("dark")) return "dark"

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function setPreferredTheme(theme: Theme): void {
  if (typeof window === "undefined") return
  applyThemeClass(theme)
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
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
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      emitTheme()
    }
  })
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
