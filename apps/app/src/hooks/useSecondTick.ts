import { useSyncExternalStore } from "react";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";

const listeners = new Set<() => void>();
let lastTickMs = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
let unsubscribeVisibility: (() => void) | null = null;

function tick(): void {
  lastTickMs = Date.now();
  for (const listener of listeners) listener();
}

function startInterval(): void {
  if (intervalId === null && isDocumentVisible()) {
    intervalId = setInterval(tick, 1_000);
  }
}

function stopInterval(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function handleVisibilityChange(): void {
  if (!isDocumentVisible()) {
    stopInterval();
    return;
  }
  if (listeners.size > 0 && intervalId === null) {
    tick();
    startInterval();
  }
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    lastTickMs = Date.now();
    unsubscribeVisibility = subscribeToDocumentVisibility(
      handleVisibilityChange,
    );
    startInterval();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopInterval();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
    }
  };
}

function getSnapshot(): number {
  if (lastTickMs === 0) lastTickMs = Date.now();
  return lastTickMs;
}

export function useSecondTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
