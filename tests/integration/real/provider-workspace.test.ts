import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getEnvironment,
  getEnvironmentBranches,
  getEnvironmentDiff,
  getEnvironmentStatus,
  getThreadOutput,
  sendTextMessage,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";
import {
  createRealThread,
  expectNonEmptyOutput,
  pathExists,
  REAL_PROVIDER_IDS,
  resolveExecutionOptions,
  TEST_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./provider-smoke-harness.js";

describe("real provider workspace integration", () => {
  for (const providerId of REAL_PROVIDER_IDS) {
    it.concurrent(
      `${providerId} can interact with a managed workspace`,
      async () => {
        const { harness, environment, thread } = await createRealThread({
          providerId,
          workspace: {
            type: "managed-worktree",
          },
        });

        try {
          const execution = await resolveExecutionOptions({
            harness,
            providerId,
          });
          const initialStatus = await getEnvironmentStatus(
            harness.api,
            environment.id,
          );
          const branches = await getEnvironmentBranches(
            harness.api,
            environment.id,
          );
          expect(initialStatus.outcome).toBe("available");
          if (initialStatus.outcome !== "available") {
            throw new Error(
              `Expected initial workspace status, received ${initialStatus.outcome}`,
            );
          }
          expect(initialStatus.workspace.branch.currentBranch).toBeTruthy();
          expect(branches.branches.length).toBeGreaterThan(0);

          await sendTextMessage(harness.api, thread.id, {
            text: "Create a file named hello.txt in the workspace with the content hello world if tool use is available. Then briefly summarize what you did.",
            execution,
          });
          await waitForThreadStatus(
            harness.api,
            thread.id,
            "idle",
            TURN_TIMEOUT_MS,
          );

          const refreshedEnvironment = await getEnvironment(
            harness.api,
            environment.id,
          );
          const refreshedStatus = await getEnvironmentStatus(
            harness.api,
            environment.id,
          );
          const diff = await getEnvironmentDiff(harness.api, environment.id);
          expect(refreshedStatus.outcome).toBe("available");
          if (refreshedStatus.outcome !== "available") {
            throw new Error(
              `Expected refreshed workspace status, received ${refreshedStatus.outcome}`,
            );
          }
          expect(refreshedStatus.workspace.branch.currentBranch).toBeTruthy();
          expectNonEmptyOutput(
            await getThreadOutput(harness.api, thread.id),
            `${providerId} workspace output`,
          );
          expect(typeof diff.diff).toBe("string");

          if (refreshedEnvironment.path) {
            const helloPath = path.join(refreshedEnvironment.path, "hello.txt");
            if (await pathExists(helloPath)) {
              const helloContents = await fs.readFile(helloPath, "utf8");
              expect(helloContents.trim()).toBe("hello world");
            }
          }
        } finally {
          await harness.cleanup();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
