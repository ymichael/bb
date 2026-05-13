import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
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

    expect(
      resolveNativeFolderPicker({
        pickFolder: providedPicker,
        platform: "linux",
      }),
    ).toBe(providedPicker);
    expect(
      resolveNativeFolderPicker({
        platform: "darwin",
      }),
    ).not.toBeNull();
    expect(
      resolveNativeFolderPicker({
        platform: "linux",
      }),
    ).toBeNull();
  });

  it("serves host identity and status over localhost", async () => {
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const statusResponse = await client.status.$get();

    expect(await statusResponse.json()).toEqual({
      hostId: "host-1",
      connected: true,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      serverUrl: "http://server.test",
      supportsNativeFolderPicker:
        resolveNativeFolderPicker({
          platform: process.platform,
        }) !== null,
      platform: resolveHostPlatform(),
    });
    const healthResponse = await client.health.$get();
    expect(await healthResponse.text()).toBe("ok");
  });

  it("delegates folder-pick operations to the provided callback", async () => {
    const pickFolder = vi.fn(async () => "/tmp/project");
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => false,
      pickFolder,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const statusResponse = await client.status.$get();
    const pickFolderResponse = await client["pick-folder"].$post({});

    expect(await statusResponse.json()).toMatchObject({
      supportsNativeFolderPicker: true,
    });
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
      serverPort: 3334,
      devAppPort: 5173,
        getConnected: () => true,
      });
      const client = createHostDaemonLocalClient(
        `http://localhost:${server.port}`,
      );

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
      serverPort: 3334,
      devAppPort: 5173,
        getConnected: () => true,
      });
      const client = createHostDaemonLocalClient(
        `http://localhost:${server.port}`,
      );

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
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const dir = await mkdtemp(path.join(tmpdir(), "bb-path-exists-dedup-"));
    try {
      const dedupeResponse = await client.paths.exist.$post({
        json: { paths: [dir, dir, dir] },
      });
      expect(await dedupeResponse.json()).toEqual({
        existence: { [dir]: true },
      });

      const oversizedPaths = Array.from(
        { length: 201 },
        (_, i) => `${dir}/p${i}`,
      );
      const oversizedResponse = await client.paths.exist.$post({
        json: { paths: oversizedPaths },
      });
      expect(oversizedResponse.ok).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("lists workspace open targets and delegates target-aware open requests", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const targets: WorkspaceOpenTarget[] = [
      {
        id: "vscode",
        kind: "editor",
        label: "VS Code",
      },
      {
        id: "finder",
        kind: "file-browser",
        label: "Finder",
      },
    ];
    const listWorkspaceOpenTargets = vi.fn(async () => targets);
    const openInTarget = vi.fn(async () => undefined);

    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
      listWorkspaceOpenTargets,
      openInTarget,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const targetsResponse = await client["workspace-open-targets"].$get();
    await client["open-in-target"].$post({
      json: {
        lineNumber: null,
        path: workspacePath,
        targetId: "vscode",
      },
    });

    expect(await targetsResponse.json()).toEqual({ targets });
    expect(openInTarget).toHaveBeenCalledWith({
      lineNumber: null,
      path: workspacePath,
      targetId: "vscode",
    });

    await rm(workspacePath, { recursive: true, force: true });
  });

  it("translates workspace opener errors to bad requests", async () => {
    const openInTarget = vi.fn(async () => {
      throw new WorkspaceOpenTargetError({
        code: "target_unavailable",
        message: "Workspace open target is unavailable: VS Code",
      });
    });
    server = await startLocalApiServer({
      hostId: "host-1",
      localApiConfig: createLocalApiConfig(),
      serverUrl: "http://server.test",
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
      openInTarget,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const response = await client["open-in-target"].$post({
      json: {
        lineNumber: null,
        path: "/tmp/workspace",
        targetId: "vscode",
      },
    });

    expect(response.status).toBe(400);
    expect(openInTarget).toHaveBeenCalledWith({
      lineNumber: null,
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
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
    });
    const client = createHostDaemonLocalClient(
      `http://localhost:${server.port}`,
    );

    const statusResponse = await client.status.$get();
    const status = await statusResponse.json();
    expect(status.supportsNativeFolderPicker).toBe(false);

    const pickFolderResponse = await client["pick-folder"].$post({});
    expect(pickFolderResponse.status).toBe(501);
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
      serverPort: 3334,
      devAppPort: 5173,
      getConnected: () => true,
    });

    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/ready`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.text()).toBe("bb-host-daemon");

    const client = createHostDaemonLocalClient(
      `http://127.0.0.1:${server.port}`,
    );
    const statusResponse = await client.status.$get();
    expect(statusResponse.status).toBe(404);
  });
});
