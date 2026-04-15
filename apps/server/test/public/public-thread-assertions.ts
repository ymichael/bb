import {
  getEnvironment,
  getThread,
} from "@bb/db";
import { expect } from "vitest";
import type { createTestAppHarness } from "../helpers/test-app.js";

type AssertionFn = () => void;

export async function waitForAssertion(assertion: AssertionFn): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastMessage = "Condition not met";

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "Condition not met";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw new Error(lastMessage);
}

export async function waitForThreadEnvironment(
  harness: Awaited<ReturnType<typeof createTestAppHarness>>,
  threadId: string,
) {
  let environmentId: string | null = null;
  await waitForAssertion(() => {
    const thread = getThread(harness.db, threadId);
    environmentId = thread?.environmentId ?? null;
    expect(environmentId).toMatch(/^env_/u);
  });
  if (!environmentId) {
    throw new Error("Expected thread environment id to be set");
  }
  const environment = getEnvironment(harness.db, environmentId);
  if (!environment) {
    throw new Error("Expected thread environment to exist");
  }
  return environment;
}
