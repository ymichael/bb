import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("internal project attachment content", () => {
  it("returns attachment bytes to the daemon assigned to the thread environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-attachment-content",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const attachmentPath = "network-tab.har";
      await mkdir(join(harness.config.dataDir, "attachments", project.id), {
        recursive: true,
      });
      await writeFile(
        join(harness.config.dataDir, "attachments", project.id, attachmentPath),
        "har-content",
      );

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${session.id}&threadId=${thread.id}&projectId=${project.id}&path=${attachmentPath}`,
        {
          headers: internalAuthHeaders(harness, { hostId: host.id }),
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/octet-stream",
      );
      await expect(response.text()).resolves.toBe("har-content");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a daemon that is not assigned to the thread environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostA = seedHostSession(harness.deps, {
        id: "host-attachment-content-a",
      });
      const hostB = seedHostSession(harness.deps, {
        id: "host-attachment-content-b",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: hostA.host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: hostA.host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${hostB.session.id}&threadId=${thread.id}&projectId=${project.id}&path=network-tab.har`,
        {
          headers: internalAuthHeaders(harness, { hostId: hostB.host.id }),
        },
      );

      expect(response.status).toBe(403);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a project-scoped attachment token request for a mismatched project id", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-attachment-content-project-mismatch",
      });
      const { project: threadProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: threadProject.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: threadProject.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(
        `/internal/session/project-attachment-content?sessionId=${session.id}&threadId=${thread.id}&projectId=proj_missing_attachment_content&path=network-tab.har`,
        {
          headers: internalAuthHeaders(harness, { hostId: host.id }),
        },
      );

      expect(response.status).toBe(403);
    } finally {
      await harness.cleanup();
    }
  });
});
