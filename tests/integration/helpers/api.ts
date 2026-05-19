import type {
  AvailableModel,
  Environment,
  Host,
  PendingInteraction,
  Thread,
  ThreadExecutionOptions,
  ThreadEventRow,
  ThreadGitDiffResponse,
} from "@bb/domain";
import {
  environmentSchema,
  hostSchema,
  pendingInteractionSchema,
  resolveEnvironmentMergeBaseBranch,
  threadEventRowSchema,
  threadGitDiffResponseSchema,
  threadSchema,
} from "@bb/domain";
import { listPreferredTestModels } from "@bb/test-helpers";
import type {
  CreateManagerThreadRequest,
  CreateProjectRequest,
  CreateThreadRequest,
  EnvironmentActionRequest,
  EnvironmentActionResponse,
  EnvironmentStatusResponse,
  ProjectResponse,
  ResolvePendingInteractionRequest,
  SendMessageRequest,
  ThreadPendingInteractionsResponse,
  ThreadTimelineResponse,
  ThreadResponse,
  UpdateEnvironmentRequest,
  UpdateThreadRequest,
  WorkspaceArgs,
} from "@bb/server-contract";
import {
  createPublicApiClient,
  environmentActionResponseSchema,
  environmentStatusResponseSchema,
  projectResponseSchema,
  systemExecutionOptionsResponseSchema,
  threadPendingInteractionsResponseSchema,
  threadResponseSchema,
  threadTimelineResponseSchema,
} from "@bb/server-contract";

export interface CreateHostThreadOptions {
  execution?: ThreadExecutionRequestOptions;
  hostId: string;
  input?: CreateThreadRequest["input"];
  origin?: CreateThreadRequest["origin"];
  projectId: string;
  providerId?: string;
  title?: string;
  workspace:
    | { type: "managed-worktree" }
    | { path: string | null; type: "unmanaged" };
}

export interface CreateReuseThreadOptions {
  execution?: ThreadExecutionRequestOptions;
  environmentId: string;
  input?: CreateThreadRequest["input"];
  origin?: CreateThreadRequest["origin"];
  projectId: string;
  providerId?: string;
  title?: string;
}

export interface CreateManagerThreadOptions extends Omit<
  CreateManagerThreadRequest,
  "origin"
> {
  origin?: CreateManagerThreadRequest["origin"];
}

export type ThreadExecutionRequestOptions = Pick<
  ThreadExecutionOptions,
  "model" | "reasoningLevel" | "permissionMode" | "serviceTier"
>;

export interface SendTextMessageOptions {
  execution?: ThreadExecutionRequestOptions;
  mode?: "auto" | "start" | "steer";
  text: string;
}

export interface GetThreadTimelineOptions {
  includeNestedRows?: boolean;
}

export interface GetAvailableModelsOptions {
  hostId?: string;
  providerId?: string;
}

type PublicApiClient = ReturnType<typeof createPublicApiClient>;
const DEFAULT_THREAD_BOOTSTRAP_TEXT =
  "Reply with exactly READY and nothing else.";
const DEFAULT_PUBLIC_TEST_THREAD_ORIGIN = "app";

interface ResolveThreadInteractionArgs {
  api: PublicApiClient;
  interactionId: string;
  resolution: ResolvePendingInteractionRequest;
  threadId: string;
}

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
  return listPreferredTestModels(providerId)[0] ?? `${providerId}-model`;
}

function toWorkspaceArgs(
  workspace: CreateHostThreadOptions["workspace"],
): WorkspaceArgs {
  if (workspace.type === "unmanaged") {
    return workspace;
  }
  return { ...workspace, baseBranch: { kind: "default" } };
}

export function requireEnvironmentMergeBaseBranch(
  environment: Environment,
): string {
  const mergeBaseBranch = resolveEnvironmentMergeBaseBranch(environment);
  if (!mergeBaseBranch) {
    throw new Error(`Environment ${environment.id} has no merge base branch`);
  }
  return mergeBaseBranch;
}

async function requireMergeBaseBranch(
  api: PublicApiClient,
  environmentId: string,
): Promise<string> {
  const environment = await getEnvironment(api, environmentId);
  return requireEnvironmentMergeBaseBranch(environment);
}

export async function archiveThread(
  api: PublicApiClient,
  threadId: string,
): Promise<void> {
  const response = await api.threads[":id"].archive.$post({
    param: { id: threadId },
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
  request: CreateManagerThreadOptions,
): Promise<Thread> {
  const response = await api.projects[":id"].managers.$post({
    param: { id: projectId },
    json: {
      ...request,
      origin: request.origin ?? DEFAULT_PUBLIC_TEST_THREAD_ORIGIN,
    },
  });
  await expectStatus(
    response,
    201,
    `create manager thread for project ${projectId}`,
  );
  return threadSchema.parse(await response.json());
}

export async function createHostThread(
  api: PublicApiClient,
  options: CreateHostThreadOptions,
): Promise<Thread> {
  const origin = options.origin ?? DEFAULT_PUBLIC_TEST_THREAD_ORIGIN;
  const providerId = options.providerId ?? "fake";
  const { model, ...execution } = options.execution ?? {};
  const response = await api.threads.$post({
    json: {
      environment: {
        type: "host",
        hostId: options.hostId,
        workspace: toWorkspaceArgs(options.workspace),
      },
      input: options.input ?? defaultThreadInput(DEFAULT_THREAD_BOOTSTRAP_TEXT),
      origin,
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
  const origin = options.origin ?? DEFAULT_PUBLIC_TEST_THREAD_ORIGIN;
  const providerId = options.providerId ?? "fake";
  const { model, ...execution } = options.execution ?? {};
  const response = await api.threads.$post({
    json: {
      environment: {
        type: "reuse",
        environmentId: options.environmentId,
      },
      input: options.input ?? defaultThreadInput(DEFAULT_THREAD_BOOTSTRAP_TEXT),
      origin,
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
    json: { managerChildThreadsConfirmed: false },
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
  await expectStatus(
    response,
    200,
    `get environment branches ${environmentId}`,
  );
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
      target: "all",
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

export async function getAvailableModels(
  api: PublicApiClient,
  options: GetAvailableModelsOptions,
): Promise<AvailableModel[]> {
  const response = await api.system["execution-options"].$get({
    query: {
      ...(options.hostId ? { hostId: options.hostId } : {}),
      ...(options.providerId ? { providerId: options.providerId } : {}),
    },
  });
  await expectStatus(response, 200, "get available models");
  return systemExecutionOptionsResponseSchema.parse(await response.json())
    .models;
}

export async function getHosts(api: PublicApiClient): Promise<Host[]> {
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

export async function getThreadResponse(
  api: PublicApiClient,
  threadId: string,
): Promise<ThreadResponse> {
  const response = await api.threads[":id"].$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `get thread ${threadId}`);
  return threadResponseSchema.parse(await response.json());
}

export async function getThreadEvents(
  api: PublicApiClient,
  threadId: string,
): Promise<ThreadEventRow[]> {
  const response = await api.threads[":id"].events.$get({
    param: { id: threadId },
    query: { limit: "10000" },
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
  options: GetThreadTimelineOptions = {},
): Promise<ThreadTimelineResponse> {
  const response = await api.threads[":id"].timeline.$get({
    param: { id: threadId },
    query:
      options.includeNestedRows === undefined
        ? {}
        : { includeNestedRows: options.includeNestedRows ? "true" : "false" },
  });
  await expectStatus(response, 200, `get thread timeline ${threadId}`);
  return threadTimelineResponseSchema.parse(await response.json());
}

export async function listThreadInteractions(
  api: PublicApiClient,
  threadId: string,
): Promise<ThreadPendingInteractionsResponse> {
  const response = await api.threads[":id"].interactions.$get({
    param: { id: threadId },
  });
  await expectStatus(response, 200, `list thread interactions ${threadId}`);
  return threadPendingInteractionsResponseSchema.parse(await response.json());
}

export async function resolveThreadInteraction(
  args: ResolveThreadInteractionArgs,
): Promise<PendingInteraction> {
  const response = await args.api.threads[":id"].interactions[
    ":interactionId"
  ].resolve.$post({
    param: { id: args.threadId, interactionId: args.interactionId },
    json: args.resolution,
  });
  await expectStatus(
    response,
    200,
    `resolve thread interaction ${args.interactionId}`,
  );
  return pendingInteractionSchema.parse(await response.json());
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

export async function updateEnvironment(
  api: PublicApiClient,
  environmentId: string,
  request: UpdateEnvironmentRequest,
): Promise<Environment> {
  const response = await api.environments[":id"].$patch({
    param: { id: environmentId },
    json: request,
  });
  await expectStatus(response, 200, `update environment ${environmentId}`);
  return environmentSchema.parse(await response.json());
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
