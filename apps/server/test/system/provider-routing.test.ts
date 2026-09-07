import { updateHost } from "@bb/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import {
  systemExecutionOptionsResponseSchema,
  systemProviderInfoSchema,
} from "@bb/server-contract";
import { availableModelFixture } from "../helpers/available-models.js";
import { readJson } from "../helpers/json.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function providerHostResponse(
  request: HostDaemonOnlineRpcRequestMessage,
  installedProviderId: string,
  modelId: string,
) {
  if (request.command.type === "provider.list_models") {
    return {
      ok: true as const,
      result: {
        models: [availableModelFixture({ model: modelId })],
        selectedOnlyModels: [],
      },
    };
  }
  if (request.command.type === "provider.health") {
    return {
      ok: true as const,
      result: {
        supported: true as const,
        health: {
          status:
            request.command.providerId === installedProviderId
              ? ("ready" as const)
              : ("not_installed" as const),
          statusMessage: null,
          accountEmail: null,
          planLabel: null,
          installedVersion: null,
          minimumSupportedVersion: null,
          canInstall: false,
          canUpdate: false,
          loginCommand: null,
        },
      },
    };
  }
  throw new Error(`Unexpected RPC command ${request.command.type}`);
}

async function providerIds(response: Response): Promise<string[]> {
  const body = systemProviderInfoSchema.array().parse(await readJson(response));
  return body.map((provider) => provider.id);
}

describe("system provider host routing", () => {
  it("separates provider discovery by explicit host and environment host while preserving primary fallback", async () => {
    await withTestHarness({}, async (harness) => {
      const primary = seedHostSession(harness.deps, {
        id: "host-provider-primary",
      });
      const remote = seedHostSession(harness.deps, {
        id: "host-provider-remote",
      });
      const remoteModelCommands: Extract<
        HostDaemonOnlineRpcRequestMessage["command"],
        { type: "provider.list_models" }
      >[] = [];
      seedPrimaryHost(harness.deps, primary.host.id);

      registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: (request) =>
          providerHostResponse(request, "acp-opencode", "primary-model"),
      });
      registerHostRpcResponder(harness, {
        hostId: remote.host.id,
        sessionId: remote.session.id,
        handle: (request) => {
          if (request.command.type === "provider.list_models") {
            remoteModelCommands.push(request.command);
          }
          return providerHostResponse(request, "acp-omp", "remote-model");
        },
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: remote.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: remote.host.id,
        projectId: project.id,
      });

      const primaryIds = await providerIds(
        await harness.app.request("/api/v1/system/providers"),
      );
      expect(primaryIds).toContain("acp-opencode");
      expect(primaryIds).not.toContain("acp-omp");

      const explicitRemoteIds = await providerIds(
        await harness.app.request(
          `/api/v1/system/providers?hostId=${remote.host.id}`,
        ),
      );
      expect(explicitRemoteIds).toContain("acp-omp");
      expect(explicitRemoteIds).not.toContain("acp-opencode");

      const environmentIds = await providerIds(
        await harness.app.request(
          `/api/v1/system/providers?environmentId=${environment.id}`,
        ),
      );
      expect(environmentIds).toContain("acp-omp");
      expect(environmentIds).not.toContain("acp-opencode");

      const primaryModels = systemExecutionOptionsResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/system/execution-options?providerId=codex",
          ),
        ),
      );
      expect(primaryModels.models.map((model) => model.model)).toEqual([
        "primary-model",
      ]);

      const explicitModels = systemExecutionOptionsResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/system/execution-options?hostId=${remote.host.id}&providerId=codex`,
          ),
        ),
      );
      expect(explicitModels.models.map((model) => model.model)).toEqual([
        "remote-model",
      ]);

      const environmentModels = systemExecutionOptionsResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/system/execution-options?environmentId=${environment.id}&providerId=codex`,
          ),
        ),
      );
      expect(environmentModels.models.map((model) => model.model)).toEqual([
        "remote-model",
      ]);
      expect(
        remoteModelCommands.map(({ bridgeLaunch: _ignored, ...rest }) => rest),
      ).toEqual([{ type: "provider.list_models", providerId: "codex" }]);
    });
  });

  it("reports the routed machine's permission ceiling", async () => {
    await withTestHarness({}, async (harness) => {
      const primary = seedHostSession(harness.deps, {
        id: "host-ceiling-primary",
      });
      const capped = seedHostSession(harness.deps, {
        id: "host-ceiling-capped",
      });
      seedPrimaryHost(harness.deps, primary.host.id);
      updateHost(harness.db, harness.hub, capped.host.id, {
        maxPermissionMode: "accept-edits",
      });
      for (const target of [primary, capped]) {
        registerHostRpcResponder(harness, {
          hostId: target.host.id,
          sessionId: target.session.id,
          handle: (request) =>
            providerHostResponse(request, "acp-opencode", "model"),
        });
      }

      const uncapped = systemExecutionOptionsResponseSchema.parse(
        await readJson(
          await harness.app.request(
            "/api/v1/system/execution-options?providerId=codex",
          ),
        ),
      );
      expect(uncapped.permissionCeiling).toBe("full");

      const cappedOptions = systemExecutionOptionsResponseSchema.parse(
        await readJson(
          await harness.app.request(
            `/api/v1/system/execution-options?hostId=${capped.host.id}&providerId=codex`,
          ),
        ),
      );
      expect(cappedOptions.permissionCeiling).toBe("accept-edits");
    });
  });

  it.each(["providers", "execution-options"])(
    "rejects simultaneous host and environment selectors for %s",
    async (route) => {
      await withTestHarness({}, async (harness) => {
        const response = await harness.app.request(
          `/api/v1/system/${route}?hostId=host-one&environmentId=env-one`,
        );
        expect(response.status).toBe(400);
        expect(await readJson(response)).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining(
            "hostId and environmentId are mutually exclusive",
          ),
        });
      });
    },
  );
});

describe("GET /api/v1/system/providers", () => {
  it("serves the maintenance facts under `maintenance` and no alias key", async () => {
    await withTestHarness({}, async (harness) => {
      const primary = seedHostSession(harness.deps, {
        id: "host-provider-shape-primary",
      });
      seedPrimaryHost(harness.deps, primary.host.id);
      registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: (request) =>
          providerHostResponse(request, "acp-opencode", "model"),
      });

      const response = await harness.app.request("/api/v1/system/providers");
      expect(response.status).toBe(200);
      const raw = await readJson(response);

      const rows = z.array(z.record(z.string(), z.unknown())).parse(raw);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          Object.keys(row).filter((key) =>
            key.startsWith("experimental_provider"),
          ),
        ).toEqual([]);
      }
      for (const provider of systemProviderInfoSchema.array().parse(raw)) {
        expect(provider.maintenance).toEqual({
          health: expect.any(Boolean),
          usage: expect.any(Boolean),
          installation: expect.any(Boolean),
        });
      }
    });
  });
});
