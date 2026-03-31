import { getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "./helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

describe("internal event envelope threadId regression", () => {
  it("uses the validated envelope threadId for side effects instead of the nested event threadId", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostA = seedHostSession(harness.deps, { id: "host-envelope-a" });
      const hostB = seedHostSession(harness.deps, { id: "host-envelope-b" });
      const { project: projectA } = seedProjectWithSource(harness.deps, {
        hostId: hostA.host.id,
      });
      const { project: projectB } = seedProjectWithSource(harness.deps, {
        hostId: hostB.host.id,
      });
      const environmentA = seedEnvironment(harness.deps, {
        hostId: hostA.host.id,
        projectId: projectA.id,
      });
      const environmentB = seedEnvironment(harness.deps, {
        hostId: hostB.host.id,
        projectId: projectB.id,
      });
      const threadA = seedThread(harness.deps, {
        projectId: projectA.id,
        environmentId: environmentA.id,
        title: "Owned thread",
        titleFallback: "Owned thread",
      });
      const threadB = seedThread(harness.deps, {
        projectId: projectB.id,
        environmentId: environmentB.id,
        title: "Foreign thread",
        titleFallback: "Foreign thread",
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: hostA.session.id,
          events: [
            {
              environmentId: environmentA.id,
              threadId: threadA.id,
              sequence: 1,
              createdAt: Date.now(),
              event: {
                type: "thread/name/updated",
                threadId: threadB.id,
                providerThreadId: "provider-envelope",
                threadName: "hacked",
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(getThread(harness.db, threadA.id)?.title).toBe("hacked");
      expect(getThread(harness.db, threadB.id)?.title).toBe("Foreign thread");
    } finally {
      await harness.cleanup();
    }
  });
});
