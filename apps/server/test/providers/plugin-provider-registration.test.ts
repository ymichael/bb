import { describe, expect, it } from "vitest";
import {
  validatePluginProviderDeclaration,
  type NormalizedPluginProviderDeclaration,
} from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { loadFirstPartyProviderDeclarations } from "../helpers/provider-registry.js";

function declaration(
  overrides: Partial<PluginProviderDeclaration> = {},
): NormalizedPluginProviderDeclaration {
  return validatePluginProviderDeclaration({
    id: "my-remote-agent",
    displayName: "My Remote Agent",
    icon: "./icons/agent.svg",
    experimental_bridgeOptions: { launch: { command: "my-agent" } },
    experimental_visibility: "installed",
    maintenance: { health: true, usage: false, installation: true },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: true,
      fork: "checkpoint",
      supportsManualCompaction: false,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high"],
    },
    composerActions: ["plan", "goal"],
    ...overrides,
  });
}

const NO_SETTINGS = () => ({});

describe("buildPluginProviderRegistration", () => {
  it("maps a declaration onto the single ProviderInfo and server capabilities", () => {
    const normalized = declaration();
    const registration = buildPluginProviderRegistration({
      available: true,
      pluginId: "acme-agent",
      declaration: normalized,
      iconHash: null,
      readSettings: NO_SETTINGS,
    });

    expect(registration.info).toStrictEqual({
      id: "my-remote-agent",
      pluginId: "acme-agent",
      displayName: "My Remote Agent",
      available: true,
      logoUrl: "/api/v1/system/providers/my-remote-agent/logo",
      maintenance: { health: true, usage: false, installation: true },
      capabilities: {
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: true,
        supportsNativeUserQuestion: true,
        supportsFork: true,
        supportsSessionRewind: true,
        modelCatalogScope: "workspace",
        permissionModes: ["accept-edits", "full"],
      },
      composerActions: [
        { kind: "skills", trigger: "/" },
        {
          kind: "plan",
          command: { trigger: "/", name: "plan", trailingText: " " },
        },
        {
          kind: "goal",
          command: { trigger: "/", name: "goal", trailingText: " " },
        },
      ],
      reasoningLevels: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      serviceTiers: [
        { id: "default", label: "Default" },
        { id: "fast", label: "Fast" },
      ],
    });
    expect(registration.serverCapabilities).toStrictEqual({
      reasoningLevels: ["low", "medium", "high"],
      fork: "checkpoint",
      supportsManualCompaction:
        normalized.capabilities.supportsManualCompaction,
    });
    expect(registration.bridgeOptions).toStrictEqual({
      launch: { command: "my-agent" },
    });
    expect(registration.visibility).toBe("installed");
    expect(registration.fallbackModels).toStrictEqual([]);
    expect(registration.envPassthrough).toStrictEqual([]);
    expect(
      registration.deriveProviderOptions({
        threadId: "thr_1",
        projectId: "proj_1",
        model: "m",
        permissionMode: "full",
      }),
    ).toStrictEqual({});
  });

  it("projects the target-state declaration fields onto ProviderInfo", () => {
    const registration = buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: "acme-agent",
      declaration: declaration({
        family: "remote",
        strings: {
          signInHint: "Run `my-agent login`.",
          expiredHint: "Session expired.",
          installUrl: "https://example.com/install",
          brandPrefix: "My ",
          iconTint: { light: "#111", dark: "#eee" },
        },
        reasoningLevels: [
          { id: "low", label: "Quick" },
          { id: "high", label: "Deep", description: "Slow but thorough." },
        ],
        serviceTiers: [
          { id: "default", label: "Standard" },
          { id: "fast", label: "Priority" },
        ],
        extensionKinds: {
          widget: { item: { "~standard": standardSchema() } },
          mood: {
            item: { "~standard": standardSchema() },
            state: { "~standard": standardSchema() },
          },
        },
      }),
      readSettings: NO_SETTINGS,
    });

    expect(registration.info.family).toBe("remote");
    expect(registration.info.strings).toStrictEqual({
      signInHint: "Run `my-agent login`.",
      expiredHint: "Session expired.",
      installUrl: "https://example.com/install",
      brandPrefix: "My ",
      iconTint: { light: "#111", dark: "#eee" },
    });
    expect(registration.info.reasoningLevels).toStrictEqual([
      { id: "low", label: "Quick" },
      { id: "high", label: "Deep", description: "Slow but thorough." },
    ]);
    expect(registration.info.serviceTiers).toStrictEqual([
      { id: "default", label: "Standard" },
      { id: "fast", label: "Priority" },
    ]);
    expect(registration.info.extensionKinds).toStrictEqual({
      "acme-agent/widget": { item: true, state: false },
      "acme-agent/mood": { item: true, state: true },
    });
  });

  it("binds the options hook to the plugin's settings and validates its result", () => {
    const registration = buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: "acme-agent",
      declaration: declaration({
        models: {
          fallback: [
            {
              id: "m-1",
              displayName: "Model One",
              description: "The one.",
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Low." },
                { reasoningEffort: "high", description: "High." },
              ],
              defaultReasoningEffort: "high",
              isDefault: true,
            },
          ],
        },
        env: { passthrough: ["BB_MY_AGENT_EXECUTABLE"] },
        deriveProviderOptions: (context) => ({
          memory: context.settings.memoryEnabled !== false,
          plan: context.promptMode === "plan",
          thread: context.threadId,
        }),
      }),
      readSettings: () => ({ memoryEnabled: false }),
    });

    expect(
      registration.deriveProviderOptions({
        threadId: "thr_1",
        projectId: "proj_1",
        model: "m-1",
        permissionMode: "auto",
        promptMode: "plan",
      }),
    ).toStrictEqual({ memory: false, plan: true, thread: "thr_1" });
    expect(registration.envPassthrough).toStrictEqual([
      "BB_MY_AGENT_EXECUTABLE",
    ]);
    expect(registration.fallbackModels).toStrictEqual([
      {
        id: "m-1",
        model: "m-1",
        displayName: "Model One",
        description: "The one.",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low." },
          { reasoningEffort: "high", description: "High." },
        ],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
    ]);
  });

  it("refuses a hook result that is not bounded plain JSON", () => {
    const registration = buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: "acme-agent",
      declaration: declaration({
        deriveProviderOptions: () => ({
          oops: (() => undefined) as unknown as string,
        }),
      }),
      readSettings: NO_SETTINGS,
    });
    expect(() =>
      registration.deriveProviderOptions({
        threadId: "thr_1",
        projectId: "proj_1",
        model: "m",
        permissionMode: "full",
      }),
    ).toThrow(/deriveProviderOptions result/);
  });

  it("projects each fork ladder rung onto the two client booleans", () => {
    const projection = (fork: "none" | "tip" | "checkpoint") => {
      const { capabilities } = buildPluginProviderRegistration({
        iconHash: null,
        available: true,
        pluginId: "acme-agent",
        declaration: declaration({
          capabilities: { ...declaration().capabilities, fork },
        }),
        readSettings: NO_SETTINGS,
      }).info;
      return {
        supportsFork: capabilities.supportsFork,
        supportsSessionRewind: capabilities.supportsSessionRewind,
      };
    };
    expect(projection("none")).toStrictEqual({
      supportsFork: false,
      supportsSessionRewind: false,
    });
    expect(projection("tip")).toStrictEqual({
      supportsFork: true,
      supportsSessionRewind: false,
    });
    expect(projection("checkpoint")).toStrictEqual({
      supportsFork: true,
      supportsSessionRewind: true,
    });
  });

  it("maps an icon-less declaration to a null logoUrl and skills-only actions", () => {
    const registration = buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: "acme-plain",
      declaration: declaration({
        id: "plain-agent",
        icon: undefined,
        composerActions: [],
        capabilities: {
          ...declaration().capabilities,
          supportsServiceTier: false,
        },
      }),
      readSettings: NO_SETTINGS,
    });

    expect(registration.info.logoUrl).toBeNull();
    expect(registration.info.icon).toBeUndefined();
    expect(registration.info.composerActions).toStrictEqual([
      { kind: "skills", trigger: "/" },
    ]);
    expect(registration.info.serviceTiers).toBeUndefined();
  });

  it("projects a named glyph icon by name and a path icon as a logo URL, never both", () => {
    const glyph = buildPluginProviderRegistration({
      available: true,
      pluginId: "echo-provider",
      declaration: declaration({ id: "echo-agent", icon: "Zap" }),
      iconHash: null,
      readSettings: NO_SETTINGS,
    });
    expect(glyph.info.icon).toStrictEqual({ glyph: "Zap" });
    expect(glyph.info.logoUrl).toBeNull();

    const path = buildPluginProviderRegistration({
      available: true,
      pluginId: "acme-agent",
      declaration: declaration({ icon: "./icons/agent.svg" }),
      iconHash: null,
      readSettings: NO_SETTINGS,
    });
    expect(path.info.icon).toBeUndefined();
    expect(path.info.logoUrl).toBe(
      "/api/v1/system/providers/my-remote-agent/logo",
    );
  });

  it("leaves the first-party providers on their SVG assets (no glyph)", async () => {
    const declarations = await loadFirstPartyProviderDeclarations();
    const projected = [...declarations.entries()].flatMap(([pluginId, list]) =>
      list.map((declared) => {
        const { info } = buildPluginProviderRegistration({
          available: true,
          pluginId,
          declaration: declared,
          iconHash: null,
          readSettings: NO_SETTINGS,
        });
        return { id: info.id, logoUrl: info.logoUrl, icon: info.icon };
      }),
    );
    expect(projected).toStrictEqual([
      {
        id: "codex",
        logoUrl: "/api/v1/system/providers/codex/logo",
        icon: undefined,
      },
      {
        id: "claude-code",
        logoUrl: "/api/v1/system/providers/claude-code/logo",
        icon: undefined,
      },
      {
        id: "pi",
        logoUrl: "/api/v1/system/providers/pi/logo",
        icon: undefined,
      },
      {
        id: "acp-cursor",
        logoUrl: "/api/v1/system/providers/acp-cursor/logo",
        icon: undefined,
      },
      {
        id: "acp-opencode",
        logoUrl: "/api/v1/system/providers/acp-opencode/logo",
        icon: undefined,
      },
      {
        id: "acp-omp",
        logoUrl: "/api/v1/system/providers/acp-omp/logo",
        icon: undefined,
      },
      {
        id: "acp-grok",
        logoUrl: "/api/v1/system/providers/acp-grok/logo",
        icon: undefined,
      },
      {
        id: "acp-hermes-agent",
        logoUrl: "/api/v1/system/providers/acp-hermes-agent/logo",
        icon: undefined,
      },
    ]);
  });
});

function standardSchema() {
  return {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  };
}
