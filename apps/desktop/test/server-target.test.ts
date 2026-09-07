import { describe, expect, it } from "vitest";
import {
  createServerTargetStore,
  normalizeCustomServerUrl,
  type ServerTargetFs,
} from "../src/server-target.js";

function createMemoryFs(initial: Record<string, string> = {}): {
  files: Map<string, string>;
  fs: ServerTargetFs;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    fs: {
      async mkdir() {
        return undefined;
      },
      async readFile(path) {
        const content = files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return content;
      },
      async writeFile(path, data) {
        files.set(path, data);
      },
    },
  };
}

describe("normalizeCustomServerUrl", () => {
  it("trims, strips hashes and trailing slashes, rejects non-http", () => {
    expect(normalizeCustomServerUrl(" https://example.com/ ")).toBe(
      "https://example.com",
    );
    expect(normalizeCustomServerUrl("http://10.0.0.5:38886/#x")).toBe(
      "http://10.0.0.5:38886",
    );
    expect(normalizeCustomServerUrl("")).toBeNull();
    expect(normalizeCustomServerUrl("example.com")).toBeNull();
    expect(normalizeCustomServerUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("server target store", () => {
  it("defaults to builtin when no file exists", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    expect(store.getTarget()).toEqual({ kind: "builtin" });
    expect(store.getCustomServerUrl()).toBeNull();
  });

  it("persists a custom URL and round-trips it through load", async () => {
    const { files, fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    await store.setCustomServerUrl("https://example.com:38886");
    expect(store.getTarget()).toEqual({
      kind: "custom",
      url: "https://example.com:38886",
    });

    const reloaded = createServerTargetStore({
      fs,
      storagePath: "/tmp/t.json",
    });
    await reloaded.load();
    expect(reloaded.getTarget()).toEqual({
      kind: "custom",
      url: "https://example.com:38886",
    });
    expect(files.get("/tmp/t.json")).toContain("https://example.com:38886");
  });

  it("switches back to builtin while keeping the custom URL", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    await store.setCustomServerUrl("https://example.com");
    expect(await store.setTarget("builtin")).toBe(true);
    expect(store.getTarget()).toEqual({ kind: "builtin" });
    expect(store.getCustomServerUrl()).toBe("https://example.com");
    expect(await store.setTarget("custom")).toBe(true);
    expect(store.getTarget()).toEqual({
      kind: "custom",
      url: "https://example.com",
    });
  });

  it("refuses to target custom without a custom URL", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    expect(await store.setTarget("custom")).toBe(false);
    expect(store.getTarget()).toEqual({ kind: "builtin" });
  });

  it("clears the custom URL and re-targets builtin on null", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    await store.setCustomServerUrl("https://example.com");
    await store.setCustomServerUrl(null);
    expect(store.getTarget()).toEqual({ kind: "builtin" });
    expect(store.getCustomServerUrl()).toBeNull();

    const reloaded = createServerTargetStore({
      fs,
      storagePath: "/tmp/t.json",
    });
    await reloaded.load();
    expect(reloaded.getTarget()).toEqual({ kind: "builtin" });
  });

  it("selects, persists, and refreshes a connect server target", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    expect(await store.setTarget("connect")).toBe(false);

    await store.setConnectServer({
      handle: "laptop",
      name: "Laptop",
      url: "https://laptop.getbb.app",
    });
    expect(store.getTarget()).toEqual({
      kind: "connect",
      server: {
        handle: "laptop",
        name: "Laptop",
        url: "https://laptop.getbb.app",
      },
    });

    expect(await store.setTarget("builtin")).toBe(true);
    expect(
      await store.refreshConnectServer({
        handle: "laptop",
        name: "Laptop Renamed",
        url: "https://laptop-new.getbb.app",
      }),
    ).toBe(true);
    expect(
      await store.refreshConnectServer({
        handle: "unknown",
        name: "Nope",
        url: "https://nope.getbb.app",
      }),
    ).toBe(false);
    expect(store.getTarget()).toEqual({ kind: "builtin" });
    expect(store.getConnectServer()?.name).toBe("Laptop Renamed");

    const reloaded = createServerTargetStore({
      fs,
      storagePath: "/tmp/t.json",
    });
    await reloaded.load();
    expect(reloaded.getTarget()).toEqual({ kind: "builtin" });
    expect(reloaded.getConnectServer()).toEqual({
      handle: "laptop",
      name: "Laptop Renamed",
      url: "https://laptop-new.getbb.app",
    });
  });

  it("keeps a connect target while clearing the custom URL", async () => {
    const { fs } = createMemoryFs();
    const store = createServerTargetStore({ fs, storagePath: "/tmp/t.json" });
    await store.load();
    await store.setCustomServerUrl("https://example.com");
    await store.setConnectServer({
      handle: "laptop",
      name: "Laptop",
      url: "https://laptop.getbb.app",
    });
    await store.setCustomServerUrl(null);
    expect(store.getTarget().kind).toBe("connect");
    expect(store.getCustomServerUrl()).toBeNull();
  });

  it("falls back to builtin when the persisted file is corrupt or dangling", async () => {
    const corrupt = createServerTargetStore({
      fs: createMemoryFs({ "/tmp/t.json": "{not json" }).fs,
      storagePath: "/tmp/t.json",
    });
    await corrupt.load();
    expect(corrupt.getTarget()).toEqual({ kind: "builtin" });

    const dangling = createServerTargetStore({
      fs: createMemoryFs({
        "/tmp/t.json": JSON.stringify({
          customServerUrl: null,
          target: "custom",
        }),
      }).fs,
      storagePath: "/tmp/t.json",
    });
    await dangling.load();
    expect(dangling.getTarget()).toEqual({ kind: "builtin" });

    const danglingConnect = createServerTargetStore({
      fs: createMemoryFs({
        "/tmp/t.json": JSON.stringify({
          connectServer: null,
          customServerUrl: null,
          target: "connect",
        }),
      }).fs,
      storagePath: "/tmp/t.json",
    });
    await danglingConnect.load();
    expect(danglingConnect.getTarget()).toEqual({ kind: "builtin" });

    const invalidUrl = createServerTargetStore({
      fs: createMemoryFs({
        "/tmp/t.json": JSON.stringify({
          customServerUrl: "not-a-url",
          target: "custom",
        }),
      }).fs,
      storagePath: "/tmp/t.json",
    });
    await invalidUrl.load();
    expect(invalidUrl.getTarget()).toEqual({ kind: "builtin" });
    expect(invalidUrl.getCustomServerUrl()).toBeNull();
  });
});
