import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostDaemonLocalClient,
  type WorkspaceOpenTarget,
} from "@bb/host-daemon-contract";
import {
  resolveHostPlatform,
  resolveNativeFolderPicker,
  startLocalApiServer,
  type LocalApiServer,
} from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import { WorkspaceOpenTargetError } from "./workspace-open-targets.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("local API server", () => {
  let server: LocalApiServer | null = null;

  function createLocalApiConfig(
    overrides: Partial<HostDaemonLocalApiConfig> = {},
  ): HostDaemonLocalApiConfig {
    return {
      bindHost: "localhost",
      healthPath: "/health",
      healthValue: "ok",
      mode: "full",
      port: 0,
      ...overrides,
    };
  }

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("resolves native folder picker support from one shared helper", () => {
    const providedPicker = async () => "/tmp/project";

    expect(resolveNativeFolderPicker({
      pickFolder: providedPicker,
      platform: "linux",
    })).toBe(providedPicker);
    expect(resolveNativeFolderPicker({
      platform: "darwin",
    })).not.toBeNull();
    expect(resolveNativeFolderPicker({
      platform: "linux",
    })).toBeNull();
  });

  it("serves host identity and status over localhost", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const statusResponse = await client.status.$get();

    expect(await statusResponse.json()).toEqual({
      hostId: "host-1",
      connected: true,
      serverUrl: "http://server.test",
      supportsNativeFolderPicker: resolveNativeFolderPicker({
        platform: process.platform,
      }) !== null,
      platform: resolveHostPlatform(),
    });
    const healthResponse = await client.health.$get();
    expect(await healthResponse.text()).toBe("ok");
  });

  it("delegates open and folder-pick operations to the provided callbacks", async () => {
    const openPath = vi.fn(async () => undefined);
    const pickFolder = vi.fn(async () => "/tmp/project");
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => false,
      openPath,
      pickFolder,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const statusResponse = await client.status.$get();
    await client["open-path"].$post({ json: { path: "/tmp" } });
    const pickFolderResponse = await client["pick-folder"].$post({});

    expect(await statusResponse.json()).toMatchObject({
      supportsNativeFolderPicker: true,
    });
    expect(openPath).toHaveBeenCalledWith("/tmp");
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(await pickFolderResponse.json()).toEqual({ path: "/tmp/project" });
  });

  it("reports path existence by stat'ing each requested path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-path-exists-"));
    const existingDir = path.join(dir, "repo");
    const existingFile = path.join(dir, "file.txt");
    const missing = path.join(dir, "nope");
    await mkdir(existingDir);
    await writeFile(existingFile, "hi");

    try {
      server = await startLocalApiServer({
        hostId: "host-1",
        localApiConfig: createLocalApiConfig(),
        serverUrl: "http://server.test",
        getConnected: () => true,
        restart: () => undefined,
        listActiveThreads: () => [],
      });
      const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

      const response = await client.paths.exist.$post({
        json: { paths: [existingDir, existingFile, missing] },
      });

      expect(await response.json()).toEqual({
        existence: {
          [existingDir]: true,
          [existingFile]: true,
          [missing]: false,
        },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("treats permission-denied paths as existing rather than failing the batch", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }
    const dir = await mkdtemp(path.join(tmpdir(), "bb-path-exists-eacces-"));
    const lockedParent = path.join(dir, "locked");
    const inaccessible = path.join(lockedParent, "child");
    const reachable = path.join(dir, "reachable");
    await mkdir(lockedParent);
    await mkdir(reachable);
    await chmod(lockedParent, 0o000);

    try {
      server = await startLocalApiServer({
        hostId: "host-1",
        localApiConfig: createLocalApiConfig(),
        serverUrl: "http://server.test",
        getConnected: () => true,
        restart: () => undefined,
        listActiveThreads: () => [],
      });
      const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

      const response = await client.paths.exist.$post({
        json: { paths: [inaccessible, reachable] },
      });

      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({
        existence: {
          [inaccessible]: true,
          [reachable]: true,
        },
      });
    } finally {
      await chmod(lockedParent, 0o700);
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("dedupes repeated paths in /paths/exist and rejects oversized batches", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const dir = await mkdtemp(path.join(tmpdir(), "bb-path-exists-dedup-"));
    try {
      const dedupeResponse = await client.paths.exist.$post({
        json: { paths: [dir, dir, dir] },
      });
      expect(await dedupeResponse.json()).toEqual({
        existence: { [dir]: true },
      });

      const oversizedPaths = Array.from({ length: 201 }, (_, i) => `${dir}/p${i}`);
      const oversizedResponse = await client.paths.exist.$post({
        json: { paths: oversizedPaths },
      });
      expect(oversizedResponse.ok).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("lists workspace open targets and delegates workspace open requests", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const targets: WorkspaceOpenTarget[] = [
      {
        id: "vscode",
        label: "VS Code",
      },
      {
        id: "finder",
        label: "Finder",
      },
    ];
    const listWorkspaceOpenTargets = vi.fn(async () => targets);
    const openWorkspace = vi.fn(async () => undefined);

    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      listWorkspaceOpenTargets,
      openWorkspace,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const targetsResponse = await client["workspace-open-targets"].$get();
    await client["open-workspace"].$post({
      json: {
        path: workspacePath,
        targetId: "vscode",
      },
    });

    expect(await targetsResponse.json()).toEqual({ targets });
    expect(openWorkspace).toHaveBeenCalledWith({
      path: workspacePath,
      targetId: "vscode",
    });

    await rm(workspacePath, { recursive: true, force: true });
  });

  it("translates workspace opener errors to bad requests", async () => {
    const openWorkspace = vi.fn(async () => {
      throw new WorkspaceOpenTargetError({
        code: "target_unavailable",
        message: "Workspace open target is unavailable: VS Code",
      });
    });
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      openWorkspace,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client["open-workspace"].$post({
      json: {
        path: "/tmp/workspace",
        targetId: "vscode",
      },
    });

    expect(response.status).toBe(400);
    expect(openWorkspace).toHaveBeenCalledWith({
      path: "/tmp/workspace",
      targetId: "vscode",
    });
  });

  it("returns 501 for folder picking when native picker support is unavailable", async () => {
    if (process.platform === "darwin") {
      return;
    }

    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart: () => undefined,
      listActiveThreads: () => [],
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const statusResponse = await client.status.$get();
    const status = await statusResponse.json();
    expect(status.supportsNativeFolderPicker).toBe(false);

    const pickFolderResponse = await client["pick-folder"].$post({});
    expect(pickFolderResponse.status).toBe(501);
  });

  it("schedules a restart after acknowledging the request", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: {} });
    expect(response.ok).toBe(true);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("rejects restart with 409 when threads are active and force is not set", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [{ threadId: "thread-1" }],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: {} });
    expect(response.status).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });

  it("allows restart with force even when threads are active", async () => {
    const restart = vi.fn(async () => undefined);
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      getConnected: () => true,
      restart,
      listActiveThreads: () => [{ threadId: "thread-1" }],
      scheduleRestart: (callback) => {
        setTimeout(callback, 0);
      },
    });
    const client = createHostDaemonLocalClient(`http://localhost:${server.port}`);

    const response = await client.restart.$post({ json: { force: true } });
    expect(response.ok).toBe(true);
    await waitFor(() => restart.mock.calls.length === 1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("supports health-only mode for sandbox hosts", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig({
        bindHost: "127.0.0.1",
        healthPath: "/ready",
        healthValue: "bb-host-daemon",
        mode: "health-only",
      }),
      serverUrl: "http://server.test",
      getConnected: () => true,
      listActiveThreads: () => [],
      restart: () => undefined,
    });

    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/ready`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe("bb-host-daemon");

    const client = createHostDaemonLocalClient(`http://127.0.0.1:${server.port}`);
    const statusResponse = await client.status.$get();
    expect(statusResponse.status).toBe(404);
  });
});
