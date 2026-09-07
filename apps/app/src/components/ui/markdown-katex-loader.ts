import { useEffect, useSyncExternalStore } from "react";

export type RehypeKatex = typeof import("./markdown-katex.js").default;

const MATH_DELIMITER = "$$";

export function markdownMayContainMath(content: string): boolean {
  return content.includes(MATH_DELIMITER);
}

let loadedRehypeKatex: RehypeKatex | null = null;
let rehypeKatexImportPromise: Promise<RehypeKatex> | null = null;
const listeners = new Set<() => void>();

function loadRehypeKatex(): Promise<RehypeKatex> {
  if (rehypeKatexImportPromise === null) {
    rehypeKatexImportPromise = import("./markdown-katex.js").then(
      (katexModule) => {
        loadedRehypeKatex = katexModule.default;
        for (const listener of listeners) listener();
        return katexModule.default;
      },
      (error: unknown) => {
        rehypeKatexImportPromise = null;
        throw error;
      },
    );
  }
  return rehypeKatexImportPromise;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): RehypeKatex | null {
  return loadedRehypeKatex;
}

export function useRehypeKatex(mayContainMath: boolean): RehypeKatex | null {
  const rehypeKatex = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!mayContainMath || rehypeKatex !== null) return;
    loadRehypeKatex().catch(() => {});
  }, [mayContainMath, rehypeKatex]);
  return rehypeKatex;
}
