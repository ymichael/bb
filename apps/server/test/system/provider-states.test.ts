import type { ProviderHealth } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { getProviderStates } from "../../src/services/system/provider-states.js";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { minimalProviderRegistration } from "../helpers/provider-registry.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function readyHealth(providerId: string): ProviderHealth {
  return {
    status: "ready",
    statusMessage: null,
    accountEmail: `${providerId}@example.com`,
    planLabel: null,
    installedVersion: "1.0.0",
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  };
}

const INSTALLED_ONLY_PROVIDER_IDS = new Set([
  "acp-opencode",
  "acp-omp",
  "acp-grok",
  "acp-hermes-agent",
]);

function healthForInstalledOnlyProvider(
  providerId: string,
  installedIds: ReadonlySet<string>,
): ProviderHealth {
  return INSTALLED_ONLY_PROVIDER_IDS.has(providerId) &&
    !installedIds.has(providerId)
    ? { ...readyHealth(providerId), status: "not_installed" }
    : readyHealth(providerId);
}

describe("getProviderStates", () => {
  it("reports an unauthenticated provider as ready when contributed env supplies credentials", async () => {
    await withTestHarness(async (harness) => {
      setPluginAgentContributions({
        listSkillRootContributions: () => [],
        listAgentTools: () => [],
        listInstructionContributions: () => [],
        findAgentTool: () => undefined,
        invokeAgentTool: async () => ({
          success: false,
          contentItems: [{ type: "inputText", text: "unused" }],
        }),
        resolveMention: async () => ({ ok: false, error: "unused" }),
        resolveProviderEnvHealth: async ({ providerId }) =>
          providerId === "claude-code"
            ? {
                label: "Proxied",
                statusMessage:
                  "Credentials are provided by the Account Pooler hub.",
              }
            : null,
      });
      try {
        const { host, session } = seedHostSession(harness.deps);
        registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: (request) => {
            if (request.command.type === "provider.health") {
              return {
                ok: true,
                result: {
                  supported: true,
                  health:
                    request.command.providerId === "claude-code"
                      ? {
                          ...readyHealth("claude-code"),
                          status: "unauthenticated",
                          loginCommand: "claude /login",
                        }
                      : readyHealth(request.command.providerId),
                },
              };
            }
            throw new Error(`Unexpected command ${request.command.type}`);
          },
        });

        const result = await getProviderStates(harness.deps, {
          hostId: host.id,
        });

        expect(
          result.providers.find(
            (provider) => provider.providerId === "claude-code",
          ),
        ).toMatchObject({
          status: "ready",
          statusMessage:
            "Credentials are provided by the Account Pooler hub.",
          planLabel: "Proxied",
          accountEmail: null,
          loginCommand: null,
        });
      } finally {
        setPluginAgentContributions(undefined);
      }
    });
  });

  it("asks each provider bridge and preserves model-picker order", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: {
                supported: true,
                health: healthForInstalledOnlyProvider(
                  request.command.providerId,
                  new Set(["acp-opencode"]),
                ),
              },
            };
          }
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      const result = await getProviderStates(harness.deps, {
        hostId: host.id,
      });

      expect(result.providers.map((provider) => provider.providerId)).toEqual([
        "codex",
        "claude-code",
        "pi",
        "acp-cursor",
        "acp-opencode",
      ]);
      expect(result.providers[0]).toMatchObject({
        providerId: "codex",
        status: "ready",
      });
    });
  });

  it("does not start a health probe the provider did not declare", async () => {
    await withTestHarness(async (harness) => {
      harness.deps.providerRegistry.register(
        minimalProviderRegistration({
          pluginId: "provider-no-health",
          info: {
            id: "no-health",
            pluginId: "provider-no-health",
            displayName: "No Health",
            logoUrl: null,
            available: true,
            maintenance: { health: false, usage: false, installation: false },
            capabilities: {
              supportsThreadArchive: false,
              supportsThreadRename: false,
              supportsServiceTier: false,
              supportsNativeUserQuestion: false,
              supportsFork: false,
              supportsSessionRewind: false,
              modelCatalogScope: "workspace",
              permissionModes: ["full"],
            },
            composerActions: [],
          },
          serverCapabilities: {
            reasoningLevels: ["medium"],
            fork: "none",
            supportsManualCompaction: false,
          },
        }),
      );
      const { host, session } = seedHostSession(harness.deps);
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: {
                supported: true,
                health: healthForInstalledOnlyProvider(
                  request.command.providerId,
                  new Set(),
                ),
              },
            };
          }
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      const result = await getProviderStates(harness.deps, {
        hostId: host.id,
      });

      expect(
        result.providers.find(
          (provider) => provider.providerId === "no-health",
        ),
      ).toMatchObject({
        status: "unknown",
        statusMessage: "This provider does not report readiness.",
      });
      expect(
        responder.requests.some(
          (request) =>
            request.command.type === "provider.health" &&
            request.command.providerId === "no-health",
        ),
      ).toBe(false);
    });
  });

  it("resolves a reused environment and its cwd to the environment host", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHostSession(harness.deps, {
        id: "host-primary",
        name: "Primary",
      });
      const remote = seedHostSession(harness.deps, {
        id: "host-remote",
        name: "Remote",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: remote.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: remote.host.id,
        projectId: project.id,
      });
      let primaryCalls = 0;
      const healthCwds: Array<string | undefined> = [];

      registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: () => {
          primaryCalls += 1;
          throw new Error("Primary host should not be queried");
        },
      });
      registerHostRpcResponder(harness, {
        hostId: remote.host.id,
        sessionId: remote.session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            healthCwds.push(request.command.cwd);
            return {
              ok: true,
              result: {
                supported: true,
                health: healthForInstalledOnlyProvider(
                  request.command.providerId,
                  new Set(),
                ),
              },
            };
          }
          throw new Error(`Unexpected command ${request.command.type}`);
        },
      });

      const result = await getProviderStates(harness.deps, {
        environmentId: environment.id,
      });

      expect(result.providers[0]?.providerId).toBe("codex");
      expect(primaryCalls).toBe(0);
      expect(healthCwds.filter((cwd) => cwd === undefined)).toHaveLength(4);
      expect(healthCwds.filter((cwd) => cwd !== undefined)).toEqual(
        Array(4).fill(environment.path),
      );
    });
  });
});
