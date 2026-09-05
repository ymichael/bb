import {
  environments,
  getEnvironment,
  getThread,
  listEvents,
  threads,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { runStartupRecoverySweep } from "../../src/services/system/periodic-sweeps.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("environment reprovisioning", () => {
  it("fails host-backed thread creation before creating provisioning state when the host is disconnected", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, {
        id: "host-thread-create-offline",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-create-offline-project",
      });

      let thrownError: ApiError | null = null;
      try {
        await createThreadFromRequest(harness.deps, {
          startedOnBehalfOf: null,
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: null },
          },
          input: textInput("offline create"),
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
        });
      } catch (error) {
        if (error instanceof ApiError) {
          thrownError = error;
        } else {
          throw error;
        }
      }

      expect(thrownError).toMatchObject({
        body: {
          code: "host_unavailable",
          message: "Host is not connected",
        },
        status: 502,
      });
      expect(harness.db.select({ id: threads.id }).from(threads).all()).toEqual(
        [],
      );
      expect(
        harness.db.select({ id: environments.id }).from(environments).all(),
      ).toEqual([]);
    });
  });

  it("marks orphaned provisioning environments interrupted on startup recovery", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-orphaned-env-provision",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "provisioning",
        environmentProviderId: "personal-workspace",
        isGitRepo: false,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "starting",
      });
      await runStartupRecoverySweep(harness.deps);

      expect(getEnvironment(harness.db, environment.id)?.status).toBe("error");
      expect(getThread(harness.db, thread.id)).toMatchObject({
        status: "error",
      });
      expect(
        listEvents(harness.db, { threadId: thread.id }).map(
          (event) => event.type,
        ),
      ).toEqual(["system/thread-provisioning", "system/error"]);
    });
  });
});
