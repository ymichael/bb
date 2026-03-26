import { getThread } from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("internal reconciliation idle-active regression", () => {
  it("promotes idle threads to active when the daemon reports them as active", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-idle-active-reconcile",
      });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });

      const response = await harness.app.request("/internal/session/open", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          hostId: host.id,
          instanceId: "instance-idle-active-reconcile",
          hostName: "Idle Active Host",
          hostType: "persistent",
          protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          activeThreads: [
            {
              environmentId: environment.id,
              providerThreadId: "provider-idle-active",
              threadId: thread.id,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    } finally {
      await harness.cleanup();
    }
  });
});
