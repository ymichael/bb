import type {
  Environment,
  Host,
  Thread,
  ThreadExecutionOptions,
  ThreadEventRow,
  ThreadGitDiffResponse,
} from "@bb/domain";
import {
  environmentSchema,
  hostSchema,
  threadEventRowSchema,
  threadGitDiffResponseSchema,
  threadSchema,
} from "@bb/domain";
import type {
  CreateManagerThreadRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusResponse,
  ProjectResponse,
  SendMessageRequest,
  ThreadTimelineResponse,
  UpdateThreadRequest,
} from "@bb/server-contract";
import {
  createPublicApiClient,
  environmentActionResponseSchema,
  environmentStatusResponseSchema,
  projectResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";

export interface CreateHostThreadOptions {
  execution?: ThreadExecutionRequestOptions;
  hostId: string;
  input?: CreateThreadRequest["input"];
  projectId: string;
  providerId?: string;
  title?: string;
  workspace:
    | { type: "managed-clone" }
    | { type: "managed-worktree" }
    | { path: string | null; type: "unmanaged" };
}

export interface CreateReuseThreadOptions {
  execution?: ThreadExecutionRequestOptions;
  environmentId: string;
  input?: CreateThreadRequest["input"];
  projectId: string;
  providerId?: string;
  title?: string;
}

export type ThreadExecutionRequestOptions = Pick<
  ThreadExecutionOptions,
  "model" | "reasoningLevel" | "sandboxMode" | "serviceTier"
>;

export interface SendTextMessageOptions {
  execution?: ThreadExecutionRequestOptions;
  mode?: "auto" | "start" | "steer";
  text: string;
}

type PublicApiClient = ReturnType<typeof createPublicApiClient>;

async function expectStatus(
  response: Response,
  expectedStatus: number,
  label: string,
): Promise<void> {
  if (response.status === expectedStatus) {
    return;
  }

  const body = await response.text();
  throw new Error(`${label} failed with ${response.status}: ${body}`);
}

function defaultThreadInput(text: string): CreateThreadRequest["input"] {
  return [{ type: "text", text }];
}

function defaultModelForProvider(providerId: string): string {
  switch (providerId) {
    case "codex":
      return "gpt-5";
    case "claude-code":
      return "claude-haiku-4-5";
    case "pi":
      return "openai/codex-mini";
    default:
      return `${providerId}-model`;
  }
}

async function requireMergeBaseBranch(
  api: PublicApiClient,
  environmentId: string,
): Promise<string> {
  const environment = await getEnvironment(api, environmentId);
  if (!environment.defaultBranch) {
    throw new Error(`Environment ${environmentId} has no default branch`);
  }
  return environment.defaultBranch;
}

export async function archiveThread(
  api: PublicApiClient,
  threadId: string,
  force = false,
): Promise<void> {
  const response = await api.threads[":id"].archive.$post({
    param: { id: threadId },
    json: { force },
  });
  await expectStatus(response, 200, `archive thread ${threadId}`);
}

export async function createProject(
  api: PublicApiClient,
  request: CreateProjectRequest,
): Promise<ProjectResponse> {
  const response = await api.projects.$post({
    json: request,
  });
  await expectStatus(response, 201, `create project ${request.name}`);
  return projectResponseSchema.parse(await response.json());
}

export async function createManagerThread(
  api: PublicApiClient,
  projectId: string,
  request: CreateManagerThreadRequest,
): Promise<Thread> {
  const response = await api.projects[":id"].managers.$post({
    param: { id: projectId },
    json: request,
  });
  await expectStatus(response, 201, `create manager thread for project ${projectId}`);
  return threadSchema.parse(await response.json());
}

export async function createHostThread(
  api: PublicApiClient,
  options: CreateHostThreadOptions,
): Promise<Thread> {
  const providerId = options.providerId ?? "fake";
  const { model, ...execution } = options.execution ?? {};
  const response = await api.threads.$post({
    json: {
      environment: {
        type: "host",
        hostId: options.hostId,
        workspace: options.workspace,
      },
      input: options.input ?? defaultThreadInput("Start integration thread"),
      type: "standard",
      ...execution,
      model: model ?? defaultModelForProvider(providerId),
      projectId: options.projectId,
      providerId,
      title: options.title,
    },
  });
  await expectStatus(response, 201, "create host thread");
  return threadSchema.parse(await response.json());
}

export async function createReuseThread(
  api: PublicApiClient,
  options: CreateReuseThreadOptions,
): Promise<Thread> {
  const providerId = options.providerId ?? "fake";
  const { model, ...execution } = options.execution ?? {};
  const response = await api.threads.$post({
    json: {
      environment: {
        type: "reuse",
        environmentId: options.environmentId,
      },
      input: options.input ?? defaultThreadInput("Start integration thread"),
      type: "standard",
      ...execution,
      model: model ?? defaultModelForProvider(providerId),
      projectId: options.projectId,
      providerId,
      title: options.title,
    },
  });
  await expectStatus(response, 201, "create reuse thread");
  return threadSchema.parse(await response.json());
}

export async function deleteThread(
  api: PublicApiClient,
  threadId: string,
): Promise<void> {
  const response = await api.threads[":id"].$delete({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `delete thread ${threadId}`);
}

export async function getEnvironment(
  api: PublicApiClient,
  environmentId: string,
): Promise<Environment> {
  const response = await api.environments[":id"].$get({
    param: { id: environmentId },
  });
  await expectStatus(response, 200, `get environment ${environmentId}`);
  return environmentSchema.parse(await response.json());
}

export async function getEnvironmentBranches(
  api: PublicApiClient,
  environmentId: string,
): Promise<string[]> {
  const response = await api.environments[":id"].diff.branches.$get({
    param: { id: environmentId },
  });
  await expectStatus(response, 200, `get environment branches ${environmentId}`);
  return response.json();
}

export async function getEnvironmentDiff(
  api: PublicApiClient,
  environmentId: string,
): Promise<ThreadGitDiffResponse> {
  const mergeBaseBranch = await requireMergeBaseBranch(api, environmentId);
  const response = await api.environments[":id"].diff.$get({
    param: { id: environmentId },
    query: {
      mergeBaseBranch,
      selection: "combined",
    },
  });
  await expectStatus(response, 200, `get environment diff ${environmentId}`);
  return threadGitDiffResponseSchema.parse(await response.json());
}

export async function getEnvironmentStatus(
  api: PublicApiClient,
  environmentId: string,
): Promise<EnvironmentStatusResponse> {
  const mergeBaseBranch = await requireMergeBaseBranch(api, environmentId);
  const response = await api.environments[":id"].status.$get({
    param: { id: environmentId },
    query: { mergeBaseBranch },
  });
  await expectStatus(response, 200, `get environment status ${environmentId}`);
  return environmentStatusResponseSchema.parse(await response.json());
}

export async function getHosts(
  api: PublicApiClient,
): Promise<Host[]> {
  const response = await api.hosts.$get({});
  await expectStatus(response, 200, "get hosts");
  return hostSchema.array().parse(await response.json());
}

export async function getThread(
  api: PublicApiClient,
  threadId: string,
): Promise<Thread> {
  const response = await api.threads[":id"].$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `get thread ${threadId}`);
  return threadSchema.parse(await response.json());
}

export async function getThreadEvents(
  api: PublicApiClient,
  threadId: string,
): Promise<ThreadEventRow[]> {
  const response = await api.threads[":id"].events.$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `get thread events ${threadId}`);
  return threadEventRowSchema.array().parse(await response.json());
}

export async function getThreadOutput(
  api: PublicApiClient,
  threadId: string,
): Promise<string | null> {
  const response = await api.threads[":id"].output.$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `get thread output ${threadId}`);
  const payload = await response.json();
  return payload.output;
}

export async function getThreadTimeline(
  api: PublicApiClient,
  threadId: string,
): Promise<ThreadTimelineResponse> {
  const response = await api.threads[":id"].timeline.$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `get thread timeline ${threadId}`);
  return threadTimelineResponseSchema.parse(await response.json());
}

export async function runEnvironmentAction(
  api: PublicApiClient,
  environmentId: string,
  request: EnvironmentActionRequest,
): Promise<EnvironmentActionResponse> {
  const response = await api.environments[":id"].actions.$post({
    param: { id: environmentId },
    json: request,
  });
  await expectStatus(response, 200, `run environment action ${request.action}`);
  return environmentActionResponseSchema.parse(await response.json());
}

export async function sendTextMessage(
  api: PublicApiClient,
  threadId: string,
  options: SendTextMessageOptions,
): Promise<void> {
  const request: SendMessageRequest = {
    input: [{ type: "text", text: options.text }],
    mode: options.mode ?? "auto",
    ...(options.execution ?? {}),
  };
  const response = await api.threads[":id"].send.$post({
    param: { id: threadId },
    json: request,
  });
  await expectStatus(response, 200, `send message to thread ${threadId}`);
}

export async function stopThread(
  api: PublicApiClient,
  threadId: string,
): Promise<void> {
  const response = await api.threads[":id"].stop.$post({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `stop thread ${threadId}`);
}

export async function unarchiveThread(
  api: PublicApiClient,
  threadId: string,
): Promise<void> {
  const response = await api.threads[":id"].unarchive.$post({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `unarchive thread ${threadId}`);
}

export async function updateThread(
  api: PublicApiClient,
  threadId: string,
  request: UpdateThreadRequest,
): Promise<Thread> {
  const response = await api.threads[":id"].$patch({
    param: { id: threadId },
    json: request,
  });
  await expectStatus(response, 200, `update thread ${threadId}`);
  return threadSchema.parse(await response.json());
}
