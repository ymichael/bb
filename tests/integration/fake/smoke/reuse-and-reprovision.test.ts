import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { environments } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  archiveThread,
  createHostThread,
  getEnvironment,
  getThreadEvents,
  getThreadOutput,
  sendTextMessage,
  unarchiveThread,
} from "../../helpers/api.js";
import {
  waitForCommand,
  waitForCommandsDrained,
  waitForPathRemoval,
  waitForThreadStatus,
} from "../../helpers/assertions.js";
import { createReadyReuseThread } from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import {
  countProvisionCommands,
  createProjectFixture,
  createReadyThread,
  DEFAULT_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./shared.js";

describe.sequential("fake provider smoke reuse integration", () => {
  it("moves a thread to error and records failure events when environment provisioning fails", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Provision Failure Smoke");
      const missingPath = path.join(
        path.dirname(harness.repoDir),
        `missing-provision-${randomUUID()}`,
      );
      await fs.rm(missingPath, { recursive: true, force: true });

      const thread = await createHostThread(harness.api, {
        hostId: harness.hostId,
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: missingPath,
        },
      });
      const erroredThread = await waitForThreadStatus(
        harness.api,
        thread.id,
        "error",
        TURN_TIMEOUT_MS,
      );
      const environmentId = erroredThread.environmentId;
      if (!environmentId) {
        throw new Error("Provisioning thread was missing an environment");
      }

      const environment = await getEnvironment(harness.api, environmentId);
      const events = await getThreadEvents(harness.api, thread.id);
      expect(environment.status).toBe("error");
      expect(
        events.some(
          (event) =>
            event.type === "system/thread-provisioning" &&
            event.data.status === "failed",
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "system/error" &&
            event.data.code === "thread_provisioning_failed",
        ),
      ).toBe(true);
    }));

  it("reuses the same unmanaged environment when two host threads target the same path", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Implicit Reuse Smoke");
      const firstThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const provisionCountBeforeSecondThread = countProvisionCommands(harness);

      const secondThread = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      expect(secondThread.thread.environmentId).toBe(firstThread.thread.environmentId);
      expect(secondThread.environment.id).toBe(firstThread.environment.id);
      expect(countProvisionCommands(harness)).toBe(provisionCountBeforeSecondThread);
    }));

  it("creates a reuse thread without provisioning a second environment", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Reuse Smoke");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });

      const provisionCountBefore = countProvisionCommands(harness);

      const reusedThread = await createReadyReuseThread(harness, {
        environmentId: environment.id,
        projectId: project.id,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      expect(reusedThread.thread.environmentId).toBe(thread.environmentId);
      expect(reusedThread.thread.status).toBe("idle");

      const provisionCountAfter = countProvisionCommands(harness);
      expect(provisionCountAfter).toBe(provisionCountBefore);

      await sendTextMessage(harness.api, reusedThread.thread.id, {
        text: "reuse environment",
      });
      await waitForThreadStatus(
        harness.api,
        reusedThread.thread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );

      const output = await getThreadOutput(harness.api, reusedThread.thread.id);
      const reusedEnvironment = await getEnvironment(harness.api, environment.id);
      expect(reusedEnvironment.id).toBe(environment.id);
      expect(output).toContain("reuse environment");
    }));

  it("returns 409 when a second send tries to reprovision while managed reprovision is already in progress", () =>
    withHarness(async (harness) => {
      await fs.writeFile(
        path.join(harness.repoDir, ".bb-env-setup.sh"),
        "#!/bin/sh\nsleep 2\n",
        "utf8",
      );
      const project = await createProjectFixture(harness, "Managed Reprovision Conflict");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: { type: "managed-worktree" },
      });
      const originalWorkspacePath = environment.path;
      if (!originalWorkspacePath) {
        throw new Error("Managed worktree path was not assigned");
      }

      await archiveThread(harness.api, thread.id);
      await waitForCommand(
        harness.db,
        (command) =>
          command.type === "environment.destroy" &&
          command.command.type === "environment.destroy" &&
          command.command.environmentId === environment.id,
        DEFAULT_TIMEOUT_MS,
      );
      await waitForCommandsDrained(harness.db, harness.hostId, DEFAULT_TIMEOUT_MS);
      await waitForPathRemoval(originalWorkspacePath, DEFAULT_TIMEOUT_MS);

      await unarchiveThread(harness.api, thread.id);
      const provisionCountBefore = countProvisionCommands(harness);
      const firstSendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "start reprovision" }],
          mode: "auto",
        },
      });
      expect(firstSendResponse.status).toBe(200);
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore + 1);

      const secondSendResponse = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "duplicate reprovision" }],
          mode: "auto",
        },
      });
      expect(secondSendResponse.status).toBe(409);
      await expect(secondSendResponse.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore + 1);

      const reloadingEnvironment = await getEnvironment(harness.api, environment.id);
      expect(reloadingEnvironment.status).toBe("provisioning");
    }));

  it("rejects reprovision attempts for unmanaged environments", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Unmanaged Reprovision Rejected");
      const { environment, thread } = await createReadyThread(harness, {
        projectId: project.id,
        workspace: {
          type: "unmanaged",
          path: harness.repoDir,
        },
      });
      const provisionCountBefore = countProvisionCommands(harness);

      harness.db
        .update(environments)
        .set({
          path: null,
          status: "error",
          updatedAt: Date.now(),
        })
        .where(eq(environments.id, environment.id))
        .run();

      const response = await harness.api.threads[":id"].send.$post({
        param: { id: thread.id },
        json: {
          input: [{ type: "text", text: "try unmanaged reprovision" }],
          mode: "auto",
        },
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(countProvisionCommands(harness)).toBe(provisionCountBefore);
    }));
});
