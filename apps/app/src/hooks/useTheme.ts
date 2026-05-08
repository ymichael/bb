import * as React from "react";
import { getDefaultStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";

export const THEME_STORAGE_KEY = "bb.theme";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

type ThemeListener = () => void;

const themePreferenceStorage =
  createLocalStorageEnumStorage<ThemePreference>(
    (value): value is ThemePreference =>
      value === "light" || value === "dark" || value === "system",
  );
const themePreferenceAtom = atomWithStorage<ThemePreference>(
  THEME_STORAGE_KEY,
  "system",
  themePreferenceStorage,
  { getOnInit: true },
);

function getThemePreference(): ThemePreference {
  return getDefaultStore().get(themePreferenceAtom);
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  if (typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getPreferredTheme(): Theme {
  const themePreference = getThemePreference();
  return themePreference === "system" ? getSystemTheme() : themePreference;
}

export function setPreferredTheme(themePreference: ThemePreference): void {
  getDefaultStore().set(themePreferenceAtom, themePreference);
  applyThemeClass(getPreferredTheme());
  emitTheme();
}

let currentTheme: Theme = "light";
let currentThemePreference: ThemePreference = "system";
const themeSubscribers = new Set<ThemeListener>();
const themePreferenceSubscribers = new Set<ThemeListener>();
let initialized = false;

function emitTheme() {
  const nextThemePreference = getThemePreference();
  const nextTheme = getPreferredTheme();
  applyThemeClass(nextTheme);

  const themePreferenceChanged =
    nextThemePreference !== currentThemePreference;
  const themeChanged = nextTheme !== currentTheme;

  currentThemePreference = nextThemePreference;
  currentTheme = nextTheme;

  if (themePreferenceChanged) {
    themePreferenceSubscribers.forEach((listener) => listener());
  }
  if (themeChanged) {
    themeSubscribers.forEach((listener) => listener());
  }
}

function ensureThemeObserver() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  currentThemePreference = getThemePreference();
  currentTheme = getPreferredTheme();
  applyThemeClass(currentTheme);
  getDefaultStore().sub(themePreferenceAtom, emitTheme);

  if (typeof window.matchMedia !== "function") return;
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", emitTheme);
}

export function initializePreferredTheme(): void {
  ensureThemeObserver();
}

function subscribePreferredTheme(listener: ThemeListener): () => void {
  ensureThemeObserver();
  themeSubscribers.add(listener);
  return () => {
    themeSubscribers.delete(listener);
  };
}

export function usePreferredTheme(): Theme {
  return React.useSyncExternalStore(
    subscribePreferredTheme,
    () => {
      if (typeof window === "undefined") return "light";
      currentTheme = getPreferredTheme();
      return currentTheme;
    },
    () => "light",
  );
}

function subscribeThemePreference(listener: ThemeListener): () => void {
  ensureThemeObserver();
  themePreferenceSubscribers.add(listener);
  return () => {
    themePreferenceSubscribers.delete(listener);
  };
}

export function useThemePreference(): ThemePreference {
  return React.useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    () => "system",
  );
}
