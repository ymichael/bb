// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLastKnownCache } from "./last-known-cache";

const schema = z.object({ models: z.array(z.string()) });

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("createLastKnownCache", () => {
  it("round-trips a value under a scoped, versioned key", () => {
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
    });
    const key = cache.key("env-1", null, "codex");
    expect(key).toBe("bb.test.1.env-1.-.codex");
    cache.write(key, { models: ["a"] });
    expect(cache.read(key)).toEqual({ models: ["a"] });
  });

  it("treats a stored value that fails the schema as absent", () => {
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
    });
    window.localStorage.setItem(
      cache.key("x"),
      JSON.stringify({ models: "nope" }),
    );
    expect(cache.read(cache.key("x"))).toBeNull();
  });

  it("swallows storage failures on write instead of throwing", () => {
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => cache.write(cache.key("x"), { models: [] })).not.toThrow();
    expect(cache.read(cache.key("x"))).toBeNull();
  });

  it("treats storage that cannot be read as absent instead of throwing", () => {
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(cache.read(cache.key("x"))).toBeNull();
    vi.restoreAllMocks();
    cache.write(cache.key("x"), { models: ["c"] });
    expect(cache.read(cache.key("x"))).toEqual({ models: ["c"] });
  });

  it("never prunes its own zero-scope entry on a fresh load", () => {
    const config = { prefix: "bb.test", version: "1", schema } as const;
    const firstLoad = createLastKnownCache(config);
    firstLoad.write(firstLoad.key(), { models: ["kept"] });

    const nextLoad = createLastKnownCache(config);
    expect(nextLoad.read(nextLoad.key())).toEqual({ models: ["kept"] });
    expect(window.localStorage.getItem("bb.test.1")).not.toBeNull();
  });

  it("prunes entries written under another version of the same cache", () => {
    window.localStorage.setItem(
      "bb.test.0.old",
      JSON.stringify({ models: [] }),
    );
    window.localStorage.setItem("bb.other.0.keep", "1");
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
    });
    cache.write(cache.key("new"), { models: ["b"] });
    expect(window.localStorage.getItem("bb.test.0.old")).toBeNull();
    expect(window.localStorage.getItem("bb.other.0.keep")).toBe("1");
    expect(cache.read(cache.key("new"))).toEqual({ models: ["b"] });
  });

  it("prunes obsolete cache families on first access", () => {
    window.localStorage.setItem(
      "bb.test-legacy.2.scope-a",
      JSON.stringify({ models: ["old"] }),
    );
    window.localStorage.setItem(
      "bb.test-legacy.2.scope-b",
      JSON.stringify({ models: ["old"] }),
    );
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
      obsoletePrefixes: ["bb.test-legacy"],
    });

    cache.read(cache.key("current"));

    expect(window.localStorage.getItem("bb.test-legacy.2.scope-a")).toBeNull();
    expect(window.localStorage.getItem("bb.test-legacy.2.scope-b")).toBeNull();
  });

  it("bounds scoped entries while retaining the key being accessed", () => {
    const cache = createLastKnownCache({
      prefix: "bb.test",
      version: "1",
      schema,
      maxEntries: 3,
    });
    const firstKey = cache.key("a");
    const lastKey = cache.key("d");
    const keys = [firstKey, cache.key("b"), cache.key("c"), lastKey];
    for (const key of keys) cache.write(key, { models: [key] });

    expect(
      keys.filter((key) => window.localStorage.getItem(key) !== null),
    ).toHaveLength(3);
    expect(cache.read(firstKey)).toBeNull();
    expect(cache.read(lastKey)).toEqual({ models: [lastKey] });
    expect(
      keys.filter((key) => window.localStorage.getItem(key) !== null),
    ).toHaveLength(3);
  });
});
