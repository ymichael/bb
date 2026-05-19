import type {
  Environment,
  Host,
  Thread,
  ThreadListEntry,
  WorkspaceStatus,
} from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import type {
  AttachmentsConfig,
  MentionsConfig,
} from "../src/components/promptbox/PromptBoxInternal";

const noop = () => {};

// ---------------------------------------------------------------------------
// A small set of realistic, shared constants so the fixture universe feels
// coherent across stories. Keep this list short — when stories reach for a
// host or project name, they should reach for one of these.
// ---------------------------------------------------------------------------

export const HOST_IDS = {
  local: "host_local",
  remote: "host_remote",
} as const;

export const HOST_NAMES = {
  local: "Michael's MacBook Pro",
  remote: "michael-build-box",
} as const;

export const PROJECT_IDS = {
  bb: "proj_bb",
  pierre: "proj_pierre",
  ingest: "proj_ingest_pipeline",
} as const;

export const PROJECT_NAMES = {
  bb: "bb",
  pierre: "pierre",
  ingest: "ingest-pipeline",
} as const;

export const BRANCH_NAMES = {
  default: "main",
  feature: "feat/sidebar-rail",
} as const;

/** Stable set of placeholder image URLs for prompt-attachment + preview stories. */
export const PLACEHOLDER_IMAGE_URLS = [
  "https://placecats.com/300/200",
  "https://placecats.com/320/180",
  "https://placecats.com/360/220",
  "https://placecats.com/400/240",
] as const;

// ---------------------------------------------------------------------------
// Promptbox config builders. PromptBoxInternal, NewThreadPromptBox, and
// FollowUpPromptBox stories all reach for the same Mentions / Attachments
// shapes — share them here so the inert defaults stay consistent.
// ---------------------------------------------------------------------------

export function makeMentionsConfig(
  overrides: Partial<MentionsConfig> = {},
): MentionsConfig {
  const base: MentionsConfig = {
    suggestions: [],
    threadSectionMode: "threads",
    isLoading: false,
    isError: false,
    onQueryChange: noop,
  };
  return { ...base, ...overrides };
}

export function makeAttachmentsConfig(
  overrides: Partial<AttachmentsConfig> = {},
): AttachmentsConfig {
  const base: AttachmentsConfig = {
    items: [],
    projectId: PROJECT_IDS.bb,
    onAttachFiles: noop,
    onRemove: noop,
    isAttaching: false,
    error: null,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Typed-base builders. Each base is annotated with its strict T so TypeScript
// contextually checks every field (literal enum values + missing fields).
// `Partial<T>` overrides can only restate existing fields, never invent
// missing ones.
// ---------------------------------------------------------------------------

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  const base: Thread = {
    id: "thr_demo",
    projectId: PROJECT_IDS.bb,
    environmentId: "env_demo",
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: 100,
    latestAttentionAt: 100,
    createdAt: 0,
    updatedAt: 100,
  };
  return { ...base, ...overrides };
}

export function makeThreadListEntry(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  const base: ThreadListEntry = {
    id: "thr_demo",
    projectId: PROJECT_IDS.bb,
    environmentId: null,
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: 100,
    latestAttentionAt: 100,
    createdAt: 0,
    updatedAt: 100,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
  };
  return { ...base, ...overrides };
}

export function makeProject(
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  const base: ProjectResponse = {
    id: PROJECT_IDS.bb,
    name: PROJECT_NAMES.bb,
    sources: [],
    createdAt: 1,
    updatedAt: 2,
  };
  return { ...base, ...overrides };
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  const base: Host = {
    id: HOST_IDS.local,
    name: HOST_NAMES.local,
    type: "persistent",
    status: "connected",
    lastSeenAt: 100,
    createdAt: 0,
    updatedAt: 100,
  };
  return { ...base, ...overrides };
}

export function makeEnvironment(
  overrides: Partial<Environment> = {},
): Environment {
  const base: Environment = {
    id: "env_demo",
    projectId: PROJECT_IDS.bb,
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/bb",
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    workspaceProvisionType: "managed-worktree",
    branchName: BRANCH_NAMES.feature,
    baseBranch: BRANCH_NAMES.default,
    defaultBranch: BRANCH_NAMES.default,
    mergeBaseBranch: null,
    cleanupRequestedAt: null,
    cleanupMode: null,
    status: "ready",
    createdAt: 0,
    updatedAt: 100,
  };
  return { ...base, ...overrides };
}

export function makeWorkspaceStatus(
  overrides: Partial<WorkspaceStatus> = {},
): WorkspaceStatus {
  const base: WorkspaceStatus = {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      insertions: 0,
      deletions: 0,
      files: [],
    },
    branch: {
      currentBranch: BRANCH_NAMES.feature,
      defaultBranch: BRANCH_NAMES.default,
    },
    mergeBase: {
      mergeBaseBranch: BRANCH_NAMES.default,
      baseRef: null,
      aheadCount: 0,
      behindCount: 0,
      hasCommittedUnmergedChanges: false,
      commits: [],
      insertions: 0,
      deletions: 0,
      files: [],
    },
  };
  return { ...base, ...overrides };
}
