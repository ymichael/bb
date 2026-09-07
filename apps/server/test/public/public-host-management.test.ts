import {
  getEnvironment,
  getHost,
  getSessionById,
  getThread,
  updateHost,
} from "@bb/db";
import {
  createHostJoinCodeResponseSchema,
  type CreateHostJoinCodeResponse,
} from "@bb/server-contract";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonSessionOpenResponseSchema,
} from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PluginMachineProviderDeclaration } from "@get-bb/plugin-sdk";
import { validatePluginMachineProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { setPluginMachineProviderBridge } from "../../src/services/plugins/plugin-machine-provider-registry.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const API = "/api/v1";

function installMachineProvider(declaration: PluginMachineProviderDeclaration) {
  const record = {
    pluginId: "public-host-management-test",
    provider: validatePluginMachineProviderDeclaration(declaration),
  };
  setPluginMachineProviderBridge({
    listMachineProviders: () => [record],
    getMachineProvider: (id) =>
      id === record.provider.id ? record : undefined,
    invokeProvider: async (_pluginId, _label, run) => {
      try {
        return { ok: true as const, value: await run() };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    decisionTimeoutMs: 10_000,
  });
}

function adoptMachine(harness: TestAppHarness, hostId: string): void {
  updateHost(harness.db, harness.hub, hostId, {
    machineProviderId: "test-machine",
    machineProviderSelection: { inputs: null },
    phase: "active",
    resource: { machine: "test" },
  });
}

afterEach(() => {
  setPluginMachineProviderBridge(undefined);
});

async function createJoinCode(
  app: Parameters<typeof requestJoinCode>[0],
): Promise<CreateHostJoinCodeResponse> {
  const response = await requestJoinCode(app);
  expect(response.status).toBe(201);
  return createHostJoinCodeResponseSchema.parse(await readJson(response));
}

function requestJoinCode(app: {
  request: (path: string, init?: RequestInit) => Promise<Response> | Response;
}): Promise<Response> {
  return Promise.resolve(
    app.request(`${API}/hosts/join-codes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
}

describe("public host management", () => {
  it("publishes a machine provider without an icon as unbranded", async () => {
    await withTestHarness(async (harness) => {
      installMachineProvider({
        id: "plain-machine",
        displayName: "Plain machine",
        policy: {
          idleSuspendMs: null,
          retire: { after: "never" },
          removeRetryMs: 60_000,
        },
        create: async () => ({
          status: "created",
          hostId: "host-plain",
          resource: null,
        }),
        remove: async () => ({ status: "removed" }),
      });

      const response = await harness.app.request(
        "/api/v1/system/machine-providers",
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        providers: [
          {
            id: "plain-machine",
            icon: null,
            logoUrl: null,
            environmentRow: null,
          },
        ],
      });
    });
  });

  it("enrolls a host from a public join code", async () => {
    await withTestHarness(async (harness) => {
      const issued = await createJoinCode(harness.app);
      const response = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.joinCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: issued.hostId,
          hostName: "Modal abc1",
        }),
      });

      expect(response.status).toBe(201);
      expect(getHost(harness.db, issued.hostId)).toMatchObject({
        name: "Modal abc1",
      });
      const hostsResponse = await harness.app.request("/api/v1/hosts");
      expect(hostsResponse.status).toBe(200);
      expect(await readJson(hostsResponse)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: issued.hostId }),
        ]),
      );
    });
  });

  it("preserves a renamed host across a daemon reconnect", async () => {
    await withTestHarness(async (harness) => {
      const issued = await createJoinCode(harness.app);
      expect(issued.joinCode).toMatch(/^bbde_/u);
      expect(issued.expiresAt).toBeGreaterThan(Date.now());
      expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      expect(getHost(harness.db, issued.hostId)).toBeNull();

      const enrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issued.joinCode}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            connectMachineId: "machine-cloud-1",
            hostId: issued.hostId,
            hostName: "Build Machine",
          }),
        },
      );

      expect(enrollResponse.status).toBe(201);
      const enrolled = (await readJson(enrollResponse)) as { hostKey: string };
      expect(getHost(harness.db, issued.hostId)).toMatchObject({
        connectMachineId: "machine-cloud-1",
        name: "Build Machine",
      });

      const renameResponse = await harness.app.request(
        `${API}/hosts/${issued.hostId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "My Build Box" }),
        },
      );
      expect(renameResponse.status).toBe(200);
      expect(await readJson(renameResponse)).toMatchObject({
        id: issued.hostId,
        name: "My Build Box",
      });

      const sessionResponse = await harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${enrolled.hostKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            activeThreads: [],
            connectMachineId: "machine-cloud-2",
            dataDir: "/tmp/remote-bb",
            hasMachineCredential: true,
            hostId: issued.hostId,
            hostName: "Build Machine",
            instanceId: "instance-cloud-2",
            loadedEnvironments: [],
            localApiPort: 38_888,
            platform: "linux",
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          }),
        },
      );
      expect(sessionResponse.status).toBe(201);
      const openedSession = hostDaemonSessionOpenResponseSchema.parse(
        await readJson(sessionResponse),
      );
      expect(getHost(harness.db, issued.hostId)).toMatchObject({
        connectMachineId: "machine-cloud-2",
        name: "My Build Box",
      });
      expect(
        getSessionById(harness.db, { sessionId: openedSession.sessionId }),
      ).toMatchObject({ hostName: "Build Machine" });

      const publicHostResponse = await harness.app.request(
        `${API}/hosts/${issued.hostId}`,
      );
      expect(publicHostResponse.status).toBe(200);
      expect(await readJson(publicHostResponse)).toMatchObject({
        id: issued.hostId,
        name: "My Build Box",
      });
    });
  });

  it("rejects a forged connect machine id at enrollment", async () => {
    await withTestHarness(async (harness) => {
      const issued = await createJoinCode(harness.app);
      const response = await harness.app.request("/internal/hosts/enroll", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.joinCode}`,
          "content-type": "application/json",
          "x-bb-gate-auth": "machine",
          "x-bb-gate-machine-id": "machine-authenticated",
        },
        body: JSON.stringify({
          connectMachineId: "machine-forged",
          hostId: issued.hostId,
          hostName: "Forged Machine",
        }),
      });
      expect(response.status).toBe(403);
      expect(await readJson(response)).toMatchObject({
        code: "connect_machine_id_mismatch",
      });
      expect(getHost(harness.db, issued.hostId)).toBeNull();
    });
  });

  it("rejects machine-gated host-management mutations", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_machine_forbidden" });
      const requests = [
        harness.app.request(`${API}/hosts/join-codes`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bb-gate-auth": "machine",
          },
          body: JSON.stringify({}),
        }),
        harness.app.request(`${API}/hosts/${host.id}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-bb-gate-auth": "machine",
          },
          body: JSON.stringify({ name: "forbidden" }),
        }),
        harness.app.request(`${API}/hosts/${host.id}`, {
          method: "DELETE",
          headers: { "x-bb-gate-auth": "machine" },
        }),
        harness.app.request(`${API}/hosts/${host.id}/retry-update`, {
          method: "POST",
          headers: { "x-bb-gate-auth": "machine" },
        }),
        harness.app.request(`${API}/hosts/${host.id}/suspend`, {
          method: "POST",
          headers: { "x-bb-gate-auth": "machine" },
        }),
        harness.app.request(`${API}/hosts/${host.id}/resume`, {
          method: "POST",
          headers: { "x-bb-gate-auth": "machine" },
        }),
        harness.app.request(`${API}/hosts/${host.id}/retry-cleanup`, {
          method: "POST",
          headers: { "x-bb-gate-auth": "machine" },
        }),
        harness.app.request(`${API}/hosts/${host.id}/permission-ceiling`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-bb-gate-auth": "machine",
          },
          body: JSON.stringify({ maxPermissionMode: "full" }),
        }),
      ];
      for (const response of await Promise.all(requests)) {
        expect(response.status).toBe(403);
        expect(await readJson(response)).toMatchObject({
          code: "machine_host_management_forbidden",
        });
      }
      expect(getHost(harness.db, host.id)).toMatchObject({
        destroyedAt: null,
        maxPermissionMode: "full",
        name: host.name,
      });
    });
  });

  it("stores a permission ceiling for a session-gated request", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_ceiling" });
      expect(getHost(harness.db, host.id)?.maxPermissionMode).toBe("full");

      const response = await harness.app.request(
        `${API}/hosts/${host.id}/permission-ceiling`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-bb-gate-auth": "session",
          },
          body: JSON.stringify({ maxPermissionMode: "accept-edits" }),
        },
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        id: host.id,
        maxPermissionMode: "accept-edits",
      });
      expect(getHost(harness.db, host.id)?.maxPermissionMode).toBe(
        "accept-edits",
      );
    });
  });

  it("allows session-gated join-code minting", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(`${API}/hosts/join-codes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-gate-auth": "session",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(201);
    });
  });

  it("renames a host, broadcasts it, and rejects unknown or destroyed hosts", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_rename" });
      const notifyHost = vi.spyOn(harness.hub, "notifyHost");

      const response = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "  Renamed Machine  " }),
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        id: host.id,
        name: "Renamed Machine",
      });
      expect(getHost(harness.db, host.id)?.name).toBe("Renamed Machine");
      expect(notifyHost).toHaveBeenCalledWith(host.id, ["host-connected"]);

      const unknownResponse = await harness.app.request(
        `${API}/hosts/host_unknown`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Unknown" }),
        },
      );
      expect(unknownResponse.status).toBe(404);

      updateHost(harness.db, harness.hub, host.id, {
        destroyedAt: Date.now(),
      });
      const destroyedResponse = await harness.app.request(
        `${API}/hosts/${host.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Too Late" }),
        },
      );
      expect(destroyedResponse.status).toBe(404);
    });
  });

  it("queues a retry only for an older daemon awaiting an update", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_retry_update" });

      const notNeeded = await harness.app.request(
        `${API}/hosts/${host.id}/retry-update`,
        { method: "POST" },
      );
      expect(notNeeded.status).toBe(409);

      updateHost(harness.db, harness.hub, host.id, {
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
      });
      const response = await harness.app.request(
        `${API}/hosts/${host.id}/retry-update`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });
      expect(harness.hub.takeHostProtocolUpdateRetry(host.id)).toBe(true);
      expect(harness.hub.takeHostProtocolUpdateRetry(host.id)).toBe(false);

      updateHost(harness.db, harness.hub, host.id, {
        lastRejectedProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION + 1,
      });
      const newerDaemon = await harness.app.request(
        `${API}/hosts/${host.id}/retry-update`,
        { method: "POST" },
      );
      expect(newerDaemon.status).toBe(409);
      expect(await readJson(newerDaemon)).toMatchObject({
        code: "host_cannot_self_update",
      });
    });
  });

  it("routes suspend and resume through provider lifecycle orchestration", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_lifecycle_routes" });
      const operations: string[] = [];
      installMachineProvider({
        id: "test-machine",
        displayName: "Test machine",
        policy: {
          idleSuspendMs: null,
          retire: { after: "never" },
          removeRetryMs: 10,
        },
        create: async () => ({
          status: "created",
          hostId: host.id,
          resource: { machine: "test" },
        }),
        suspend: async ({ resource }) => {
          operations.push("suspend");
          return { resource };
        },
        resume: async ({ resource }) => {
          operations.push("resume");
          return { resource };
        },
        remove: async () => ({ status: "removed" }),
      });
      adoptMachine(harness, host.id);

      const suspend = await harness.app.request(
        `${API}/hosts/${host.id}/suspend`,
        { method: "POST" },
      );
      expect(suspend.status).toBe(200);
      expect(await readJson(suspend)).toEqual({ ok: true });
      expect(getHost(harness.db, host.id)?.phase).toBe("suspended");

      const resume = await harness.app.request(
        `${API}/hosts/${host.id}/resume`,
        { method: "POST" },
      );
      expect(resume.status).toBe(200);
      expect(await readJson(resume)).toEqual({ ok: true });
      expect(getHost(harness.db, host.id)?.phase).toBe("active");
      expect(operations).toEqual(["suspend", "resume"]);
    });
  });

  it("retries cleanup only after a provider teardown failure", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const host = seedHost(harness.deps, { id: "host_retry_cleanup" });
      let removes = 0;
      installMachineProvider({
        id: "test-machine",
        displayName: "Test machine",
        policy: {
          idleSuspendMs: null,
          retire: { after: "never" },
          removeRetryMs: 60_000,
        },
        create: async () => ({
          status: "created",
          hostId: host.id,
          resource: { machine: "test" },
        }),
        remove: async () => {
          removes += 1;
          return removes === 1
            ? { status: "failed", message: "temporary teardown failure" }
            : { status: "removed" };
        },
      });
      adoptMachine(harness, host.id);

      const beforeFailure = await harness.app.request(
        `${API}/hosts/${host.id}/retry-cleanup`,
        { method: "POST" },
      );
      expect(beforeFailure.status).toBe(409);
      expect(await readJson(beforeFailure)).toMatchObject({
        code: "machine_cleanup_not_failed",
      });

      const remove = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "DELETE",
      });
      expect(remove.status).toBe(200);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "retiring",
        teardownStatus: "failed",
      });

      const retry = await harness.app.request(
        `${API}/hosts/${host.id}/retry-cleanup`,
        { method: "POST" },
      );
      expect(retry.status).toBe(200);
      expect(await readJson(retry)).toEqual({ ok: true });
      expect(removes).toBe(2);
      expect(getHost(harness.db, host.id)).toMatchObject({
        phase: "destroyed",
        teardownStatus: "removed",
      });
    });
  });

  it("revokes host credentials, closes its live session, tombstones it, and preserves environments", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const host = seedHost(harness.deps, { id: "host_remove" });
      const session = seedSession(harness.deps, host.id);
      const socket = {
        close: vi.fn(),
        send: vi.fn(),
      };
      harness.hub.registerDaemon(session.id, host.id, socket);
      const project = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      }).project;
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const activeThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      const hostKey = await harness.deps.machineAuth.issueDaemonHostKey({
        hostId: host.id,
      });
      const enrollKey = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "loopback",
        hostId: host.id,
      });

      const response = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });
      await expect(
        harness.deps.machineAuth.verifyDaemonHostKey(hostKey),
      ).resolves.toBeNull();
      expect(harness.hub.hasDaemonForHost(host.id)).toBe(false);
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session-close", reason: "expired" }),
      );
      expect(socket.close).toHaveBeenCalledWith(1000, "expired");
      expect(
        getSessionById(harness.db, { sessionId: session.id }),
      ).toMatchObject({
        status: "closed",
        closeReason: "expired",
      });
      expect(getHost(harness.db, host.id)?.destroyedAt).not.toBeNull();
      expect(getEnvironment(harness.db, environment.id)).toMatchObject({
        id: environment.id,
        hostId: host.id,
      });
      expect(getThread(harness.db, activeThread.id)?.status).toBe("error");

      const staleEnrollResponse = await harness.app.request(
        "/internal/hosts/enroll",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${enrollKey.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: host.id,
            hostName: host.name,
          }),
        },
      );
      expect(staleEnrollResponse.status).toBe(401);

      const secondDelete = await harness.app.request(
        `${API}/hosts/${host.id}`,
        { method: "DELETE" },
      );
      expect(secondDelete.status).toBe(404);
    });
  });

  it("refuses to remove the primary host", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);

      const response = await harness.app.request(`${API}/hosts/${primary.id}`, {
        method: "DELETE",
      });

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "primary_host_removal_refused",
      });
      expect(getHost(harness.db, primary.id)?.destroyedAt).toBeNull();
    });
  });

  it("asks the connect plugin to revoke the removed host's cloud machine", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const host = seedHost(harness.deps, {
        connectMachineId: "machine-cloud-remove",
        id: "host_cloud_remove",
      });
      const connectPlugin = await harness.pluginService.install(
        "builtin:connect",
        { kind: "root" },
      );
      expect(connectPlugin).toMatchObject({
        source: "builtin:connect",
        status: "running",
      });
      const revokeHandler = vi.fn(async () => ({ ok: true }));
      const revokeRecord = {
        inputSchema: z.object({ machineId: z.string() }),
        outputSchema: z.object({ ok: z.literal(true) }),
        handler: revokeHandler,
      };
      vi.spyOn(harness.pluginService, "getRpcHandler").mockReturnValue({
        outcome: "found",
        value: revokeRecord,
      });
      const invoke = vi
        .spyOn(harness.pluginService, "invokeRpcHandler")
        .mockResolvedValue({ ok: true, result: { ok: true } });

      const response = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(invoke).toHaveBeenCalledWith(
        connectPlugin.id,
        "revokeMachine",
        revokeRecord,
        { machineId: "machine-cloud-remove" },
      );
    });
  }, 30_000);
});
