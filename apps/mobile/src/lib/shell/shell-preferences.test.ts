import { describe, expect, it } from "vitest";
import {
  createShellPreferenceStore,
  isRememberablePath,
  lastShellPathStorageKey,
  type ShellPreferenceStorage,
} from "./shell-preferences";

function fakeStorage(): ShellPreferenceStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("createShellPreferenceStore", () => {
  it("remembers where each profile was last looking", () => {
    const store = createShellPreferenceStore(fakeStorage());
    store.setLastPath("p1", "/threads/thr_1?tab=diff");
    expect(store.getLastPath("p1")).toBe("/threads/thr_1?tab=diff");
    expect(store.getLastPath("p2")).toBeNull();
  });

  it("refuses a path that could send the next load somewhere else", () => {
    const store = createShellPreferenceStore(fakeStorage());
    store.setLastPath("p1", "//evil.example.com/");
    expect(store.getLastPath("p1")).toBeNull();
    store.setLastPath("p2", "no-leading-slash");
    expect(store.getLastPath("p2")).toBeNull();
    store.setLastPath("p3", `/${"a".repeat(600)}`);
    expect(store.getLastPath("p3")).toBeNull();
  });

  it("ignores a stored path that no longer passes the check", () => {
    const storage = fakeStorage();
    storage.map.set(lastShellPathStorageKey("p1"), "//evil.example.com/");
    expect(createShellPreferenceStore(storage).getLastPath("p1")).toBeNull();
  });

  it("accepts the root path", () => {
    expect(isRememberablePath("/")).toBe(true);
  });
});
