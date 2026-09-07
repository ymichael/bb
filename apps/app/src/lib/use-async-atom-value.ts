import { type Atom, useAtomValue } from "jotai";
import { loadable } from "jotai/utils";

type LoadableState<T> =
  | { state: "loading" }
  | { state: "hasError"; error: unknown }
  | { state: "hasData"; data: T };

const loadableAtomCache = new WeakMap<Atom<unknown>, Atom<unknown>>();

function loadableAtomFor<T>(
  sourceAtom: Atom<T | Promise<T>>,
): Atom<LoadableState<T>> {
  const cached = loadableAtomCache.get(sourceAtom);
  if (cached) {
    return cached as Atom<LoadableState<T>>;
  }
  const created = loadable(sourceAtom);
  loadableAtomCache.set(sourceAtom, created);
  return created;
}

export function useAsyncAtomValue<T>(
  asyncAtom: Atom<T | Promise<T>>,
  fallback: T,
): T {
  return useAsyncAtomState(asyncAtom, fallback).data;
}

interface AsyncAtomState<T> {
  data: T;
  error: unknown | null;
  isLoading: boolean;
}

export function useAsyncAtomState<T>(
  asyncAtom: Atom<T | Promise<T>>,
  fallback: T,
): AsyncAtomState<T> {
  const result = useAtomValue(loadableAtomFor(asyncAtom));
  if (result.state === "hasData") {
    return { data: result.data, error: null, isLoading: false };
  }
  if (result.state === "hasError") {
    return { data: fallback, error: result.error, isLoading: false };
  }
  return { data: fallback, error: null, isLoading: true };
}
