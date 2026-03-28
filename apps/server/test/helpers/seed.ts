import {
  createEnvironment,
  createDraft,
  insertEvents,
  createProject,
  createProjectSource,
  createThread,
  openSession,
  upsertHost,
} from "@bb/db";
import type { ThreadEventType } from "@bb/domain";
import type { AppDeps } from "../../src/types.js";

export function seedHost(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { id?: string; name?: string; type?: "persistent" | "ephemeral" } = {},
) {
  return upsertHost(deps.db, deps.hub, {
    id: args.id,
    name: args.name ?? "Test Host",
    type: args.type ?? "persistent",
  });
}

export function seedHostSession(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { id?: string; name?: string; type?: "persistent" | "ephemeral" } = {},
) {
  const host = seedHost(deps, args);
  const session = seedSession(deps, host.id);
  return { host, session };
}

export function seedSession(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
) {
  return openSession(deps.db, deps.hub, {
    hostId,
    instanceId: "instance-1",
    hostName: "Test Host",
    hostType: "persistent",
    protocolVersion: 2,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
}

export function seedProjectWithSource(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { hostId: string; name?: string; path?: string },
) {
  const project = createProject(deps.db, deps.hub, {
    name: args.name ?? "Test Project",
  });
  const source = createProjectSource(deps.db, deps.hub, {
    projectId: project.id,
    hostId: args.hostId,
    type: "local_path",
    path: args.path ?? "/tmp/test-project",
    isDefault: true,
  });
  return { project, source };
}

export function seedEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    hostId: string;
    projectId: string;
    path?: string;
    status?: "provisioning" | "ready" | "error" | "destroying";
    managed?: boolean;
    workspaceProvisionType?: "unmanaged" | "managed-worktree" | "managed-clone";
    branchName?: string | null;
    defaultBranch?: string | null;
  },
) {
  return createEnvironment(deps.db, deps.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path ?? "/tmp/test-environment",
    status: args.status ?? "ready",
    managed: args.managed ?? false,
    isGitRepo: true,
    isWorktree: args.workspaceProvisionType === "managed-worktree",
    workspaceProvisionType: args.workspaceProvisionType ?? "unmanaged",
    branchName: args.branchName ?? "bb/test",
    defaultBranch: args.defaultBranch ?? "main",
  });
}

export function seedThread(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    projectId: string;
    environmentId?: string | null;
    providerId?: string;
    status?: "created" | "provisioning" | "idle" | "active" | "error";
    type?: "standard" | "manager";
    title?: string | null;
    mergeBaseBranch?: string | null;
    parentThreadId?: string | null;
    titleFallback?: string | null;
  },
) {
  return createThread(deps.db, deps.hub, {
    projectId: args.projectId,
    environmentId: args.environmentId ?? null,
    providerId: args.providerId ?? "codex",
    status: args.status ?? "idle",
    type: args.type ?? "standard",
    title: args.title ?? "Test Thread",
    titleFallback: args.titleFallback ?? "Test Thread",
    mergeBaseBranch: args.mergeBaseBranch ?? "main",
    parentThreadId: args.parentThreadId ?? null,
  });
}

export function seedDraft(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    content: string;
    threadId: string;
    model?: string;
    reasoningLevel?: string;
    sandboxMode?: string;
    serviceTier?: string;
  },
) {
  return createDraft(deps.db, deps.hub, {
    threadId: args.threadId,
    content: args.content,
    model: args.model ?? "gpt-5",
    reasoningLevel: args.reasoningLevel ?? "medium",
    sandboxMode: args.sandboxMode ?? "danger-full-access",
    serviceTier: args.serviceTier ?? "flex",
  });
}

export function seedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    data: Record<string, unknown>;
    environmentId?: string | null;
    providerThreadId?: string | null;
    sequence: number;
    threadId: string;
    turnId?: string | null;
    type: ThreadEventType;
  },
) {
  insertEvents(deps.db, deps.hub, [
    {
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
      providerThreadId: args.providerThreadId ?? null,
      sequence: args.sequence,
      turnId: args.turnId ?? null,
      type: args.type,
      data: JSON.stringify(args.data),
    },
  ]);
}
