import type { JsonValue } from "@bb/domain";
import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { ExperimentalNativeRootsResolveAnswer } from "@get-bb/plugin-sdk/host";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS } from "../../../src/constants.js";
import { ApiError } from "../../../src/errors.js";
import {
  PROVIDER_LISTING_BUDGET_FLOOR_MS,
  PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS,
  createProviderListingBudget,
  resolveProviderNativeRootSet,
} from "../../../src/services/providers/native-roots.js";
import type { ProviderRegistration } from "../../../src/services/providers/provider-registry.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../../helpers/host-rpc.js";
import { stubHostArtifact } from "../../helpers/provider-registry.js";
import { seedHostSession } from "../../helpers/seed.js";
import {
  testLogger,
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const PLUGIN_ID = "provider-resolving";

function declaration(
  id: string,
  overrides: Partial<PluginProviderDeclaration> = {},
): PluginProviderDeclaration {
  return {
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
    ...overrides,
  };
}

const RESOLVING = {
  pluginId: PLUGIN_ID,
  declaration: declaration("resolving", {
    experimental_nativeSkillRoots: { project: [".resolving/skills"] },
    experimental_resolvesNativeRoots: true,
  }),
};

const USER_SKILLS = {
  path: "/home/me/.resolving/skills",
  origin: "user",
  recursive: false,
  ancestors: false,
  namePrefix: "",
  shape: "skills",
} as const;

interface ResolverStub {
  calls: HostDaemonOnlineRpcRequestMessage[];
  answer: ExperimentalNativeRootsResolveAnswer | Error | { raw: JsonValue };
  holdUntil: Promise<void> | null;
}

function registerResolverHost(
  harness: TestAppHarness,
  hostId: string,
): ResolverStub {
  const { host, session } = seedHostSession(harness.deps, { id: hostId });
  const stub: ResolverStub = {
    calls: [],
    answer: { skills: [{ path: USER_SKILLS.path, origin: "user" }] },
    holdUntil: null,
  };
  const answer = (): HostRpcHandlerResult => {
    if (stub.answer instanceof Error) throw stub.answer;
    if ("raw" in stub.answer) {
      return { ok: true, result: { output: stub.answer.raw } };
    }
    return { ok: true, result: { output: stub.answer } };
  };
  registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: (request) => {
      if (
        request.command.type !== "plugin.host.call" ||
        request.command.method !== "resolveNativeRoots"
      ) {
        throw new Error(`Unexpected RPC ${request.command.type}`);
      }
      stub.calls.push(request);
      return stub.holdUntil === null ? answer() : stub.holdUntil.then(answer);
    },
  });
  return stub;
}

function registration(
  harness: TestAppHarness,
  id: string,
): ProviderRegistration {
  const found = harness.deps.providerRegistry.get(id);
  if (found === null) throw new Error(`provider ${id} not registered`);
  return found;
}

describe("resolveProviderNativeRootSet", () => {
  it("asks the plugin on the workspace host once per (host, cwd) within the TTL", async () => {
    let clock = 1_000;
    await withTestHarness(
      { extraProviders: [RESOLVING], nativeRootsClock: () => clock },
      async (harness) => {
        harness.deps.pluginHostArtifacts.set(
          PLUGIN_ID,
          stubHostArtifact(PLUGIN_ID),
        );
        const stubA = registerResolverHost(harness, "host-a");
        const stubB = registerResolverHost(harness, "host-b");
        const reg = registration(harness, "resolving");

        const first = await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: 4_500,
        });
        expect(first).toEqual({
          skills: {
            user: [],
            project: [
              {
                path: ".resolving/skills",
                recursive: false,
                ancestors: false,
                namePrefix: "",
              },
            ],
          },
          commands: { user: [], project: [] },
          resolved: { skills: [USER_SKILLS], commands: [] },
        });
        expect(stubA.calls.map((call) => call.command)).toEqual([
          expect.objectContaining({
            pluginId: PLUGIN_ID,
            method: "resolveNativeRoots",
            input: { providerId: "resolving", cwd: "/work/one" },
            timeoutMs: 4_500,
          }),
        ]);

        clock += PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS - 1;
        await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(stubA.calls).toHaveLength(1);

        await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: "/work/two",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: null,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-b",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(stubA.calls.map((call) => call.command)).toEqual([
          expect.objectContaining({
            input: { providerId: "resolving", cwd: "/work/one" },
          }),
          expect.objectContaining({
            input: { providerId: "resolving", cwd: "/work/two" },
          }),
          expect.objectContaining({
            input: { providerId: "resolving", cwd: null },
          }),
        ]);
        expect(stubB.calls).toHaveLength(1);

        clock += 2;
        await resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(stubA.calls).toHaveLength(4);
      },
    );
  });

  it("keeps a slow answer for a full window after it lands, not after the call started", async () => {
    let clock = 1_000;
    await withTestHarness(
      { extraProviders: [RESOLVING], nativeRootsClock: () => clock },
      async (harness) => {
        harness.deps.pluginHostArtifacts.set(
          PLUGIN_ID,
          stubHostArtifact(PLUGIN_ID),
        );
        const stub = registerResolverHost(harness, "host-a");
        const reg = registration(harness, "resolving");
        const resolve = () =>
          resolveProviderNativeRootSet(harness.deps, {
            registration: reg,
            hostId: "host-a",
            cwd: "/work/one",
            timeoutMs: COMMAND_TIMEOUT_MS,
          });
        let land = (): void => {};
        stub.holdUntil = new Promise<void>((settle) => {
          land = settle;
        });

        const slow = resolve();
        clock += PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS + 2_000;
        land();
        await expect(slow).resolves.toMatchObject({
          resolved: { skills: [USER_SKILLS] },
        });
        expect(stub.calls).toHaveLength(1);
        const landedAt = clock;

        stub.holdUntil = null;
        clock = landedAt + 1_000;
        await expect(resolve()).resolves.toMatchObject({
          resolved: { skills: [USER_SKILLS] },
        });
        expect(stub.calls).toHaveLength(1);

        clock = landedAt + PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS - 1;
        await resolve();
        expect(stub.calls).toHaveLength(1);
        clock = landedAt + PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS;
        await resolve();
        expect(stub.calls).toHaveLength(2);
      },
    );
  });

  it("shares one in-flight call between concurrent listings", async () => {
    await withTestHarness({ extraProviders: [RESOLVING] }, async (harness) => {
      harness.deps.pluginHostArtifacts.set(
        PLUGIN_ID,
        stubHostArtifact(PLUGIN_ID),
      );
      const stub = registerResolverHost(harness, "host-a");
      const reg = registration(harness, "resolving");

      const results = await Promise.all(
        [0, 1, 2].map(() =>
          resolveProviderNativeRootSet(harness.deps, {
            registration: reg,
            hostId: "host-a",
            cwd: "/work/one",
            timeoutMs: COMMAND_TIMEOUT_MS,
          }),
        ),
      );

      expect(stub.calls).toHaveLength(1);
      for (const result of results) {
        expect(result.resolved.skills).toEqual([USER_SKILLS]);
      }
    });
  });

  it("re-asks after the plugin's settings change and after the registration set changes", async () => {
    await withTestHarness({ extraProviders: [RESOLVING] }, async (harness) => {
      harness.deps.pluginHostArtifacts.set(
        PLUGIN_ID,
        stubHostArtifact(PLUGIN_ID),
      );
      const stub = registerResolverHost(harness, "host-a");
      const reg = registration(harness, "resolving");
      const resolve = () =>
        resolveProviderNativeRootSet(harness.deps, {
          registration: reg,
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });

      await resolve();
      expect(stub.calls).toHaveLength(1);

      harness.deps.providerNativeRoots.invalidate("some-other-plugin");
      await resolve();
      expect(stub.calls).toHaveLength(1);

      harness.deps.providerNativeRoots.invalidate(PLUGIN_ID);
      await resolve();
      expect(stub.calls).toHaveLength(2);

      const other = harness.deps.providerRegistry.register({
        ...reg,
        info: { ...reg.info, id: "resolving-twin" },
        pluginId: PLUGIN_ID,
      });
      await resolve();
      expect(stub.calls).toHaveLength(3);
      other.dispose();
      await resolve();
      expect(stub.calls).toHaveLength(4);
      await resolve();
      expect(stub.calls).toHaveLength(4);
    });
  });

  it("yields no resolved roots, and warns once per window, when the plugin cannot answer", async () => {
    let clock = 1_000;
    await withTestHarness(
      { extraProviders: [RESOLVING], nativeRootsClock: () => clock },
      async (harness) => {
        harness.deps.pluginHostArtifacts.set(
          PLUGIN_ID,
          stubHostArtifact(PLUGIN_ID),
        );
        const stub = registerResolverHost(harness, "host-a");
        const reg = registration(harness, "resolving");
        const warn = vi.fn();
        const deps = { ...harness.deps, logger: { ...testLogger, warn } };
        const resolve = (cwd: string) =>
          resolveProviderNativeRootSet(deps, {
            registration: reg,
            hostId: "host-a",
            cwd,
            timeoutMs: COMMAND_TIMEOUT_MS,
          });

        stub.answer = new Error("plugin.json is not valid JSON");
        const failed = await resolve("/work/throws");
        expect(failed.resolved).toEqual({ skills: [], commands: [] });
        expect(failed.skills.project).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatchObject({
          pluginId: PLUGIN_ID,
          providerId: "resolving",
          hostId: "host-a",
          cwd: "/work/throws",
        });
        expect(warn.mock.calls[0]?.[1]).toContain(PLUGIN_ID);
        expect(warn.mock.calls[0]?.[1]).toContain("resolving");

        await resolve("/work/throws");
        expect(stub.calls).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(1);
        clock += PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS + 1;
        await resolve("/work/throws");
        expect(stub.calls).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(2);

        stub.answer = {
          raw: {
            skills: [
              { path: "relative/skills", origin: "user", ancestors: true },
            ],
          },
        };
        const malformed = await resolve("/work/malformed");
        expect(malformed.resolved).toEqual({ skills: [], commands: [] });
        expect(warn).toHaveBeenCalledTimes(3);
      },
    );
  });

  it("does not call a host when the plugin has no live artifact or does not resolve roots", async () => {
    const declared = {
      pluginId: "provider-declared",
      declaration: declaration("declared", {
        experimental_nativeSkillRoots: { user: [".declared/skills"] },
      }),
    };
    await withTestHarness(
      { extraProviders: [RESOLVING, declared] },
      async (harness) => {
        const stub = registerResolverHost(harness, "host-a");
        const warn = vi.fn();
        const deps = { ...harness.deps, logger: { ...testLogger, warn } };

        const withoutArtifact = await resolveProviderNativeRootSet(deps, {
          registration: registration(harness, "resolving"),
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(withoutArtifact.resolved).toEqual({ skills: [], commands: [] });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toContain("no live bb.host artifact");

        const declaredOnly = await resolveProviderNativeRootSet(deps, {
          registration: registration(harness, "declared"),
          hostId: "host-a",
          cwd: "/work/one",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expect(declaredOnly).toEqual({
          skills: {
            user: [
              {
                path: ".declared/skills",
                recursive: false,
                ancestors: false,
                namePrefix: "",
              },
            ],
            project: [],
          },
          commands: { user: [], project: [] },
          resolved: { skills: [], commands: [] },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(stub.calls).toEqual([]);
      },
    );
  });
});

describe("createProviderListingBudget", () => {
  it("hands each step what is left and times out under the floor", () => {
    let clock = 5_000;
    const budget = createProviderListingBudget({
      totalMs: 30_000,
      now: () => clock,
    });
    expect(budget.remainingMs()).toBe(30_000);

    clock += 25_000;
    expect(budget.remainingMs()).toBe(5_000);

    clock = 5_000 + 30_000 - PROVIDER_LISTING_BUDGET_FLOOR_MS;
    expect(budget.remainingMs()).toBe(PROVIDER_LISTING_BUDGET_FLOOR_MS);
    clock += 1;
    let thrown: unknown;
    try {
      budget.remainingMs();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      status: 504,
      body: { code: "command_timeout" },
    });
  });

  it("spends one command timeout by default", () => {
    let clock = 0;
    const budget = createProviderListingBudget({ now: () => clock });
    expect(budget.remainingMs()).toBe(COMMAND_TIMEOUT_MS);
    clock = COMMAND_TIMEOUT_MS;
    expect(() => budget.remainingMs()).toThrow(ApiError);
  });
});
