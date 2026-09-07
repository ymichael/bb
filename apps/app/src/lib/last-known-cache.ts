import type { z } from "zod";
import { createJsonLocalStorage } from "@/lib/browser-storage";

interface LastKnownCache<T> {
  key(...scope: ReadonlyArray<string | null>): string;
  read(key: string): T | null;
  write(key: string, value: T): void;
  clear(): void;
}

export function createLastKnownCache<T>({
  prefix,
  version,
  schema,
  maxEntries,
  obsoletePrefixes = [],
}: {
  prefix: string;
  version: string;
  schema: z.ZodType<T>;
  maxEntries?: number;
  obsoletePrefixes?: readonly string[];
}): LastKnownCache<T> {
  const storage = createJsonLocalStorage<unknown>();
  const zeroScopeKey = `${prefix}.${version}`;
  const versionPrefix = `${zeroScopeKey}.`;
  let pruned = false;
  const pruneOtherVersions = () => {
    if (pruned) return;
    pruned = true;
    try {
      const stale: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const stored = window.localStorage.key(index);
        if (
          stored !== null &&
          ((stored.startsWith(`${prefix}.`) &&
            stored !== zeroScopeKey &&
            !stored.startsWith(versionPrefix)) ||
            obsoletePrefixes.some(
              (obsoletePrefix) =>
                stored === obsoletePrefix ||
                stored.startsWith(`${obsoletePrefix}.`),
            ))
        ) {
          stale.push(stored);
        }
      }
      for (const key of stale) window.localStorage.removeItem(key);
    } catch {}
  };
  const pruneExcessEntries = (
    currentKey: string,
    reservesCurrentKey: boolean,
  ) => {
    if (maxEntries === undefined) return;
    try {
      const otherKeys: string[] = [];
      let hasCurrentKey = false;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const stored = window.localStorage.key(index);
        if (stored === currentKey) {
          hasCurrentKey = true;
          continue;
        }
        if (
          stored !== null &&
          (stored === zeroScopeKey || stored.startsWith(versionPrefix))
        ) {
          otherKeys.push(stored);
        }
      }
      const entryLimit = Math.max(1, Math.floor(maxEntries));
      const retainedOtherEntries = Math.max(
        0,
        entryLimit - (reservesCurrentKey || hasCurrentKey ? 1 : 0),
      );
      for (
        let index = 0;
        index < otherKeys.length - retainedOtherEntries;
        index += 1
      ) {
        const key = otherKeys[index];
        if (key !== undefined) window.localStorage.removeItem(key);
      }
    } catch {}
  };
  return {
    key: (...scope) =>
      [prefix, version, ...scope.map((part) => part ?? "-")].join("."),
    read: (key) => {
      try {
        pruneOtherVersions();
        pruneExcessEntries(key, false);
        const stored = storage.getItem(key, null);
        if (stored === null) return null;
        const parsed = schema.safeParse(stored);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      pruneOtherVersions();
      pruneExcessEntries(key, true);
      try {
        storage.setItem(key, value);
      } catch {}
    },
    clear: () => {
      try {
        const owned: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const stored = window.localStorage.key(index);
          if (
            stored !== null &&
            (stored === zeroScopeKey || stored.startsWith(versionPrefix))
          ) {
            owned.push(stored);
          }
        }
        for (const key of owned) window.localStorage.removeItem(key);
      } catch {}
    },
  };
}
