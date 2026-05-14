import { useState, type ReactNode } from "react";
import type {
  PermissionMode,
  ThreadQueuedMessage,
  WorkspaceStatus,
} from "@bb/domain";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import { PersistentHostIconName } from "@/lib/host-display";
import { getEnvironmentWorkspaceLabelIconName } from "@/lib/environment-workspace-display";
import type {
  AttachmentsConfig,
  MentionsConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { ThreadPromptContextBanner } from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { QueuedMessagesList } from "@/components/promptbox/banner/QueuedMessagesList";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { ExecutionControlsProps } from "@/components/promptbox/ExecutionControls";
import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { OpenAiIcon } from "@/components/icons/OpenAiIcon";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import { selectWorkspaceChangedFilesSection } from "@/components/workspace/workspace-change-summary";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "promptbox/Follow Up Prompt Box",
};

const noop = () => {};

// ---------------------------------------------------------------------------
// Realistic execution controls — codex provider, gpt-5.5 model
// ---------------------------------------------------------------------------

const providerOptions: readonly PickerOption<string>[] = [
  { value: "codex", label: "Codex", icon: OpenAiIcon },
  { value: "claude-code", label: "Claude Code", icon: ClaudeIcon },
];

const baseExecution: ExecutionControlsProps = {
  provider: {
    options: providerOptions,
    selectedId: "codex",
    // FollowUp omits onChange — the thread is committed to a provider, the
    // picker renders the provider segment as locked.
    hasMultiple: true,
    displayName: "Codex",
  },
  model: {
    active: { model: "gpt-5.5" },
    selected: "gpt-5.5",
    options: [
      { value: "gpt-5-pro", label: "GPT-5 Pro" },
      { value: "gpt-5.5", label: "GPT-5.5" },
      { value: "gpt-5-mini", label: "GPT-5 mini" },
    ],
    onChange: noop,
  },
  serviceTier: {
    value: undefined,
    onChange: noop,
    supported: true,
    supportByProvider: { codex: true, "claude-code": false },
  },
  reasoning: {
    value: "medium",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    onChange: noop,
  },
};

const permissionModeOptions: readonly PickerOption<PermissionMode>[] = [
  { value: "full", label: "Full Access", tone: "warning" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "readonly", label: "Readonly" },
];

const basePermission = {
  value: "workspace-write" as PermissionMode,
  options: permissionModeOptions,
  onChange: noop,
  supported: true,
};

// ---------------------------------------------------------------------------
// Environment summary slot — pre-built element passed straight through.
// ---------------------------------------------------------------------------

// Mirrors production: ThreadDetailView feeds these props from
// formatEnvironmentDisplay, so the labels here track the same shape.
const localEnvironmentSummary: ReactNode = (
  <ThreadEnvironmentSummary
    environmentLabel="Working locally"
    environmentIcon={PersistentHostIconName}
    environmentBranchName="bb/promptbox-stories"
  />
);

const remoteEnvironmentSummary: ReactNode = (
  <ThreadEnvironmentSummary
    environmentLabel="Working remotely"
    environmentHostLabel="ec2-builder"
    environmentHostConnected
    environmentIcon={PersistentHostIconName}
    environmentBranchName="bb/promptbox-stories"
  />
);

const worktreeEnvironmentSummary: ReactNode = (
  <ThreadEnvironmentSummary
    environmentLabel="Worktree"
    environmentIcon={getEnvironmentWorkspaceLabelIconName("managed-worktree")}
    environmentBranchName="bb/promptbox-stories"
  />
);

const sandboxEnvironmentSummary: ReactNode = (
  <ThreadEnvironmentSummary
    environmentLabel="E2B Sandbox"
    environmentIcon={getEnvironmentWorkspaceLabelIconName("sandbox")}
    environmentBranchName="bb/promptbox-stories"
  />
);

const usage: ThreadContextWindowUsage = {
  usedTokens: 32_400,
  modelContextWindow: 128_000,
  estimated: false,
};

// ---------------------------------------------------------------------------
// Mentions + attachments + history (mostly empty fixtures)
// ---------------------------------------------------------------------------

const mentionsBase: MentionsConfig = {
  suggestions: [],
  isLoading: false,
  isError: false,
  onQueryChange: noop,
};

const attachmentsBase: AttachmentsConfig = {
  items: [],
  projectId: "proj_demo",
  isAttaching: false,
  error: null,
  onAttachFiles: noop,
  onRemove: noop,
};

const historyEntries = [
  { text: "review thread workspace", attachments: [] },
  { text: "investigate timeline pagination", attachments: [] },
];

// ---------------------------------------------------------------------------
// Stack slot fixtures — ThreadPromptContextBanner + QueuedMessagesList stack
// above the prompt input. The caller composes them as a single ReactNode.
// ---------------------------------------------------------------------------

const dirtyWorkspaceStatus: WorkspaceStatus = {
  workingTree: {
    state: "dirty_uncommitted",
    hasUncommittedChanges: true,
    files: [
      {
        path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx",
        status: "M",
        insertions: 42,
        deletions: 18,
      },
      {
        path: "apps/app/src/views/ThreadDetailPromptArea.tsx",
        status: "M",
        insertions: 12,
        deletions: 6,
      },
      {
        path: "apps/app/src/components/promptbox/banner/QueuedMessagesList.tsx",
        status: "A",
        insertions: 74,
        deletions: 0,
      },
    ],
    insertions: 128,
    deletions: 24,
  },
  branch: {
    currentBranch: "bb/promptbox-stories",
    defaultBranch: "main",
  },
  mergeBase: null,
};

const dirtyContextBannerSection = selectWorkspaceChangedFilesSection(
  dirtyWorkspaceStatus,
);

const contextBannerElement: ReactNode = dirtyContextBannerSection ? (
  <ThreadPromptContextBanner
    todoSection={null}
    gitSection={{
      changedFiles: dirtyContextBannerSection,
      mergeBase: {
        branch: "main",
        options: ["main", "develop", "release/2026-05"],
        onChange: noop,
      },
      onPromptBannerFileClick: noop,
    }}
    managedBySection={null}
    managerChildrenSection={null}
    expandedSection={null}
    onToggleSection={noop}
  />
) : null;

const queuedMessages: readonly ThreadQueuedMessage[] = [
  {
    id: "q_1",
    content: [
      { type: "text", text: "Also check the timeline error overlay." },
    ],
    model: "gpt-5.5",
    reasoningLevel: "medium",
    permissionMode: "workspace-write",
    serviceTier: "default",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "q_2",
    content: [
      {
        type: "text",
        text: "And confirm the new env summary renders without the branch button on sandbox hosts.",
      },
    ],
    model: "gpt-5.5",
    reasoningLevel: "medium",
    permissionMode: "workspace-write",
    serviceTier: "default",
    createdAt: 0,
    updatedAt: 0,
  },
];

const queuedMessagesElement: ReactNode = (
  <QueuedMessagesList
    queuedMessages={queuedMessages}
    sendDisabled={false}
    actionDisabled={false}
    processingMessageId={null}
    onSendImmediately={noop}
    onEdit={noop}
    onDelete={noop}
  />
);

// ---------------------------------------------------------------------------
// Per-row component
// ---------------------------------------------------------------------------

interface RowConfig {
  initialMessage?: string;
  submitMode: FollowUpSubmitMode;
  isFollowUpSubmitting?: boolean;
  threadRuntimeDisplayStatus?: ComposerCoreRuntimeStatus;
  promptPlaceholder?: string;
  environmentSummary?: ReactNode | null;
  contextWindowUsage?: ThreadContextWindowUsage | null;
  stack?: ReactNode | null;
  zenModeResetKey?: string;
}

type ComposerCoreRuntimeStatus = Parameters<typeof FollowUpPromptBox>[0]["composer"]["threadRuntimeDisplayStatus"];

// Match production: ThreadTimelinePane's PageShell footer caps content at
// 760px. The story's StoryRow value cell uses flex-wrap, which would
// otherwise let the prompt box collapse to its intrinsic content width.
function PromptStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

function Row({
  initialMessage = "",
  submitMode,
  isFollowUpSubmitting = false,
  threadRuntimeDisplayStatus = "idle",
  promptPlaceholder = "Ask a follow-up...",
  environmentSummary = localEnvironmentSummary,
  contextWindowUsage = null,
  stack = null,
  zenModeResetKey = "thr_demo",
}: RowConfig) {
  const [message, setMessage] = useState(initialMessage);
  return (
    <PromptStage>
      <FollowUpPromptBox
        attachments={attachmentsBase}
        stack={stack}
        composer={{
          history: {
            currentDraft: { text: message, attachments: [] },
            entries: historyEntries,
            onSelectEntry: noop,
          },
          isFollowUpSubmitting,
          message,
          onChangeMessage: setMessage,
          onSteerSubmit: noop,
          onSubmit: noop,
          promptPlaceholder,
          canSteerSubmit: submitMode.kind === "queue",
          submitMode,
          threadRuntimeDisplayStatus,
        }}
        environmentSummary={environmentSummary}
        contextWindowUsage={contextWindowUsage}
        execution={baseExecution}
        permission={basePermission}
        mentions={mentionsBase}
        zenModeResetKey={zenModeResetKey}
      />
    </PromptStage>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="ready" hint="idle thread — submit normally; no stop">
        <Row submitMode={{ kind: "ready" }} />
      </StoryRow>
      <StoryRow
        label="queue"
        hint="active runtime — submit queues; stop button visible"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          contextWindowUsage={usage}
        />
      </StoryRow>
      <StoryRow
        label="stop-only"
        hint="waiting-for-host — can't queue; can stop"
      >
        <Row
          submitMode={{ kind: "stop-only", onStop: noop }}
          threadRuntimeDisplayStatus="waiting-for-host"
          promptPlaceholder="Waiting for host to reconnect..."
        />
      </StoryRow>
      <StoryRow
        label="blocked: pending interaction"
        hint="agent is waiting on a tool decision — composer locked"
      >
        <Row
          submitMode={{ kind: "blocked", reason: "pending-interaction" }}
          promptPlaceholder="Waiting for your tool decision above..."
        />
      </StoryRow>
      <StoryRow
        label="blocked: provisioning"
        hint="environment still spinning up"
      >
        <Row
          submitMode={{ kind: "blocked", reason: "provisioning" }}
          threadRuntimeDisplayStatus="provisioning"
          promptPlaceholder="Provisioning environment..."
        />
      </StoryRow>
      <StoryRow
        label="submitting"
        hint="send mutation in flight; submitMode separately tells stop visibility"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          isFollowUpSubmitting
          threadRuntimeDisplayStatus="active"
          initialMessage="And confirm the new env summary renders correctly."
        />
      </StoryRow>
      <StoryRow
        label="with queued messages"
        hint="queued cards stack above the prompt input"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          stack={queuedMessagesElement}
          contextWindowUsage={usage}
        />
      </StoryRow>
      <StoryRow label="with promptbox context banner">
        <Row
          submitMode={{ kind: "ready" }}
          stack={contextBannerElement}
        />
      </StoryRow>
      <StoryRow
        label="stacked cards"
        hint="banner + queued messages composed in the same stack slot"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          stack={
            <>
              {contextBannerElement}
              {queuedMessagesElement}
            </>
          }
          contextWindowUsage={usage}
        />
      </StoryRow>
      <StoryRow
        label="env: remote host"
        hint="Working remotely · host-name with connection dot"
      >
        <Row
          submitMode={{ kind: "ready" }}
          environmentSummary={remoteEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow label="env: worktree" hint="managed worktree label + icon">
        <Row
          submitMode={{ kind: "ready" }}
          environmentSummary={worktreeEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow label="env: sandbox" hint="ephemeral host label + container icon">
        <Row
          submitMode={{ kind: "ready" }}
          environmentSummary={sandboxEnvironmentSummary}
        />
      </StoryRow>
    </StoryCard>
  );
}
