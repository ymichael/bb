import type { ThreadEventRow } from "@bb/domain";
import { expect } from "vitest";
import {
  createProjectFixture as createProjectFixtureForHarness,
  createReadyHostThread,
  type ProjectFixture,
  type ReadyHostThreadOptions,
  type ReadyThreadFixture,
} from "../../helpers/fixtures.js";
import type { IntegrationHarness } from "../../helpers/harness.js";
import { waitForEnvironmentStatus } from "../../helpers/assertions.js";
import { scaleTimeoutMs } from "../../helpers/time.js";

export const DEFAULT_TIMEOUT_MS = scaleTimeoutMs(10_000);
export const TURN_TIMEOUT_MS = scaleTimeoutMs(15_000);
export const ACTIVE_TURN_TIMEOUT_MS = scaleTimeoutMs(5_000);
export const STOP_DELAY_TEXT = "delay:5000 stop me";

export async function createProjectFixture(
  harness: IntegrationHarness,
  name: string,
): Promise<ProjectFixture> {
  return createProjectFixtureForHarness(harness, { name });
}

export async function createReadyThread(
  harness: IntegrationHarness,
  options: ReadyHostThreadOptions,
): Promise<ReadyThreadFixture> {
  return createReadyHostThread(harness, {
    ...options,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

export function assertMonotonicSequences(events: ThreadEventRow[]): void {
  for (let index = 1; index < events.length; index += 1) {
    expect(events[index]?.seq).toBeGreaterThan(events[index - 1]?.seq ?? -1);
  }
}

export async function expectThreadMissing(
  harness: IntegrationHarness,
  threadId: string,
): Promise<void> {
  const response = await harness.api.threads[":id"].$get({
    param: { id: threadId },
  });
  expect(response.status).toBe(404);
}

export async function expectEnvironmentDestroyed(
  harness: IntegrationHarness,
  environmentId: string,
): Promise<void> {
  const environment = await waitForEnvironmentStatus(
    harness.api,
    environmentId,
    "destroyed",
    DEFAULT_TIMEOUT_MS,
  );
  expect(environment.status).toBe("destroyed");
}
