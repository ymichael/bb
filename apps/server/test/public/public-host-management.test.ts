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
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";

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
            hostType: "persistent",
          }),
        },
      );

      expect(enrollResponse.status).toBe(201);
      const enrolled = (await readJson(enrollResponse)) as { hostKey: string };
      expect(getHost(harness.db, issued.hostId)).toMatchObject({
        connectMachineId: "machine-cloud-1",
        name: "Build Machine",
        type: "persistent",
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
            hostType: "persistent",
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
          hostType: "persistent",
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
        hostType: "persistent",
      });
      const enrollKey = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "loopback",
        hostId: host.id,
        hostType: "persistent",
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
            hostType: "persistent",
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
