import {
  HOST_DAEMON_PROTOCOL_VERSION,
  createHostDaemonClient,
} from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { getHost, upsertHost } from "@bb/db";
import {
  createTestDaemonHostKey,
  startTestServer,
} from "../helpers/test-app.js";

describe("internal session protocol version", () => {
  it("rejects a session open whose protocol version does not match the server", async () => {
    const server = await startTestServer();
    try {
      const hostKey = createTestDaemonHostKey({ hostId: "host-protocol" });
      upsertHost(server.db, server.hub, {
        id: "host-protocol",
        name: "Protocol Host",
        type: "persistent",
      });
      const daemonClient = createHostDaemonClient(server.baseUrl, hostKey);
      const staleProtocolVersion = HOST_DAEMON_PROTOCOL_VERSION - 1;

      const preLocalApiPortProtocolVersion = 139;
      const oldDaemonResponse = await fetch(
        `${server.baseUrl}/internal/session/open`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${hostKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId: "host-protocol",
            instanceId: "instance-pre-local-api-port",
            hostName: "Protocol Host",
            hostType: "persistent",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-protocol-data",
            protocolVersion: preLocalApiPortProtocolVersion,
            activeThreads: [],
            loadedEnvironments: [],
          }),
        },
      );
      expect(oldDaemonResponse.status).toBe(400);
      expect(await oldDaemonResponse.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: false,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        message: `Daemon protocol version ${preLocalApiPortProtocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
      });
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBe(preLocalApiPortProtocolVersion);

      const response = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-1",
          hostName: "Protocol Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
          loadedEnvironments: [],
        },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "protocol_version_mismatch",
        details: {
          retryUpdate: false,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        message: `Daemon protocol version ${staleProtocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
      });
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBe(staleProtocolVersion);
      await expect(
        fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
          result.json(),
        ),
      ).resolves.toMatchObject({
        lastRejectedProtocolVersion: staleProtocolVersion,
      });

      server.hub.requestHostProtocolUpdateRetry("host-protocol");
      const forcedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry",
          hostName: "Protocol Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
          loadedEnvironments: [],
        },
      });
      expect(await forcedRetry.json()).toMatchObject({
        details: { retryUpdate: true },
      });

      const consumedRetry = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-retry-consumed",
          hostName: "Protocol Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: staleProtocolVersion,
          activeThreads: [],
          loadedEnvironments: [],
        },
      });
      expect(await consumedRetry.json()).toMatchObject({
        details: { retryUpdate: false },
      });

      const accepted = await daemonClient.session.open.$post({
        json: {
          hostId: "host-protocol",
          instanceId: "instance-2",
          hostName: "Protocol Host",
          hostType: "persistent",
          hasMachineCredential: false,
          platform: "darwin",
          dataDir: "/tmp/host-protocol-data",
          localApiPort: 38_888,
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [],
          loadedEnvironments: [],
        },
      });
      expect(accepted.status).toBe(201);
      expect(
        getHost(server.db, "host-protocol")?.lastRejectedProtocolVersion,
      ).toBeNull();
      await expect(
        fetch(`${server.baseUrl}/api/v1/hosts/host-protocol`).then((result) =>
          result.json(),
        ),
      ).resolves.toMatchObject({ lastRejectedProtocolVersion: null });
    } finally {
      await server.close();
    }
  });
});
