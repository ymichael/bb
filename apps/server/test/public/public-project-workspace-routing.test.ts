import { createProjectSource } from "@bb/db";
import type { HostProviderCommand } from "@bb/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { declaredNativeRootSet } from "../helpers/provider-registry.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const remoteCommand: HostProviderCommand = {
  name: "remote-only",
  source: "skill",
  origin: "project",
  description: "Remote command",
  argumentHint: null,
};
const primaryCommand: HostProviderCommand = {
  ...remoteCommand,
  name: "primary-only",
  description: "Primary command",
};

describe("public project workspace routing", () => {
  it("keeps app branch options cache-first and public branch listing blocking", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-project-branches",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/project/branches",
      });
      let releaseBackgroundInspection: (() => void) | undefined;
      const backgroundInspectionGate = new Promise<void>((resolve) => {
        releaseBackgroundInspection = resolve;
      });
      let releaseBlockingInspection: (() => void) | undefined;
      const blockingInspectionGate = new Promise<void>((resolve) => {
        releaseBlockingInspection = resolve;
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: async (request) => {
          if (request.command.type === "host.list_branch_options") {
            return {
              ok: true,
              result: {
                branches: ["main"],
                branchesTruncated: false,
                remoteBranches: ["origin/main"],
                remoteBranchesTruncated: false,
                selectedBranch: null,
              },
            };
          }
          if (request.command.type !== "host.inspect_git_source") {
            throw new Error(
              `Unexpected project branch RPC ${request.command.type}`,
            );
          }
          await (request.command.remoteRefresh === "blocking"
            ? blockingInspectionGate
            : backgroundInspectionGate);
          return {
            ok: true,
            result: {
              checkout: {
                kind: "branch",
                branchName: "main",
                headSha: "abc123",
              },
              defaultBranch: "main",
              defaultBranchRelation: "equal",
              hasUncommittedChanges: false,
              operation: { kind: "none" },
              originDefaultBranch: "origin/main",
            },
          };
        },
      });

      const responsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/branch-options?hostId=${host.id}&limit=50`,
      );

      try {
        await vi.waitFor(() => expect(responder.requests).toHaveLength(2));
        expect(responder.requests.map((request) => request.command)).toEqual([
          {
            type: "host.inspect_git_source",
            path: "/project/branches",
            remoteRefresh: "background",
          },
          {
            type: "host.list_branch_options",
            path: "/project/branches",
            limit: 50,
            remoteRefresh: "none",
          },
        ]);
      } finally {
        releaseBackgroundInspection?.();
      }
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(responder.requests.map((request) => request.command)).toEqual([
        {
          type: "host.inspect_git_source",
          path: "/project/branches",
          remoteRefresh: "background",
        },
        {
          type: "host.list_branch_options",
          path: "/project/branches",
          limit: 50,
          remoteRefresh: "none",
        },
      ]);
      await expect(readJson(response)).resolves.toMatchObject({
        branches: ["main"],
        branchesTruncated: false,
        defaultBranch: "main",
        defaultWorktreeBaseBranch: "origin/main",
        remoteBranches: ["origin/main"],
        remoteBranchesTruncated: false,
        selectedBranch: null,
      });

      responder.requests.length = 0;
      const refreshedResponsePromise = harness.app.request(
        `/api/v1/projects/${project.id}/branches?hostId=${host.id}&limit=50`,
      );
      try {
        await vi.waitFor(() => expect(responder.requests).toHaveLength(1));
        expect(responder.requests[0]?.command).toEqual({
          type: "host.inspect_git_source",
          path: "/project/branches",
          remoteRefresh: "blocking",
        });
      } finally {
        releaseBlockingInspection?.();
      }
      const refreshedResponse = await refreshedResponsePromise;
      expect(refreshedResponse.status).toBe(200);
      expect(responder.requests.map((request) => request.command)).toEqual([
        {
          type: "host.inspect_git_source",
          path: "/project/branches",
          remoteRefresh: "blocking",
        },
        {
          type: "host.list_branch_options",
          path: "/project/branches",
          limit: 50,
          remoteRefresh: "none",
        },
      ]);
    });
  });

  it("isolates primary, explicit-host, and environment workspace discovery", async () => {
    await withTestHarness(async (harness) => {
      const { host: primaryHost, session: primarySession } = seedHostSession(
        harness.deps,
        { id: "host-project-routing-primary" },
      );
      const { host: remoteHost, session: remoteSession } = seedHostSession(
        harness.deps,
        { id: "host-project-routing-remote" },
      );
      seedPrimaryHost(harness.deps, primaryHost.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: primaryHost.id,
        path: "/primary/project",
      });
      createProjectSource(harness.db, harness.deps.hub, {
        projectId: project.id,
        hostId: remoteHost.id,
        path: "/remote/project",
        type: "local_path",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: remoteHost.id,
        projectId: project.id,
        path: "/remote/worktree",
      });

      registerHostRpcResponder(harness, {
        hostId: primaryHost.id,
        sessionId: primarySession.id,
        handle: (request) => {
          if (request.command.type === "host.list_files") {
            if (request.command.path !== "/primary/project") {
              return { ok: true, result: { files: [], truncated: false } };
            }
            return {
              ok: true,
              result: {
                files: [{ name: "primary.txt", path: "primary.txt" }],
                truncated: false,
              },
            };
          }
          if (request.command.type === "host.list_commands") {
            return { ok: true, result: { commands: [primaryCommand] } };
          }
          if (request.command.type === "plugin.host.call") {
            return {
              ok: true,
              result: { output: { skills: [], commands: [] } },
            };
          }
          if (request.command.type === "host.read_file") {
            return {
              ok: true,
              result: {
                path: request.command.path,
                content: "content from /primary/project",
                contentEncoding: "utf8",
                mimeType: "text/plain",
                sizeBytes: 29,
                sha256: "2".repeat(64),
              },
            };
          }
          throw new Error(`Unexpected primary RPC ${request.command.type}`);
        },
      });
      const remoteRpc = registerHostRpcResponder(harness, {
        hostId: remoteHost.id,
        sessionId: remoteSession.id,
        handle: (request) => {
          if (request.command.type === "host.list_files") {
            return { ok: true, result: { files: [], truncated: false } };
          }
          if (request.command.type === "host.list_paths") {
            return {
              ok: true,
              result: {
                paths: [
                  {
                    kind: "file",
                    name: "remote.txt",
                    path: "remote.txt",
                    positions: [],
                    score: 1,
                  },
                ],
                truncated: false,
              },
            };
          }
          if (request.command.type === "host.list_commands") {
            return { ok: true, result: { commands: [remoteCommand] } };
          }
          if (request.command.type === "plugin.host.call") {
            return {
              ok: true,
              result: { output: { skills: [], commands: [] } },
            };
          }
          if (request.command.type === "host.read_file") {
            return {
              ok: true,
              result: {
                path: request.command.path,
                content: `content from ${request.command.rootPath}`,
                contentEncoding: "utf8",
                mimeType: "text/plain",
                sizeBytes: 28,
                sha256: "0".repeat(64),
              },
            };
          }
          throw new Error(`Unexpected remote RPC ${request.command.type}`);
        },
      });

      const primaryFiles = await harness.app.request(
        `/api/v1/projects/${project.id}/files`,
      );
      await expect(readJson(primaryFiles)).resolves.toEqual({
        files: [{ name: "primary.txt", path: "primary.txt" }],
        truncated: false,
      });
      const primaryCommands = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=codex`,
      );
      await expect(readJson(primaryCommands)).resolves.toMatchObject({
        commands: expect.arrayContaining([primaryCommand]),
      });
      const primaryContent = await harness.app.request(
        `/api/v1/projects/${project.id}/files/content?path=primary.txt`,
      );
      await expect(primaryContent.text()).resolves.toBe(
        "content from /primary/project",
      );

      const remotePaths = await harness.app.request(
        `/api/v1/projects/${project.id}/paths?hostId=${remoteHost.id}&includeFiles=true&includeDirectories=true`,
      );
      expect(remotePaths.status).toBe(200);
      expect(remoteRpc.requests.at(-1)?.command).toMatchObject({
        type: "host.list_paths",
        path: "/remote/project",
      });

      const environmentPaths = await harness.app.request(
        `/api/v1/projects/${project.id}/paths?environmentId=${environment.id}&includeFiles=true&includeDirectories=true`,
      );
      expect(environmentPaths.status).toBe(200);
      expect(remoteRpc.requests.at(-1)?.command).toMatchObject({
        type: "host.list_paths",
        path: "/remote/worktree",
      });

      const commands = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=codex&hostId=${remoteHost.id}`,
      );
      await expect(readJson(commands)).resolves.toMatchObject({
        commands: expect.arrayContaining([remoteCommand]),
      });
      expect(
        remoteRpc.requests.find(
          (request) => request.command.type === "host.list_commands",
        )?.command,
      ).toEqual({
        type: "host.list_commands",
        providerId: "codex",
        cwd: "/remote/project",
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "codex",
        ),
      });

      const content = await harness.app.request(
        `/api/v1/projects/${project.id}/files/content?hostId=${remoteHost.id}&path=remote.txt`,
      );
      expect(content.headers.get("x-bb-content-encoding")).toBe("utf8");
      await expect(content.text()).resolves.toBe(
        "content from /remote/project",
      );
    });
  });

  it("rejects simultaneous host and environment selectors on every project workspace route", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-routing-conflict",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const selector = `hostId=${host.id}&environmentId=${environment.id}`;
      const urls = [
        `/api/v1/projects/${project.id}/files?${selector}`,
        `/api/v1/projects/${project.id}/paths?${selector}&includeFiles=true&includeDirectories=true`,
        `/api/v1/projects/${project.id}/commands?${selector}&provider=codex`,
        `/api/v1/projects/${project.id}/files/content?${selector}&path=file.txt`,
      ];

      for (const url of urls) {
        const response = await harness.app.request(url);
        expect(response.status, url).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
          message: expect.stringContaining("mutually exclusive"),
        });
      }
    });
  });

  it("preserves binary project file bytes and declares base64 SDK encoding", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-project-routing-binary",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/binary/project",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "host.read_file") {
            throw new Error(`Unexpected binary RPC ${request.command.type}`);
          }
          return {
            ok: true,
            result: {
              path: request.command.path,
              content: "AAH+/w==",
              contentEncoding: "base64",
              mimeType: "application/octet-stream",
              sizeBytes: 4,
              sha256: "1".repeat(64),
            },
          };
        },
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/files/content?path=image.bin`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/octet-stream",
      );
      expect(response.headers.get("x-bb-content-encoding")).toBe("base64");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        new Uint8Array([0, 1, 254, 255]),
      );
    });
  });
});
