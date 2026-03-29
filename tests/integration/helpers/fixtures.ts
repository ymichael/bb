import type {
  Environment,
  Thread,
} from "@bb/domain";
import type { CreateThreadRequest } from "@bb/server-contract";
import {
  createHostThread,
  createProject,
  createReuseThread,
  getEnvironment,
} from "./api.js";
import {
  waitForEnvironmentStatus,
  waitForThreadStatus,
} from "./assertions.js";
import type { IntegrationHarness } from "./harness.js";

export interface CreateProjectFixtureOptions {
  name: string;
  path?: string;
}

export interface ProjectFixture {
  id: string;
}

export interface ReadyHostThreadOptions {
  input?: CreateThreadRequest["input"];
  projectId: string;
  providerId?: string;
  timeoutMs?: number;
  title?: string;
  workspace:
    | { type: "managed-clone" }
    | { type: "managed-worktree" }
    | { path: string | null; type: "unmanaged" };
}

export interface ReadyReuseThreadOptions {
  environmentId: string;
  input?: CreateThreadRequest["input"];
  projectId: string;
  providerId?: string;
  timeoutMs?: number;
  title?: string;
}

export interface ReadyThreadFixture {
  environment: Environment;
  thread: Thread;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function createProjectFixture(
  harness: IntegrationHarness,
  options: CreateProjectFixtureOptions,
): Promise<ProjectFixture> {
  const project = await createProject(harness.api, {
    name: options.name,
    source: {
      type: "local_path",
      hostId: harness.hostId,
      path: options.path ?? harness.repoDir,
    },
  });
  return { id: project.id };
}

export async function createReadyHostThread(
  harness: IntegrationHarness,
  options: ReadyHostThreadOptions,
): Promise<ReadyThreadFixture> {
  const thread = await createHostThread(harness.api, {
    hostId: harness.hostId,
    input: options.input,
    projectId: options.projectId,
    providerId: options.providerId,
    title: options.title,
    workspace: options.workspace,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readyThread = thread.status === "idle"
    ? thread
    : await waitForThreadStatus(harness.api, thread.id, "idle", timeoutMs);
  const environmentId = readyThread.environmentId ?? thread.environmentId;
  if (!environmentId) {
    throw new Error(`Thread ${thread.id} has no environment`);
  }
  const environment = await waitForEnvironmentStatus(
    harness.api,
    environmentId,
    "ready",
    timeoutMs,
  );
  return { environment, thread: readyThread };
}

export async function createReadyReuseThread(
  harness: IntegrationHarness,
  options: ReadyReuseThreadOptions,
): Promise<ReadyThreadFixture> {
  const thread = await createReuseThread(harness.api, {
    environmentId: options.environmentId,
    input: options.input,
    projectId: options.projectId,
    providerId: options.providerId,
    title: options.title,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readyThread = thread.status === "idle"
    ? thread
    : await waitForThreadStatus(harness.api, thread.id, "idle", timeoutMs);
  const environmentId = readyThread.environmentId ?? thread.environmentId;
  if (!environmentId) {
    throw new Error(`Thread ${thread.id} has no environment`);
  }
  const environment = await getEnvironment(harness.api, environmentId);
  if (environment.status !== "ready") {
    throw new Error(
      `Expected reused environment ${environment.id} to be ready, got ${environment.status}`,
    );
  }
  return { environment, thread: readyThread };
}
