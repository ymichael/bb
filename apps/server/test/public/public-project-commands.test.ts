import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DiscoveredSkill,
  HostProviderCommand,
  HostDaemonOnlineRpcRequestMessage,
} from "@bb/host-daemon-contract";
import { commandListResponseSchema } from "@bb/server-contract";
import type { ExperimentalNativeRootsResolveAnswer } from "@get-bb/plugin-sdk/host";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS } from "../../src/constants.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  configuredAcpProvider,
  declaredNativeRootSet,
  stubHostArtifact,
} from "../helpers/provider-registry.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";

const NO_RESOLVED_ROOTS = { skills: [], commands: [] };

function root(path: string) {
  return { path, recursive: false, ancestors: false, namePrefix: "" };
}

function resolvingProvider(id: string): {
  declaration: PluginProviderDeclaration;
  pluginId: string;
} {
  return {
    pluginId: `provider-${id}`,
    declaration: {
      id,
      displayName: id,
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full"],
        reasoningLevels: ["medium"],
      },
      composerActions: [],
      experimental_resolvesNativeRoots: true,
    },
  };
}

interface CommandRpcStub {
  commands: HostProviderCommand[];
  requests: HostDaemonOnlineRpcRequestMessage[];
  skillRequests: HostDaemonOnlineRpcRequestMessage[];
  resolveRequests: HostDaemonOnlineRpcRequestMessage[];
}

interface RegisterCommandRpcArgs {
  hostId: string;
  sessionId: string;
  commands: HostProviderCommand[];
  skills?: DiscoveredSkill[];
  resolved?: ExperimentalNativeRootsResolveAnswer;
  resolveDelayMs?: number;
}

function registerCommandRpc(
  harness: Parameters<typeof registerHostRpcResponder>[0],
  args: RegisterCommandRpcArgs,
): CommandRpcStub {
  const stub: CommandRpcStub = {
    commands: args.commands,
    requests: [],
    skillRequests: [],
    resolveRequests: [],
  };
  registerHostRpcResponder(harness, {
    hostId: args.hostId,
    sessionId: args.sessionId,
    handle: (request) => {
      if (request.command.type === "host.list_files") {
        return { ok: true, result: { files: [], truncated: false } };
      }
      if (request.command.type === "plugin.host.call") {
        if (request.command.method !== "resolveNativeRoots") {
          throw new Error(
            `Unexpected plugin host call ${request.command.method} in command typeahead test`,
          );
        }
        stub.resolveRequests.push(request);
        const answer = {
          ok: true as const,
          result: { output: args.resolved ?? NO_RESOLVED_ROOTS },
        };
        if (args.resolveDelayMs === undefined) return answer;
        return new Promise((settle) =>
          setTimeout(() => settle(answer), args.resolveDelayMs),
        );
      }
      if (request.command.type === "host.list_commands") {
        stub.requests.push(request);
        return { ok: true, result: { commands: stub.commands } };
      }
      if (request.command.type === "host.list_skills") {
        stub.skillRequests.push(request);
        return { ok: true, result: { skills: args.skills ?? [] } };
      }
      throw new Error(
        `Unexpected RPC command ${request.command.type} in command typeahead test`,
      );
    },
  });
  return stub;
}

function skill(
  name: string,
  origin: "project" | "user",
  overrides: Partial<HostProviderCommand> = {},
): HostProviderCommand {
  return {
    name,
    source: "skill",
    origin,
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

function legacyCommand(
  name: string,
  origin: "project" | "user",
  overrides: Partial<HostProviderCommand> = {},
): HostProviderCommand {
  return {
    name,
    source: "command",
    origin,
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

describe("public project command typeahead route", () => {
  it("adds configured shared skills to the provider-neutral catalog", async () => {
    await withTestHarness(
      {
        sharedSkillRoots: {
          user: [".agents/skills"],
          project: [".agents/skills"],
        },
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-shared-skills",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/shared-skills",
        });
        const stub = registerCommandRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          commands: [],
          skills: [
            {
              id: `skill_${"a".repeat(64)}`,
              name: "portable-review",
              description: "Review code from one shared source.",
              filePath:
                "/tmp/shared-skills/.agents/skills/portable-review/SKILL.md",
              rootKind: "shared-project",
              linked: false,
            },
          ],
        });

        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/commands?provider=pi`,
        );
        const body = commandListResponseSchema.parse(await readJson(response));

        expect(body.commands).toContainEqual({
          name: "portable-review",
          source: "skill",
          origin: "project",
          description: "Review code from one shared source.",
          argumentHint: null,
        });
        expect(stub.skillRequests[0]?.command).toEqual({
          type: "host.list_skills",
          providerId: "bb-shared",
          cwd: "/tmp/shared-skills",
          nativeRoots: {
            skills: {
              user: [root(".agents/skills")],
              project: [root(".agents/skills")],
            },
            commands: { user: [], project: [] },
            resolved: NO_RESOLVED_ROOTS,
          },
        });
      },
    );
  });

  it("passes a provider's declared native skill roots to the target host", async () => {
    await withTestHarness(
      {
        extraProviders: [
          await configuredAcpProvider({
            id: "amp",
            displayName: "Amp",
            command: "amp-acp",
            nativeSkillRoots: {
              user: [".agents/skills"],
              project: [".agents/skills"],
            },
          }),
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-custom-acp-skills",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/custom-acp-skills",
        });
        const stub = registerCommandRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          commands: [],
        });

        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/commands?provider=acp-amp`,
        );

        expect(response.status).toBe(200);
        expect(stub.requests[0]?.command).toEqual({
          type: "host.list_commands",
          providerId: "acp-amp",
          cwd: "/tmp/custom-acp-skills",
          nativeRoots: {
            skills: {
              user: [root(".agents/skills")],
              project: [root(".agents/skills")],
            },
            commands: { user: [], project: [] },
            resolved: NO_RESOLVED_ROOTS,
          },
        });
      },
    );
  });

  it("asks a resolving plugin for roots on the workspace host and forwards them", async () => {
    const provider = resolvingProvider("resolving");
    await withTestHarness({ extraProviders: [provider] }, async (harness) => {
      harness.deps.pluginHostArtifacts.set(
        provider.pluginId,
        stubHostArtifact(provider.pluginId),
      );
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-resolving",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/resolving-project",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("vendor:review", "user")],
        resolved: {
          skills: [
            { path: "/home/me/.vendor/skills", origin: "user" },
            {
              path: "/home/me/.vendor/plugins/tools/skills",
              origin: "user",
              namePrefix: "tools:",
              recursive: true,
            },
          ],
          commands: [
            {
              path: "/tmp/resolving-project/.vendor/commands",
              origin: "project",
              ancestors: true,
            },
          ],
        },
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=resolving`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "vendor:review",
      ]);
      expect(stub.resolveRequests.map((request) => request.command)).toEqual([
        expect.objectContaining({
          type: "plugin.host.call",
          pluginId: provider.pluginId,
          method: "resolveNativeRoots",
          input: { providerId: "resolving", cwd: "/tmp/resolving-project" },
        }),
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "resolving",
        cwd: "/tmp/resolving-project",
        nativeRoots: {
          skills: { user: [], project: [] },
          commands: { user: [], project: [] },
          resolved: {
            skills: [
              {
                path: "/home/me/.vendor/skills",
                origin: "user",
                recursive: false,
                ancestors: false,
                namePrefix: "",
                shape: "skills",
              },
              {
                path: "/home/me/.vendor/plugins/tools/skills",
                origin: "user",
                recursive: true,
                ancestors: false,
                namePrefix: "tools:",
                shape: "skills",
              },
            ],
            commands: [
              {
                path: "/tmp/resolving-project/.vendor/commands",
                origin: "project",
                recursive: false,
                ancestors: true,
                namePrefix: "",
                shape: "commands",
              },
            ],
          },
        },
      });
    });
  });

  it("shares one command timeout between the resolver call and the daemon scan", async () => {
    const provider = resolvingProvider("slow-resolver");
    const resolveDelayMs = 200;
    await withTestHarness({ extraProviders: [provider] }, async (harness) => {
      harness.deps.pluginHostArtifacts.set(
        provider.pluginId,
        stubHostArtifact(provider.pluginId),
      );
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-slow-resolver",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/slow-resolver-project",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("after-the-wait", "user")],
        resolved: {
          skills: [{ path: "/home/me/.slow/skills", origin: "user" }],
        },
        resolveDelayMs,
      });
      const hubRpc = vi.spyOn(harness.hub, "requestHostOnlineRpc");

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=slow-resolver`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "after-the-wait",
      ]);
      const resolverCommand = stub.resolveRequests[0]?.command;
      if (resolverCommand?.type !== "plugin.host.call") {
        throw new Error("expected the resolver call");
      }
      expect(resolverCommand.timeoutMs).toBeLessThanOrEqual(COMMAND_TIMEOUT_MS);
      expect(resolverCommand.timeoutMs).toBeGreaterThan(
        COMMAND_TIMEOUT_MS - 1_000,
      );
      const scan = hubRpc.mock.calls
        .map(([args]) => args)
        .find((args) => args.message.command.type === "host.list_commands");
      expect(scan).toBeDefined();
      expect(scan?.timeoutMs).toBeGreaterThan(0);
      expect(scan?.timeoutMs).toBeLessThanOrEqual(
        COMMAND_TIMEOUT_MS - resolveDelayMs + 50,
      );
    });
  });

  it("skips the daemon roundtrip for a provider with no native roots and no resolver", async () => {
    await withTestHarness(
      {
        extraProviders: [
          await configuredAcpProvider({
            id: "rootless",
            displayName: "Rootless",
            command: "rootless-acp",
          }),
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-commands-rootless",
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/rootless-project",
        });
        const stub = registerCommandRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          commands: [skill("never-asked", "user")],
        });

        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/commands?provider=acp-rootless`,
        );

        expect(response.status).toBe(200);
        const body = commandListResponseSchema.parse(await readJson(response));
        expect(body.commands.map((command) => command.name)).not.toContain(
          "never-asked",
        );
        expect(stub.requests).toEqual([]);
        expect(stub.resolveRequests).toEqual([]);
      },
    );
  });

  it("uses the server skill catalog when discovery targets another machine", async () => {
    await withTestHarness(async (harness) => {
      const primaryHost = seedHost(harness.deps, {
        id: "host-commands-primary",
      });
      seedPrimaryHost(harness.deps, primaryHost.id);
      const { host: remoteHost, session } = seedHostSession(harness.deps, {
        id: "host-commands-remote",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: primaryHost.id,
        path: "/tmp/remote-commands-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: remoteHost.id,
        projectId: project.id,
        path: "/tmp/remote-commands-env",
      });
      const skillRoot = path.join(
        harness.deps.config.dataDir,
        "skills",
        "synced-remote",
      );
      await mkdir(skillRoot, { recursive: true });
      await writeFile(
        path.join(skillRoot, "SKILL.md"),
        "---\nname: synced-remote\ndescription: Synced remote skill\n---\n",
        "utf8",
      );
      const stub = registerCommandRpc(harness, {
        hostId: remoteHost.id,
        sessionId: session.id,
        commands: [],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=codex&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands).toContainEqual({
        name: "synced-remote",
        source: "skill",
        origin: "user",
        description: "Synced remote skill",
        argumentHint: null,
      });
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "codex",
        cwd: "/tmp/remote-commands-env",
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "codex",
        ),
      });
    });
  });

  it("sorts and de-dupes the command catalog with project winning over user", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-claude",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/claude-commands-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/claude-commands-env",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [
          skill("review", "user", { description: "User review skill" }),
          skill("review", "project", {
            description: "Project review skill",
            argumentHint: "<path>",
          }),
          legacyCommand("review", "project", {
            description: "Legacy review command",
          }),
          skill("refactor", "project"),
          skill("deploy", "user"),
        ],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands).toEqual([
        {
          name: "clear",
          source: "command",
          origin: "builtin",
          description: "Start fresh context in this thread",
          argumentHint: null,
        },
        {
          name: "compact",
          source: "command",
          origin: "builtin",
          description: "Compact context",
          argumentHint: null,
        },
        {
          name: "deploy",
          source: "skill",
          origin: "user",
          description: null,
          argumentHint: null,
        },
        {
          name: "refactor",
          source: "skill",
          origin: "project",
          description: null,
          argumentHint: null,
        },
        {
          name: "review",
          source: "skill",
          origin: "project",
          description: "Project review skill",
          argumentHint: "<path>",
        },
        {
          name: "review",
          source: "command",
          origin: "project",
          description: "Legacy review command",
          argumentHint: null,
        },
      ]);

      expect(stub.requests.map((request) => request.command)).toEqual([
        {
          type: "host.list_commands",
          providerId: "claude-code",
          cwd: "/tmp/claude-commands-env",
          nativeRoots: declaredNativeRootSet(
            harness.deps.providerRegistry,
            "claude-code",
          ),
        },
      ]);
    });
  });

  it("returns codex skills for a codex request", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-codex",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/codex-commands-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/codex-commands-env",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [
          skill("prd", "user", { description: "Product requirements" }),
          skill("skill-installer", "project"),
        ],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=codex&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "prd",
        "skill-installer",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "codex",
        cwd: "/tmp/codex-commands-env",
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "codex",
        ),
      });
    });
  });

  it("keeps inherited bb skill roots out of provider-native discovery", async () => {
    await withTestHarness(
      {
        inheritedSkillsRootPaths: ["/tmp/bb-parent-skills"],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-commands-inherited-skills",
        });
        seedPrimaryHost(harness.deps, host.id);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/inherited-skills-project",
        });
        const stub = registerCommandRpc(harness, {
          hostId: host.id,
          sessionId: session.id,
          commands: [
            skill("stories", "user", {
              description: "Show Ladle story links",
            }),
          ],
        });

        const response = await harness.app.request(
          `/api/v1/projects/${project.id}/commands?provider=codex&environmentId=`,
        );

        expect(response.status).toBe(200);
        const body = commandListResponseSchema.parse(await readJson(response));
        expect(body.commands.map((command) => command.name)).toEqual([
          "clear",
          "compact",
          "stories",
        ]);
        expect(stub.requests[0]?.command).toEqual({
          type: "host.list_commands",
          providerId: "codex",
          cwd: "/tmp/inherited-skills-project",
          nativeRoots: declaredNativeRootSet(
            harness.deps.providerRegistry,
            "codex",
          ),
        });
      },
    );
  });

  it("returns the complete snapshot for local composer filtering", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-direct-skill",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/direct-skill-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/direct-skill-env",
      });
      registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [
          skill("alpha-review-notes", "user"),
          skill("ottonomous:review", "user"),
          skill("zeta-review", "user"),
        ],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=codex&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "alpha-review-notes",
        "ottonomous:review",
        "zeta-review",
      ]);
    });
  });

  it("returns an empty list without an RPC for a provider with no command surface", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-unknown",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("anything", "user")],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=unknown-provider&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body).toEqual({ commands: [] });
      expect(stub.requests).toEqual([]);
    });
  });

  it("lists skills for pi via the shared command surface", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-pi",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/pi-commands-env",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("bb-cli", "user", { description: "Use the bb CLI" })],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=pi&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "bb-cli",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "pi",
        cwd: "/tmp/pi-commands-env",
        nativeRoots: declaredNativeRootSet(harness.deps.providerRegistry, "pi"),
      });
    });
  });

  it("falls back to the project source (cwd) with no environmentId and returns user-origin entries", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-no-env",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/no-env-project",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("user-only", "user", { description: "Home skill" })],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "user-only",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "claude-code",
        cwd: "/tmp/no-env-project",
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "claude-code",
        ),
      });
    });
  });

  it("degrades to the project source (no 409) when the given environment is still provisioning", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-provisioning",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/provisioning-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/provisioning-env",
        status: "provisioning",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("user-only", "user", { description: "Home skill" })],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "user-only",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "claude-code",
        cwd: "/tmp/provisioning-project",
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "claude-code",
        ),
      });
    });
  });

  it("passes cwd: null when there is neither a given environment nor a project source", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-no-source",
      });
      seedPrimaryHost(harness.deps, host.id);
      const otherHost = seedHost(harness.deps, { id: "host-commands-other" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: otherHost.id,
        path: "/tmp/other-host-project",
      });
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("user-only", "user")],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "user-only",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "claude-code",
        cwd: null,
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "claude-code",
        ),
      });
    });
  });

  it("lists user-home commands for the personal project", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-personal",
      });
      seedPrimaryHost(harness.deps, host.id);
      const stub = registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [skill("home-skill", "user")],
      });

      const response = await harness.app.request(
        `/api/v1/projects/${PERSONAL_PROJECT_ID}/commands?provider=codex&environmentId=`,
      );

      expect(response.status).toBe(200);
      const body = commandListResponseSchema.parse(await readJson(response));
      expect(body.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "home-skill",
      ]);
      expect(stub.requests[0]?.command).toEqual({
        type: "host.list_commands",
        providerId: "codex",
        cwd: null,
        nativeRoots: declaredNativeRootSet(
          harness.deps.providerRegistry,
          "codex",
        ),
      });
    });
  });

  it("returns an error response when the host is offline", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-commands-offline" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=${environment.id}`,
      );

      expect(response.status).toBe(502);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "host_unavailable",
      });
    });
  });

  it("returns the full command catalog in one snapshot", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-commands-limit",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/limit-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/limit-env",
      });
      registerCommandRpc(harness, {
        hostId: host.id,
        sessionId: session.id,
        commands: [
          skill("alpha", "project"),
          skill("bravo", "project"),
          skill("charlie", "project"),
          skill("delta", "project"),
        ],
      });

      const fullResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/commands?provider=claude-code&environmentId=${environment.id}`,
      );
      expect(fullResponse.status).toBe(200);
      const full = commandListResponseSchema.parse(
        await readJson(fullResponse),
      );
      expect(full.commands.map((command) => command.name)).toEqual([
        "clear",
        "compact",
        "alpha",
        "bravo",
        "charlie",
        "delta",
      ]);
    });
  });
});
