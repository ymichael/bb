import { setTimeout as sleep } from "node:timers/promises";
import type { ThreadEventRow } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  createReuseThread,
  getThreadEvents,
  updateThread,
} from "../../helpers/api.js";
import { waitForThreadStatus } from "../../helpers/assertions.js";
import { withHarness } from "../../helpers/harness.js";
import {
  createProjectFixture,
  createReadyThread,
  TURN_TIMEOUT_MS,
} from "./shared.js";

async function waitForThreadEventContaining(
  api: Parameters<typeof getThreadEvents>[0],
  threadId: string,
  text: string,
  timeoutMs: number,
): Promise<ThreadEventRow> {
  const deadline = Date.now() + timeoutMs;
  let seenTypes = "none";
  while (Date.now() < deadline) {
    const events = await getThreadEvents(api, threadId);
    const match = events.find((event) => JSON.stringify(event).includes(text));
    if (match) {
      return match;
    }
    seenTypes = events.map((event) => event.type).join(", ") || "none";
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${text} on thread ${threadId}; saw ${seenTypes}`,
  );
}

describe.sequential("fake provider hidden delegation integration", () => {
  it("hides a delegated child of a hidden parent and still notifies the parent", () =>
    withHarness(async (harness) => {
      const project = await createProjectFixture(harness, "Hidden Delegation");
      const { environment, thread: parentThread } = await createReadyThread(
        harness,
        {
          projectId: project.id,
          title: "Hidden coordinator",
          workspace: { type: "unmanaged", path: harness.repoDir },
        },
      );
      await waitForThreadStatus(
        harness.api,
        parentThread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );
      const hiddenParentThread = await updateThread(
        harness.api,
        parentThread.id,
        { visibility: "hidden" },
      );
      expect(hiddenParentThread.visibility).toBe("hidden");

      const childThread = await createReuseThread(harness.api, {
        environmentId: environment.id,
        parentThreadId: parentThread.id,
        projectId: project.id,
        title: "Hidden delegated worker",
      });

      expect(childThread.parentThreadId).toBe(parentThread.id);
      expect(childThread.visibility).toBe("hidden");

      await waitForThreadStatus(
        harness.api,
        childThread.id,
        "idle",
        TURN_TIMEOUT_MS,
      );
      await waitForThreadEventContaining(
        harness.api,
        parentThread.id,
        `@thread:${childThread.id}`,
        TURN_TIMEOUT_MS,
      );
    }));
});
