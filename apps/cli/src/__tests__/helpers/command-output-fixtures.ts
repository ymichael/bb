import { vi } from "vitest";
import {
  isApprovalPendingInteractionResolution,
  isPluginExtensionInteractionResolution,
  isUserQuestionPendingInteractionResolution,
  type Environment,
  type PendingInteractionApprovalDecision,
  type ProviderPendingInteraction,
  type Thread,
} from "@bb/domain";
import type {
  ThreadTimelineResponse,
  TimelineRow,
  TimelineRowBase,
  TimelineUserConversationRow,
} from "@bb/server-contract";

interface TimelineBaseArgs {
  id: string;
  sourceSeqStart: number;
  sourceSeqEnd?: number;
  startedAt?: number;
  createdAt?: number;
}

interface MakeThreadArgs extends Partial<Thread> {
  id: string;
  projectId: string;
  providerId: string;
}

interface MakeEnvironmentArgs extends Partial<Environment> {
  id: string;
  projectId: string;
  hostId: string;
}

type MakePendingInteractionArgs = Partial<
  Omit<ProviderPendingInteraction, "payload" | "resolution">
> & {
  id: string;
  providerId: string;
  threadId: string;
  payload?: ProviderPendingInteraction["payload"];
  resolution?: ProviderPendingInteraction["resolution"];
};

export function makeTimelineBase(args: TimelineBaseArgs): TimelineRowBase {
  return {
    id: args.id,
    threadId: "thread-log",
    turnId: null,
    sourceSeqStart: args.sourceSeqStart,
    sourceSeqEnd: args.sourceSeqEnd ?? args.sourceSeqStart,
    startedAt: args.startedAt ?? args.createdAt ?? args.sourceSeqStart,
    createdAt: args.createdAt ?? args.sourceSeqStart,
  };
}

export function makeEmptyTimelineGetMock() {
  return vi.fn(async () => makeTimelineResponse([]));
}

export function makeTimelineResponse(
  rows: TimelineRow[],
): ThreadTimelineResponse {
  return {
    rows,
    contextBoundarySeq: null,
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    modelFallback: null,
    maxSeq: 0,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rows.length > 0 ? 1 : 0,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

export function makePendingSteerTimelineRow(): TimelineUserConversationRow {
  return {
    ...makeTimelineBase({
      id: "pending-steer-1",
      sourceSeqStart: 12,
    }),
    kind: "conversation",
    role: "user",
    text: "Please switch to the safer plan",
    attachments: null,
    mentions: [],
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "steer", status: "pending" },
  };
}

export function makeThread(overrides: MakeThreadArgs): Thread {
  return {
    status: "idle",
    title: null,
    titleFallback: null,
    sectionId: null,
    environmentId: null,
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makeEnvironment(overrides: MakeEnvironmentArgs): Environment {
  return {
    name: null,
    path: "/tmp/environment",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: "bb/thread",
    defaultBranch: "main",
    baseBranch: null,
    mergeBaseBranch: null,
    status: "ready",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function makePendingInteraction(
  overrides: MakePendingInteractionArgs,
): ProviderPendingInteraction {
  const suffix = overrides.id.startsWith("int-")
    ? overrides.id.slice("int-".length)
    : overrides.id;
  const { payload, resolution = null, ...rest } = overrides;
  const base = {
    createdAt: Date.now(),
    providerRequestId: `request-${suffix}`,
    providerThreadId: `provider-thread-${suffix}`,
    turnId: `turn-${suffix}`,
    resolvedAt: null,
    status: "pending" as const,
    statusReason: null,
    ...rest,
  };
  if (payload === undefined || payload.kind === "approval") {
    if (
      resolution !== null &&
      !isApprovalPendingInteractionResolution(resolution)
    ) {
      throw new Error("An approval fixture takes an approval resolution");
    }
    return {
      ...base,
      payload: payload ?? {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-1",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Approve command",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      },
      resolution,
    };
  }
  if (payload.kind === "user_question") {
    if (
      resolution !== null &&
      !isUserQuestionPendingInteractionResolution(resolution)
    ) {
      throw new Error("A user-question fixture takes a user answer");
    }
    return { ...base, payload, resolution };
  }
  if (
    resolution !== null &&
    !isPluginExtensionInteractionResolution(resolution)
  ) {
    throw new Error("A plugin request fixture takes a request answer");
  }
  return { ...base, payload, resolution };
}

export function makeCommandApprovalPayload(
  itemId: string,
  availableDecisions: PendingInteractionApprovalDecision[] = [
    "allow_once",
    "allow_for_session",
    "deny",
  ],
): ProviderPendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "command",
      itemId,
      command: "git push",
      cwd: "/tmp/project",
      actions: [],
      sessionGrant: null,
    },
    reason: "Approve command",
    availableDecisions,
  };
}

export function makeFileChangeApprovalPayload(
  itemId: string,
): ProviderPendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "file_change",
      itemId,
      writeScope: null,
      sessionGrant: null,
    },
    reason: "Approve file changes",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  };
}

export function makeUserQuestionPayload(): ProviderPendingInteraction["payload"] {
  return {
    kind: "user_question",
    questions: [
      {
        id: "question-1",
        prompt: "Which deployment path?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: true,
      },
    ],
  };
}

export function makeMultiUserQuestionPayload(): ProviderPendingInteraction["payload"] {
  return {
    kind: "user_question",
    questions: [
      {
        id: "question-1",
        prompt: "Which deployment path?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" },
        ],
        allowFreeText: false,
      },
      {
        id: "question-2",
        prompt: "Any rollout notes?",
        shortLabel: "Notes",
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };
}

export function makePermissionGrantApprovalPayload(
  itemId: string,
): ProviderPendingInteraction["payload"] {
  return {
    kind: "approval",
    subject: {
      kind: "permission_grant",
      itemId,
      toolName: null,
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/project/README.md"],
          write: ["/tmp/project/notes.md"],
        },
      },
    },
    reason: "Grant workspace access",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  };
}
