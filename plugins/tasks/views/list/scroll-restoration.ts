import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ListFilterState } from "./filter-bar.js";
import type { TaskSort } from "../../shared/pagination.js";

const STORAGE_PREFIX = "bb-tasks:list-scroll:";

const memoryFallback = new Map<string, number>();

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function listScrollScopeKey(params: {
  projectId: string | null;
  activeOnly: boolean;
  filters: ListFilterState;
  sort: TaskSort;
}): string {
  const list =
    params.projectId !== null
      ? `project:${params.projectId}`
      : params.activeOnly
        ? "active"
        : "all";
  const statuses = JSON.stringify([...params.filters.statuses].sort());
  const priorities = JSON.stringify([...params.filters.priorities].sort());
  const labels = JSON.stringify([...params.filters.labelNames].sort());
  return `${list}|s=${statuses}|p=${priorities}|l=${labels}|sort=${params.sort}`;
}

export function readListScroll(scopeKey: string): number | null {
  const memory = memoryFallback.get(scopeKey);
  if (memory !== undefined) return memory;
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_PREFIX + scopeKey);
  } catch {
    return null;
  }
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

export function writeListScroll(scopeKey: string, offset: number): void {
  const rounded = Math.max(0, Math.round(offset));
  memoryFallback.set(scopeKey, rounded);
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_PREFIX + scopeKey, String(rounded));
  } catch {}
}

export function resolveRestoreTarget(
  saved: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(Math.max(0, saved), max);
}

interface ListScrollState {
  contentReady: boolean;
  loading: boolean;
  revision: number;
}

export function useListScrollRestoration(
  ref: RefObject<HTMLDivElement | null>,
  scopeKey: string,
  state: ListScrollState,
): void {
  const { contentReady, loading, revision } = state;
  const restoredScope = useRef<string | null>(null);
  const pending = useRef<number | null>(null);
  const lastApplied = useRef<number | null>(null);
  const lastOffset = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (restoredScope.current === scopeKey) return;
    if (!contentReady) {
      el.scrollTop = 0;
      return;
    }
    restoredScope.current = scopeKey;
    const saved = readListScroll(scopeKey);
    if (saved === null) {
      el.scrollTop = 0;
      lastApplied.current = 0;
      pending.current = null;
      return;
    }
    const clamped = resolveRestoreTarget(
      saved,
      el.scrollHeight,
      el.clientHeight,
    );
    el.scrollTop = clamped;
    lastApplied.current = clamped;
    pending.current = clamped < saved && loading ? saved : null;
  }, [ref, scopeKey, contentReady, loading]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (restoredScope.current !== scopeKey) return;
    if (pending.current === null) return;
    const clamped = resolveRestoreTarget(
      pending.current,
      el.scrollHeight,
      el.clientHeight,
    );
    el.scrollTop = clamped;
    lastApplied.current = clamped;
    if (clamped >= pending.current || !loading) pending.current = null;
  }, [ref, scopeKey, revision, loading]);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    lastOffset.current = null;
    let raf = 0;
    const onScroll = () => {
      if (restoredScope.current !== scopeKey) return;
      if (
        pending.current !== null &&
        Math.abs(el.scrollTop - (lastApplied.current ?? el.scrollTop)) > 2
      ) {
        pending.current = null;
      }
      lastOffset.current = el.scrollTop;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        writeListScroll(scopeKey, el.scrollTop),
      );
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      if (restoredScope.current === scopeKey && lastOffset.current !== null) {
        writeListScroll(scopeKey, lastOffset.current);
      }
    };
  }, [ref, scopeKey]);
}
