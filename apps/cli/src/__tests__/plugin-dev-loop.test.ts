import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginDevLoop, isIgnoredPluginDevPath } from "@bb/plugin-build";
describe("createPluginDevLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(
    overrides: {
      hasApp?: boolean;
      hasHost?: boolean;
      hasProviderBridge?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const lines: string[] = [];
    return {
      calls,
      lines,
      deps: {
        pluginId: "hello",
        targets: async () => ({
          hasApp: overrides.hasApp ?? true,
          hasHost: overrides.hasHost ?? false,
        }),
        hasProviderBridge: overrides.hasProviderBridge ?? false,
        buildApp: vi.fn(async () => {
          calls.push("build");
        }),
        buildHost: vi.fn(async () => {
          calls.push("build-host");
        }),
        buildProviderBridge: vi.fn(async () => {
          calls.push("build-provider-bridge");
        }),
        reloadPlugin: vi.fn(async () => {
          calls.push("reload");
        }),
        log: (line: string) => {
          lines.push(line);
        },
        debounceMs: 300,
      },
    };
  }

  it("debounces a burst of changes into one cycle: rebuild, then reload, in order", async () => {
    const { calls, lines, deps } = makeDeps();
    const loop = createPluginDevLoop(deps);

    loop.handleChange("app.tsx");
    await vi.advanceTimersByTimeAsync(200);
    loop.handleChange("server.ts");
    loop.handleChange("app.tsx");
    expect(deps.buildApp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();

    expect(calls).toEqual(["build", "reload"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 files changed");
    expect(lines[0]).toContain("rebuilt app in");
    expect(lines[0]).toContain("reloaded hello");
  });

  it("skips the rebuild for a headless plugin (no bb.app) and still reloads", async () => {
    const { calls, lines, deps } = makeDeps({ hasApp: false });
    const loop = createPluginDevLoop(deps);

    loop.handleChange("server.ts");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();

    expect(deps.buildApp).not.toHaveBeenCalled();
    expect(calls).toEqual(["reload"]);
    expect(lines[0]).toBe("1 file changed · reloaded hello");
  });

  it("rebuilds the host artifact before reloading a host plugin", async () => {
    const { calls, lines, deps } = makeDeps({
      hasApp: false,
      hasHost: true,
    });
    const loop = createPluginDevLoop(deps);

    loop.handleChange("host.ts");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();

    expect(calls).toEqual(["build-host", "reload"]);
    expect(lines[0]).toContain("rebuilt host in");
  });

  it("a build failure prints the error, skips the reload, and keeps watching", async () => {
    const { calls, lines, deps } = makeDeps();
    deps.buildApp.mockRejectedValueOnce(new Error("Unexpected token"));
    const loop = createPluginDevLoop(deps);

    loop.handleChange("app.tsx");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();

    expect(deps.reloadPlugin).not.toHaveBeenCalled();
    expect(lines[0]).toContain("build failed: Unexpected token");

    loop.handleChange("app.tsx");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();
    expect(calls).toEqual(["build", "reload"]);
    expect(lines[1]).toContain("reloaded hello");
  });

  it("a reload failure prints the error and keeps watching", async () => {
    const { lines, deps } = makeDeps({ hasApp: false });
    deps.reloadPlugin.mockRejectedValueOnce(new Error("HTTP 500"));
    const loop = createPluginDevLoop(deps);

    loop.handleChange("server.ts");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();
    expect(lines[0]).toContain("reload failed: HTTP 500");

    loop.handleChange("server.ts");
    await vi.advanceTimersByTimeAsync(300);
    await loop.settled();
    expect(lines[1]).toContain("reloaded hello");
  });

  it("serializes cycles: a change during a running cycle runs a second full cycle afterwards", async () => {
    const { calls, deps } = makeDeps({ hasApp: false });
    let releaseFirstReload = (): void => {};
    deps.reloadPlugin.mockImplementationOnce(async () => {
      calls.push("reload-start");
      await new Promise<void>((resolve) => {
        releaseFirstReload = resolve;
      });
      calls.push("reload-end");
    });
    const loop = createPluginDevLoop(deps);

    loop.handleChange("server.ts");
    await vi.advanceTimersByTimeAsync(300);
    loop.handleChange("server.ts");
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toEqual(["reload-start"]);

    releaseFirstReload();
    await loop.settled();
    expect(calls).toEqual(["reload-start", "reload-end", "reload"]);
  });

  it("ignores changes after dispose and never cycles on them", async () => {
    const { deps } = makeDeps({ hasApp: false });
    const loop = createPluginDevLoop(deps);
    loop.handleChange("server.ts");
    loop.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    await loop.settled();
    expect(deps.reloadPlugin).not.toHaveBeenCalled();
  });
});

describe("isIgnoredPluginDevPath", () => {
  it("ignores dist/, node_modules/, and .git/ (including nested), keeps sources", () => {
    expect(isIgnoredPluginDevPath("dist/app.js")).toBe(true);
    expect(isIgnoredPluginDevPath("node_modules/react/index.js")).toBe(true);
    expect(isIgnoredPluginDevPath(".git/HEAD")).toBe(true);
    expect(isIgnoredPluginDevPath("packages/web/node_modules/x.js")).toBe(true);
    expect(isIgnoredPluginDevPath("app.tsx")).toBe(false);
    expect(isIgnoredPluginDevPath("src/server.ts")).toBe(false);
    expect(isIgnoredPluginDevPath("distros/notes.md")).toBe(false);
  });
});
