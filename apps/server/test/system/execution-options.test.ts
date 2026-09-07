import { describe, expect, it, vi } from "vitest";
import { getAppSettings, setAppSettings } from "@bb/db";
import {
  hostDaemonServerWsMessageSchema,
  type HostDaemonOnlineRpcRequestMessage,
} from "@bb/host-daemon-contract";
import {
  appendCustomModels,
  listSystemProviderInfos,
  resolveSystemExecutionOptions,
  resolveSystemProviderModels,
} from "../../src/services/system/execution-options.js";
import { ApiError } from "../../src/errors.js";
import { availableModelFixture } from "../helpers/available-models.js";
import {
  registerHostRpcResponder,
  registerProviderHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  createTestProviderRegistry,
  registerFirstPartyProviders,
  configuredAcpProvider,
} from "../helpers/provider-registry.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";

const registry = await createTestProviderRegistry();

function providerDiscoveryHealth(installed: boolean) {
  return {
    supported: true as const,
    health: {
      status: installed ? ("ready" as const) : ("not_installed" as const),
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: null,
      minimumSupportedVersion: null,
      canInstall: false,
      canUpdate: false,
      loginCommand: null,
    },
  };
}

const EXAMPLE_AGENT_SETTING = {
  id: "example-agent",
  displayName: "Example Agent",
  command: "example-agent",
  args: ["acp"],
};

describe("appendCustomModels", () => {
  it("appends custom models for the requested provider after the catalog", () => {
    const catalogModel = availableModelFixture({
      model: "claude-opus-4-8",
      isDefault: true,
    });

    const { models, selectedOnlyModels } = appendCustomModels(registry, {
      customModels: [
        {
          providerId: "claude-code",
          model: "claude-example-preview[1m]",
          displayName: "Example Preview (1M)",
        },
        { providerId: "pi", model: "anthropic/claude-example-preview" },
      ],
      models: [catalogModel],
      providerId: "claude-code",
      selectedOnlyModels: [],
    });

    expect(models.map((model) => model.model)).toEqual([
      "claude-opus-4-8",
      "claude-example-preview[1m]",
    ]);
    expect(models[1]).toMatchObject({
      id: "claude-example-preview[1m]",
      displayName: "Example Preview (1M)",
      defaultReasoningEffort: "medium",
      isDefault: false,
    });
    expect(selectedOnlyModels).toEqual([]);
  });

  it("advertises the full reasoning ladder for claude-code custom models", () => {
    const { models } = appendCustomModels(registry, {
      customModels: [
        { providerId: "claude-code", model: "claude-example-preview" },
      ],
      models: [],
      providerId: "claude-code",
      selectedOnlyModels: [],
    });

    expect(
      models[0].supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "ultracode", "max"]);
  });

  it("uses the provider reasoning ladder for codex and pi custom models", () => {
    const { models: codexModels } = appendCustomModels(registry, {
      customModels: [{ providerId: "codex", model: "custom-model" }],
      models: [],
      providerId: "codex",
      selectedOnlyModels: [],
    });
    expect(
      codexModels[0].supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);

    const { models: piModels } = appendCustomModels(registry, {
      customModels: [{ providerId: "pi", model: "custom-model" }],
      models: [],
      providerId: "pi",
      selectedOnlyModels: [],
    });
    expect(
      piModels[0].supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(piModels[0].defaultReasoningEffort).toBe("medium");
  });

  it("appends dynamic ACP custom models with the agent-managed effort", () => {
    const { models } = appendCustomModels(registry, {
      customModels: [
        {
          providerId: "acp-opencode",
          model: "my-proxy/custom-model",
          displayName: "My Proxy Custom Model",
        },
      ],
      models: [],
      providerId: "acp-opencode",
      selectedOnlyModels: [],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "my-proxy/custom-model",
      displayName: "My Proxy Custom Model",
      defaultReasoningEffort: "medium",
      isDefault: false,
    });
    expect(
      models[0].supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      ),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("falls back to the model id when displayName is omitted", () => {
    const { models } = appendCustomModels(registry, {
      customModels: [
        { providerId: "claude-code", model: "claude-example-preview" },
      ],
      models: [],
      providerId: "claude-code",
      selectedOnlyModels: [],
    });

    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe("claude-example-preview");
  });

  it("keeps the catalog entry when a custom model id collides", () => {
    const catalogModel = availableModelFixture({ model: "claude-opus-4-8" });

    const { models } = appendCustomModels(registry, {
      customModels: [
        {
          providerId: "claude-code",
          model: "claude-opus-4-8",
          displayName: "Shadowed",
        },
      ],
      models: [catalogModel],
      providerId: "claude-code",
      selectedOnlyModels: [],
    });

    expect(models).toEqual([catalogModel]);
  });

  it("promotes a selected-only catalog entry instead of synthesizing one", () => {
    const retiredModel = availableModelFixture({
      model: "claude-opus-4-6",
      reasoningLevels: ["low", "medium"],
    });

    const { models, selectedOnlyModels } = appendCustomModels(registry, {
      customModels: [
        {
          providerId: "claude-code",
          model: "claude-opus-4-6",
          displayName: "Ignored",
        },
      ],
      models: [],
      providerId: "claude-code",
      selectedOnlyModels: [retiredModel],
    });

    expect(models).toEqual([retiredModel]);
    expect(selectedOnlyModels).toEqual([]);
  });

  it("ignores duplicate custom entries for the same model id", () => {
    const { models } = appendCustomModels(registry, {
      customModels: [
        {
          providerId: "claude-code",
          model: "claude-example-preview",
          displayName: "First",
        },
        {
          providerId: "claude-code",
          model: "claude-example-preview",
          displayName: "Second",
        },
      ],
      models: [],
      providerId: "claude-code",
      selectedOnlyModels: [],
    });

    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe("First");
  });

  it("returns the catalog unchanged when no custom models match", () => {
    const catalogModel = availableModelFixture({ model: "claude-opus-4-8" });
    const retiredModel = availableModelFixture({ model: "claude-opus-4-6" });

    const { models, selectedOnlyModels } = appendCustomModels(registry, {
      customModels: [
        { providerId: "pi", model: "anthropic/claude-example-preview" },
      ],
      models: [catalogModel],
      providerId: "claude-code",
      selectedOnlyModels: [retiredModel],
    });

    expect(models).toEqual([catalogModel]);
    expect(selectedOnlyModels).toEqual([retiredModel]);
  });
});

describe("resolveSystemExecutionOptions", () => {
  it("keeps an unavailable provider in the roster and returns its picker error without probing it", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        await registerFirstPartyProviders(harness.deps.providerRegistry, {
          excludePluginIds: ["provider-acp"],
          unavailablePluginIds: ["provider-codex"],
        });
        const { host } = seedHostSession(harness.deps, {
          id: "host-execution-options-unavailable-provider",
        });

        const response = await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "codex",
        });

        expect(response.providers[0]).toEqual(
          expect.objectContaining({ id: "codex", available: false }),
        );
        expect(response.models).toEqual([]);
        expect(response.selectedOnlyModels).toEqual([]);
        expect(response.modelLoadError).toEqual({
          providerId: "codex",
          code: "provider_unavailable",
        });
      },
    );
  });

  it("includes installed plugin providers and sends their launch spec when loading models", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-known-acp-installed",
      });
      const catalogModel = availableModelFixture({
        model: "opencode/default",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: providerDiscoveryHealth(
                request.command.providerId === "acp-opencode",
              ),
            };
          }
          if (request.command.type === "provider.list_models") {
            return {
              ok: true,
              result: {
                models: [catalogModel],
                selectedOnlyModels: [],
              },
            };
          }
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        },
      });

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "acp-opencode",
      });

      expect(response.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "acp-opencode",
            displayName: "opencode",
            available: true,
          }),
        ]),
      );
      expect(response.models).toEqual([catalogModel]);
      expect(
        responder.requests.filter(
          (request) => request.command.type === "provider.health",
        ),
      ).toHaveLength(4);
      const modelRequest = responder.requests.find(
        (request) => request.command.type === "provider.list_models",
      );
      expect(modelRequest?.command).toMatchObject({
        type: "provider.list_models",
        providerId: "acp-opencode",
        bridgeLaunch: {
          providerOptions: {
            acpLaunchSpec: {
              displayName: "opencode",
              command: "opencode",
              args: ["acp"],
              env: {},
            },
          },
        },
      });
    });
  });

  it("includes installed Grok Build and sends its plugin launch spec when loading models", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-known-grok-installed",
      });
      const catalogModel = availableModelFixture({
        model: "grok-4.5",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: providerDiscoveryHealth(
                request.command.providerId === "acp-grok",
              ),
            };
          }
          if (request.command.type === "provider.list_models") {
            return {
              ok: true,
              result: {
                models: [catalogModel],
                selectedOnlyModels: [],
              },
            };
          }
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        },
      });

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "acp-grok",
      });

      expect(response.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "acp-grok",
            displayName: "Grok Build",
            available: true,
          }),
        ]),
      );
      expect(response.models).toEqual([catalogModel]);
      const grokModelRequest = responder.requests.find(
        (request) => request.command.type === "provider.list_models",
      );
      expect(grokModelRequest?.command).toMatchObject({
        type: "provider.list_models",
        providerId: "acp-grok",
        bridgeLaunch: {
          providerOptions: {
            acpLaunchSpec: {
              displayName: "Grok Build",
              command: "grok",
              args: ["agent", "stdio"],
              env: {},
              modelCli: {
                listArgs: ["models"],
                selectFlag: "--model",
                primaryModels: ["grok-4.5", "grok-composer-2.5-fast"],
              },
              permissionCli: {
                full: ["--always-approve"],
                insertAfterArgs: 1,
              },
              reasoningCli: {
                flag: "--reasoning-effort",
                supportedLevels: ["low", "medium", "high"],
                levelValues: {
                  none: "low",
                  xhigh: "high",
                  ultracode: "high",
                  max: "high",
                },
                defaultLevel: "high",
              },
            },
          },
        },
      });
    });
  });

  it("includes installed Hermes Agent and sends its plugin launch spec when loading models", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-known-hermes-installed",
      });
      const catalogModel = availableModelFixture({
        model: "openrouter:openai/gpt-5.5",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: providerDiscoveryHealth(
                request.command.providerId === "acp-hermes-agent",
              ),
            };
          }
          if (request.command.type === "provider.list_models") {
            return {
              ok: true,
              result: {
                models: [catalogModel],
                selectedOnlyModels: [],
              },
            };
          }
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        },
      });

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "acp-hermes-agent",
      });

      expect(response.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "acp-hermes-agent",
            displayName: "Hermes Agent",
            available: true,
          }),
        ]),
      );
      expect(response.models).toEqual([catalogModel]);
      const hermesModelRequest = responder.requests.find(
        (request) => request.command.type === "provider.list_models",
      );
      expect(hermesModelRequest?.command).toMatchObject({
        type: "provider.list_models",
        providerId: "acp-hermes-agent",
        bridgeLaunch: {
          providerOptions: {
            acpLaunchSpec: {
              displayName: "Hermes Agent",
              command: "hermes",
              args: ["acp"],
              env: {},
              nativeReasoning: {
                configId: "reasoning_effort",
                supportedLevels: [
                  "none",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ],
                defaultLevel: "medium",
              },
            },
          },
        },
      });
    });
  });

  it("omits installed-only providers that their bridge reports missing", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-known-acp-missing",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "provider.health") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          return {
            ok: true,
            result: providerDiscoveryHealth(false),
          };
        },
      });

      const providers = await listSystemProviderInfos(harness.deps, {
        hostId: host.id,
      });

      expect(providers.map((provider) => provider.id)).not.toContain(
        "acp-opencode",
      );
    });
  });

  it("spends one command timeout across installed-only provider discovery", async () => {
    vi.useFakeTimers();
    try {
      await withTestHarness({}, async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-provider-discovery-budget",
        });
        const responder = registerHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => new Promise(() => undefined),
        });

        let settled = false;
        const pendingProviders = listSystemProviderInfos(harness.deps, {
          hostId: host.id,
        }).then((providers) => {
          settled = true;
          return providers;
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(responder.requests).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        const providers = await pendingProviders;
        expect(settled).toBe(true);
        expect(responder.requests).toHaveLength(6);
        expect(providers.map((provider) => provider.id)).not.toContain(
          "acp-opencode",
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "status returns 502",
      failStatusRequest: false,
    },
    {
      name: "status throws 504",
      failStatusRequest: true,
    },
  ])(
    "keeps always-visible and custom providers when installed-only provider $name",
    async ({ failStatusRequest }) => {
      await withTestHarness(
        {
          extraProviders: [await configuredAcpProvider(EXAMPLE_AGENT_SETTING)],
        },
        async (harness) => {
          const warn = vi.fn();
          harness.deps.logger = { ...harness.deps.logger, warn };
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-execution-options-known-acp-status-fails-${failStatusRequest}`,
          });
          const catalogModel = availableModelFixture({ model: "gpt-5.5" });
          const responder = registerHostRpcResponder(harness, {
            hostId: host.id,
            sessionId: session.id,
            handle: (request) => {
              if (request.command.type === "provider.health") {
                return {
                  ok: false,
                  errorCode: "host_unavailable",
                  errorMessage: "Host is not connected",
                };
              }
              if (request.command.type === "provider.list_models") {
                return {
                  ok: true,
                  result: {
                    models: [catalogModel],
                    selectedOnlyModels: [],
                  },
                };
              }
              throw new Error(`Unexpected RPC command ${request.command.type}`);
            },
          });
          if (failStatusRequest) {
            const requestHostOnlineRpc = harness.hub.requestHostOnlineRpc.bind(
              harness.hub,
            );
            vi.spyOn(harness.hub, "requestHostOnlineRpc").mockImplementation(
              async (args) => {
                if (args.message.command.type === "provider.health") {
                  throw new ApiError(
                    504,
                    "command_timeout",
                    "Timed out waiting for command result",
                  );
                }
                return requestHostOnlineRpc(args);
              },
            );
          }

          const response = await resolveSystemExecutionOptions(harness.deps, {
            hostId: host.id,
            providerId: "codex",
          });

          expect(response.providers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "codex" }),
              expect.objectContaining({ id: "acp-example-agent" }),
            ]),
          );
          expect(
            response.providers.map((provider) => provider.id),
          ).not.toContain("acp-opencode");
          expect(response.models).toEqual([catalogModel]);
          expect(response.modelLoadError).toBeNull();
          expect(
            responder.requests.filter(
              (request) => request.command.type === "provider.health",
            ),
          ).toHaveLength(failStatusRequest ? 0 : 4);
          expect(
            responder.requests.filter(
              (request) => request.command.type === "provider.list_models",
            ),
          ).toHaveLength(1);
          const statusWarning = warn.mock.calls.find(
            ([fields, message]) =>
              message === "Failed to resolve installed-only provider status" &&
              fields.providerId === "acp-opencode",
          );
          expect(statusWarning).toBeDefined();
          expect(statusWarning?.[0]).toMatchObject({
            errorCode: failStatusRequest
              ? "command_timeout"
              : "host_unavailable",
            errorMessage: failStatusRequest
              ? "Timed out waiting for command result"
              : "Host is not connected",
            errorStatus: failStatusRequest ? 504 : 502,
            hostId: host.id,
          });
          expect(statusWarning?.[0]).not.toHaveProperty("err");
        },
      );
    },
  );

  it("applies the provider discovery fallback to every concurrent reader", async () => {
    await withTestHarness({}, async (harness) => {
      const warn = vi.fn();
      harness.deps.logger = { ...harness.deps.logger, warn };
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-shared-provider-fallback",
      });
      let releaseHealthFailure = (): void => {};
      const healthFailure = new Promise<HostRpcHandlerResult>((resolve) => {
        releaseHealthFailure = () =>
          resolve({
            ok: false,
            errorCode: "host_unavailable",
            errorMessage: "Host is not connected",
          });
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type !== "provider.health") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          return healthFailure;
        },
      });

      const first = listSystemProviderInfos(harness.deps, { hostId: host.id });
      await vi.waitFor(() => {
        expect(responder.requests.length).toBeGreaterThan(0);
      });
      const second = listSystemProviderInfos(harness.deps, {
        hostId: host.id,
      });
      releaseHealthFailure();

      const [firstProviders, secondProviders] = await Promise.all([
        first,
        second,
      ]);
      expect(secondProviders).toEqual(firstProviders);
      const healthProviderIds = responder.requests.map((request) => {
        if (request.command.type !== "provider.health") {
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        }
        return request.command.providerId;
      });
      expect(new Set(healthProviderIds).size).toBe(healthProviderIds.length);
      expect(warn).toHaveBeenCalled();
    });
  });

  it("keeps another host's provider answers when one host probe fails", async () => {
    await withTestHarness({}, async (harness) => {
      const healthy = seedHostSession(harness.deps, {
        id: "host-provider-cache-healthy",
      });
      const healthyResponder = registerHostRpcResponder(harness, {
        hostId: healthy.host.id,
        sessionId: healthy.session.id,
        handle: (request) => {
          if (request.command.type !== "provider.health") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          return {
            ok: true,
            result: providerDiscoveryHealth(true),
          };
        },
      });
      await listSystemProviderInfos(harness.deps, {
        hostId: healthy.host.id,
      });
      const healthyProbeCount = healthyResponder.requests.length;
      expect(healthyProbeCount).toBeGreaterThan(0);

      const failing = seedHostSession(harness.deps, {
        id: "host-provider-cache-failing",
      });
      registerHostRpcResponder(harness, {
        hostId: failing.host.id,
        sessionId: failing.session.id,
        handle: (request) => {
          if (request.command.type !== "provider.health") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          return {
            ok: false,
            errorCode: "host_unavailable",
            errorMessage: "Host is not connected",
          };
        },
      });
      await listSystemProviderInfos(harness.deps, {
        hostId: failing.host.id,
      });
      await listSystemProviderInfos(harness.deps, {
        hostId: healthy.host.id,
      });

      expect(healthyResponder.requests).toHaveLength(healthyProbeCount);
    });
  });

  it("keeps configured providers and custom models when no host can be resolved", async () => {
    await withTestHarness(
      {
        extraProviders: [await configuredAcpProvider(EXAMPLE_AGENT_SETTING)],
        customModels: [
          {
            providerId: "codex",
            model: "gpt-custom",
            displayName: "Custom GPT",
          },
        ],
      },
      async (harness) => {
        const warn = vi.fn();
        harness.deps.logger = { ...harness.deps.logger, warn };
        const response = await resolveSystemExecutionOptions(harness.deps, {
          providerId: "codex",
        });

        expect(response.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "codex" }),
            expect.objectContaining({ id: "acp-example-agent" }),
          ]),
        );
        expect(response.providers.map((provider) => provider.id)).not.toContain(
          "acp-opencode",
        );
        expect(response.models).toEqual([
          expect.objectContaining({
            model: "gpt-custom",
            displayName: "Custom GPT",
          }),
        ]);
        expect(response.modelLoadError).toEqual({
          providerId: "codex",
          code: "failed",
        });
        const hostLookupWarning = warn.mock.calls.find(
          ([, message]) =>
            message === "Failed to resolve host for provider discovery",
        );
        expect(hostLookupWarning).toBeDefined();
        expect(hostLookupWarning?.[0]).toMatchObject({
          errorCode: "host_unavailable",
          errorMessage: "Local host daemon is not initialized",
          errorStatus: 502,
        });
        expect(hostLookupWarning?.[0]).not.toHaveProperty("err");
      },
    );
  });

  it("keeps custom models selectable when the provider model list fails to load", async () => {
    await withTestHarness(
      {
        customModels: [
          {
            providerId: "claude-code",
            model: "claude-example-preview",
            displayName: "Example Preview",
          },
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-model-load-error",
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelErrorsByProviderId: {
            "claude-code": {
              errorCode: "provider_rpc_error",
              errorMessage: "Provider failed",
            },
          },
        });

        const response = await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "claude-code",
        });

        expect(response.modelLoadError).toEqual({
          providerId: "claude-code",
          code: "failed",
        });
        expect(response.models.map((model) => model.model)).toEqual([
          "claude-fable-5-1",
          "claude-opus-5[1m]",
          "claude-opus-4-8[1m]",
          "claude-opus-4-7[1m]",
          "claude-sonnet-5",
          "claude-example-preview",
        ]);
        expect(response.selectedOnlyModels).toEqual([]);
      },
    );
  });

  it("hides custom models while streamer mode is on and restores them when it is off", async () => {
    await withTestHarness(
      {
        customModels: [
          {
            providerId: "claude-code",
            model: "claude-example-preview",
            displayName: "Example Preview",
          },
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-streamer-mode",
        });
        const catalogModel = availableModelFixture({ model: "claude-opus-5" });
        const responder = registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelsByProviderId: {
            "claude-code": { models: [catalogModel], selectedOnlyModels: [] },
          },
        });
        const listModelIds = async () =>
          (
            await resolveSystemExecutionOptions(harness.deps, {
              hostId: host.id,
              providerId: "claude-code",
            })
          ).models.map((model) => model.model);

        expect(await listModelIds()).toEqual([
          "claude-opus-5",
          "claude-example-preview",
        ]);

        setAppSettings(harness.db, {
          ...getAppSettings(harness.db),
          streamerMode: true,
        });
        expect(await listModelIds()).toEqual(["claude-opus-5"]);

        setAppSettings(harness.db, {
          ...getAppSettings(harness.db),
          streamerMode: false,
        });
        expect(await listModelIds()).toEqual([
          "claude-opus-5",
          "claude-example-preview",
        ]);
        expect(
          responder.requests.filter(
            (request) => request.command.type === "provider.list_models",
          ),
        ).toHaveLength(1);
      },
    );
  });

  it("keeps custom models in the thread-create default catalog while streamer mode is on", async () => {
    await withTestHarness(
      {
        customModels: [
          { providerId: "claude-code", model: "claude-example-preview" },
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-provider-models-streamer-mode",
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelsByProviderId: {
            "claude-code": { models: [], selectedOnlyModels: [] },
          },
        });
        setAppSettings(harness.db, {
          ...getAppSettings(harness.db),
          streamerMode: true,
        });

        const catalog = await resolveSystemProviderModels(harness.deps, {
          hostId: host.id,
          providerId: "claude-code",
        });

        expect(catalog.models.map((model) => model.model)).toEqual([
          "claude-example-preview",
        ]);
      },
    );
  });

  it("serves the curated Claude catalog when the model probe fails transiently", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-claude-provisional",
      });
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          "claude-code": {
            errorCode: "command_timeout",
            errorMessage: "Model probe timed out",
          },
        },
      });

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "claude-code",
      });

      expect(response.modelLoadError).toEqual({
        providerId: "claude-code",
        code: "timeout",
      });
      expect(response.models.map((model) => model.model)).toEqual([
        "claude-fable-5-1",
        "claude-opus-5[1m]",
        "claude-opus-4-8[1m]",
        "claude-opus-4-7[1m]",
        "claude-sonnet-5",
      ]);
      expect(
        response.models
          .filter((model) => model.isDefault)
          .map((model) => model.model),
      ).toEqual(["claude-opus-5[1m]"]);
    });
  });

  it.each([
    ["auth required", "auth_required"],
    ["missing executable", "missing_executable"],
  ] as const)(
    "offers no provisional Claude models for %s setup failures",
    async (_name, errorCode) => {
      await withTestHarness({}, async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: `host-execution-options-claude-${errorCode}`,
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelErrorsByProviderId: {
            "claude-code": {
              errorCode,
              errorMessage: "Claude Code is not usable",
            },
          },
        });

        const response = await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "claude-code",
        });

        expect(response.modelLoadError).toEqual({
          providerId: "claude-code",
          code: errorCode,
        });
        expect(response.models).toEqual([]);
      });
    },
  );

  it("logs model load fallback errors without stack-bearing err objects", async () => {
    await withTestHarness(async (harness) => {
      const warn = vi.fn();
      harness.deps.logger = { ...harness.deps.logger, warn };
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-concise-model-log",
      });
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          codex: {
            errorCode: "command_failed",
            errorMessage: "model list failed",
          },
        },
      });

      await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "codex",
      });

      const providerModelWarning = warn.mock.calls.find(
        ([, message]) => message === "Failed to resolve provider models",
      );
      expect(providerModelWarning).toBeDefined();
      expect(providerModelWarning?.[0]).toMatchObject({
        errorCode: "command_failed",
        errorMessage: "model list failed",
        errorRetryable: false,
        errorStatus: 502,
        hostId: host.id,
        providerId: "codex",
      });
      expect(providerModelWarning?.[0]).not.toHaveProperty("err");
    });
  });

  it("lists a configured ACP agent and sends its launch spec when loading models", async () => {
    await withTestHarness(
      {
        extraProviders: [
          await configuredAcpProvider({
            id: "example-agent",
            displayName: "Example Agent",
            command: "example-agent",
            args: ["acp", "--stdio"],
            env: { EXAMPLE_TOKEN: "test-token" },
            cwd: "/tmp/example-agent",
            modelCli: {
              listArgs: ["models", "--json"],
              selectFlag: "--model",
              primaryModels: ["example/default"],
            },
          }),
        ],
      },
      async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-custom-acp",
        });
        const catalogModel = availableModelFixture({
          model: "example/default",
        });
        const responder = registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
          modelsByProviderId: {
            "acp-example-agent": {
              models: [catalogModel],
              selectedOnlyModels: [],
            },
          },
        });

        const response = await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "acp-example-agent",
        });

        expect(response.providers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "acp-example-agent",
              displayName: "Example Agent",
              available: true,
              composerActions: [{ kind: "skills", trigger: "/" }],
              capabilities: expect.objectContaining({
                supportsFork: false,
                supportsServiceTier: true,
                permissionModes: ["accept-edits", "full"],
              }),
            }),
          ]),
        );
        expect(response.models).toEqual([catalogModel]);
        expect(response.selectedOnlyModels).toEqual([]);
        expect(response.modelLoadError).toBeNull();
        expect(
          responder.requests.filter(
            (request) => request.command.type === "provider.health",
          ),
        ).toHaveLength(4);
        const modelRequest = responder.requests.find(
          (request) => request.command.type === "provider.list_models",
        );
        expect(modelRequest?.command).toMatchObject({
          type: "provider.list_models",
          providerId: "acp-example-agent",
          bridgeLaunch: {
            providerOptions: {
              acpLaunchSpec: {
                displayName: "Example Agent",
                command: "example-agent",
                args: ["acp", "--stdio"],
                env: { EXAMPLE_TOKEN: "test-token" },
                cwd: "/tmp/example-agent",
                modelCli: {
                  listArgs: ["models", "--json"],
                  selectFlag: "--model",
                  primaryModels: ["example/default"],
                },
              },
            },
          },
        });
      },
    );
  });

  it("waits for plugin provider registrations before answering with an empty registry", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
        });
        harness.deps.providerRegistry = registry;
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-boot-window",
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
        });

        const providersPromise = listSystemProviderInfos(harness.deps, {});
        await registerFirstPartyProviders(registry);
        registry.markRegistrationsSettled();

        expect((await providersPromise).map((provider) => provider.id)).toEqual(
          ["codex", "claude-code", "pi", "acp-cursor"],
        );
      },
    );
  });

  it("answers a provider-scoped picker request before unrelated plugins finish loading", async () => {
    await withTestHarness(
      { seedFirstPartyProviders: false },
      async (harness) => {
        const registry = createProviderRegistryService({
          deferRegistrationsSettled: true,
        });
        harness.deps.providerRegistry = registry;
        const { host, session } = seedHostSession(harness.deps, {
          id: "host-execution-options-provider-ready",
        });
        registerProviderHostRpcResponder(harness, {
          hostId: host.id,
          sessionId: session.id,
        });

        const optionsPromise = resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "pi",
        });
        await registerFirstPartyProviders(registry, {
          excludePluginIds: [
            "provider-acp",
            "provider-claude-code",
            "provider-codex",
          ],
          artifacts: harness.deps.pluginHostArtifacts,
        });

        const response = await optionsPromise;
        expect(response.providers.map((provider) => provider.id)).toEqual([
          "pi",
        ]);
        expect(response.modelLoadError).toBeNull();

        registry.markRegistrationsSettled();
      },
    );
  });

  it("surfaces provider auth-required model load failures", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-execution-options-auth-required",
      });
      const responder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          "acp-cursor": {
            errorCode: "auth_required",
            errorMessage: "Cursor agent is not authenticated.",
          },
        },
      });

      const response = await resolveSystemExecutionOptions(harness.deps, {
        hostId: host.id,
        providerId: "acp-cursor",
      });

      expect(response.modelLoadError).toEqual({
        providerId: "acp-cursor",
        code: "auth_required",
      });
      expect(
        responder.requests.filter(
          (request) => request.command.type === "provider.health",
        ),
      ).toHaveLength(4);
      const modelRequest = responder.requests.find(
        (request) => request.command.type === "provider.list_models",
      );
      expect(modelRequest?.command).toMatchObject({
        type: "provider.list_models",
        providerId: "acp-cursor",
      });
      expect(response.models).toEqual([]);
      expect(response.selectedOnlyModels).toEqual([]);
    });
  });

  it.each([
    ["missing executable", "missing_executable", "missing_executable"],
    ["auth required", "auth_required", "auth_required"],
    ["launch failure", "command_failed", "failed"],
  ] as const)(
    "surfaces a configured ACP agent's model-load %s error under its own identity",
    async (_name, hostErrorCode, expectedCode) => {
      await withTestHarness(
        {
          extraProviders: [
            await configuredAcpProvider({
              id: "broken-agent",
              displayName: "Broken Agent",
              command: "broken-agent",
            }),
          ],
        },
        async (harness) => {
          const { host, session } = seedHostSession(harness.deps, {
            id: `host-execution-options-${hostErrorCode}`,
          });
          registerProviderHostRpcResponder(harness, {
            hostId: host.id,
            sessionId: session.id,
            modelErrorsByProviderId: {
              "acp-broken-agent": {
                errorCode: hostErrorCode,
                errorMessage: "model list failed",
              },
            },
          });

          const response = await resolveSystemExecutionOptions(harness.deps, {
            hostId: host.id,
            providerId: "acp-broken-agent",
          });

          expect(response.modelLoadError).toEqual({
            providerId: "acp-broken-agent",
            code: expectedCode,
          });
          expect(response.providers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "acp-broken-agent",
                displayName: "Broken Agent",
              }),
            ]),
          );
        },
      );
    },
  );
});

function registerHeldModelListResponder(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string; modelId: string },
): {
  requests: HostDaemonOnlineRpcRequestMessage[];
  release(): void;
} {
  const requests: HostDaemonOnlineRpcRequestMessage[] = [];
  harness.hub.registerDaemon(args.sessionId, args.hostId, {
    close() {},
    send(data: string) {
      const message = hostDaemonServerWsMessageSchema.parse(JSON.parse(data));
      if (message.type !== "host-rpc.request") {
        throw new Error(`Unexpected daemon websocket message ${message.type}`);
      }
      if (message.command.type === "provider.health") {
        harness.hub.recordHostOnlineRpcResponse({
          sessionId: args.sessionId,
          message: {
            type: "host-rpc.response",
            requestId: message.requestId,
            commandType: message.command.type,
            ok: true,
            result: providerDiscoveryHealth(false),
          },
        });
        return;
      }
      if (message.command.type !== "provider.list_models") {
        throw new Error(`Unexpected RPC command ${message.command.type}`);
      }
      requests.push(message);
    },
  });
  return {
    requests,
    release() {
      for (const request of requests) {
        harness.hub.recordHostOnlineRpcResponse({
          sessionId: args.sessionId,
          message: {
            type: "host-rpc.response",
            requestId: request.requestId,
            commandType: "provider.list_models",
            ok: true,
            result: {
              models: [availableModelFixture({ model: args.modelId })],
              selectedOnlyModels: [],
            },
          },
        });
      }
    },
  };
}

function seedEnvironmentPath(
  harness: TestAppHarness,
  args: { hostId: string; path: string },
): string {
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: args.hostId,
    path: args.path,
  });
  return seedEnvironment(harness.deps, {
    hostId: args.hostId,
    projectId: project.id,
    path: args.path,
  }).id;
}

describe("resolveSystemExecutionOptions model probe memo", () => {
  it("serves a host-scoped catalog to every environment on the host from one probe without the workspace path", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-model-memo-shared",
      });
      const catalogModel = availableModelFixture({ model: "claude-opus-5" });
      const responder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelsByProviderId: {
          "claude-code": { models: [catalogModel], selectedOnlyModels: [] },
        },
      });
      const environmentA = seedEnvironmentPath(harness, {
        hostId: host.id,
        path: "/tmp/memo-workspace-a",
      });
      const environmentB = seedEnvironmentPath(harness, {
        hostId: host.id,
        path: "/tmp/memo-workspace-b",
      });

      const responses = [
        await resolveSystemExecutionOptions(harness.deps, {
          environmentId: environmentA,
          providerId: "claude-code",
        }),
        await resolveSystemExecutionOptions(harness.deps, {
          environmentId: environmentB,
          providerId: "claude-code",
        }),
        await resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "claude-code",
        }),
      ];

      for (const response of responses) {
        expect(response.models).toEqual([catalogModel]);
        expect(response.modelLoadError).toBeNull();
      }
      const modelListCommands = responder.requests
        .map((request) => request.command)
        .filter((command) => command.type === "provider.list_models");
      expect(modelListCommands).toHaveLength(1);
      expect(modelListCommands[0]).not.toHaveProperty("cwd");
    });
  });

  it("keeps a workspace-scoped catalog keyed by workspace path", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-model-memo-workspace-scoped",
      });
      const responder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelsByProviderId: {
          pi: {
            models: [availableModelFixture({ model: "anthropic/opus" })],
            selectedOnlyModels: [],
          },
        },
      });
      const environmentA = seedEnvironmentPath(harness, {
        hostId: host.id,
        path: "/tmp/memo-pi-a",
      });
      const environmentB = seedEnvironmentPath(harness, {
        hostId: host.id,
        path: "/tmp/memo-pi-b",
      });

      for (const environmentId of [environmentA, environmentA, environmentB]) {
        await resolveSystemExecutionOptions(harness.deps, {
          environmentId,
          providerId: "pi",
        });
      }

      expect(
        responder.requests
          .map((request) => request.command)
          .filter((command) => command.type === "provider.list_models")
          .map((command) => command.cwd),
      ).toEqual(["/tmp/memo-pi-a", "/tmp/memo-pi-b"]);
    });
  });

  it("shares one in-flight probe between concurrent readers", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-model-memo-inflight",
      });
      const responder = registerHeldModelListResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelId: "gpt-5",
      });

      const pending = Promise.all([
        resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "codex",
        }),
        resolveSystemExecutionOptions(harness.deps, {
          hostId: host.id,
          providerId: "codex",
        }),
      ]);
      await vi.waitFor(() => {
        expect(responder.requests.length).toBeGreaterThan(0);
      });
      responder.release();
      const [first, second] = await pending;

      expect(first.models.map((model) => model.model)).toEqual(["gpt-5"]);
      expect(second.models).toEqual(first.models);
      expect(
        responder.requests.filter(
          (request) => request.command.type === "provider.list_models",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not memoize a failed probe and re-probes after the daemon reconnects", async () => {
    await withTestHarness({}, async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-model-memo-invalidation",
      });
      const catalogModel = availableModelFixture({ model: "gpt-5" });
      let failProbe = true;
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "provider.health") {
            return {
              ok: true,
              result: providerDiscoveryHealth(false),
            };
          }
          if (request.command.type !== "provider.list_models") {
            throw new Error(`Unexpected RPC command ${request.command.type}`);
          }
          if (failProbe) {
            return {
              ok: false,
              errorCode: "command_timeout",
              errorMessage: "Model probe timed out",
            };
          }
          return {
            ok: true,
            result: { models: [catalogModel], selectedOnlyModels: [] },
          };
        },
      });
      const query = { hostId: host.id, providerId: "codex" };

      const failed = await resolveSystemExecutionOptions(harness.deps, query);
      expect(failed.modelLoadError).toEqual({
        providerId: "codex",
        code: "timeout",
      });

      failProbe = false;
      const recovered = await resolveSystemExecutionOptions(
        harness.deps,
        query,
      );
      expect(recovered.modelLoadError).toBeNull();
      expect(recovered.models).toEqual([catalogModel]);
      await resolveSystemExecutionOptions(harness.deps, query);
      expect(
        responder.requests.filter(
          (request) => request.command.type === "provider.list_models",
        ),
      ).toHaveLength(2);

      harness.hub.unregisterDaemon(session.id);
      const nextSession = seedSession(harness.deps, host.id);
      const nextResponder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: nextSession.id,
        modelsByProviderId: {
          codex: {
            models: [availableModelFixture({ model: "gpt-6" })],
            selectedOnlyModels: [],
          },
        },
      });
      const afterReconnect = await resolveSystemExecutionOptions(
        harness.deps,
        query,
      );
      expect(afterReconnect.models.map((model) => model.model)).toEqual([
        "gpt-6",
      ]);
      expect(
        nextResponder.requests.filter(
          (request) => request.command.type === "provider.list_models",
        ),
      ).toHaveLength(1);
    });
  });
});
