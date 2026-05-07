import { useState } from "react";
import type {
  PermissionMode,
  ThreadQueuedMessage,
  WorkspaceFileStatus,
  WorkspaceStatus,
} from "@bb/domain";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { Container, Monitor } from "lucide-react";
import {
  FollowUpPromptBox,
  type ComposerSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import type { ExecutionControlsProps } from "@/components/promptbox/ExecutionControls";
import { ClaudeIcon } from "@/components/icons/ClaudeIcon";
import { OpenAiIcon } from "@/components/icons/OpenAiIcon";
import type { PickerOption } from "@/components/pickers/OptionPicker";
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
    onChange: noop,
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
// Environment summary (left of the bottom row)
// ---------------------------------------------------------------------------

const localEnvironmentSummary = {
  environmentLabel: "Direct",
  environmentHostConnected: true,
  environmentIcon: Monitor,
  environmentBranchName: "bb/promptbox-stories",
};

const sandboxEnvironmentSummary = {
  environmentLabel: "Sandbox",
  environmentHostConnected: true,
  environmentIcon: Container,
  environmentBranchName: undefined,
};

const usage: ThreadContextWindowUsage = {
  usedTokens: 32_400,
  modelContextWindow: 128_000,
  estimated: false,
};

// ---------------------------------------------------------------------------
// Mentions (no suggestions in default — would need to seed value)
// ---------------------------------------------------------------------------

const mentionsBase = {
  mentionError: false,
  mentionLoading: false,
  mentionSuggestions: [],
  onMentionQueryChange: noop,
};

// ---------------------------------------------------------------------------
// Attachments + history (mostly empty)
// ---------------------------------------------------------------------------

const attachmentsBase = {
  attachmentError: null,
  attachments: [],
  isAttaching: false,
  onAttachFiles: noop,
  onRemoveAttachment: noop,
  projectId: "proj_demo",
};

const historyEntries = [
  { text: "promote thread workspace", attachments: [] },
  { text: "investigate timeline pagination", attachments: [] },
];

// ---------------------------------------------------------------------------
// Banner — kept hidden in most stories. The merge-base banner is being
// replaced by ThreadPromptContextBanner; we mock the minimum to keep the
// composer happy.
// ---------------------------------------------------------------------------

const bannerHidden = {
  canExpandPromptChangeList: false,
  isChangeListExpanded: false,
  isDiffPanelActive: false,
  onPromptBannerFileClick: noop,
  onPromptGitStatsBannerClick: noop,
  onToggleChangeListExpanded: noop,
  promptBannerSummary: null,
  showBranchComparisonUi: false,
  showPromptGitStatsBanner: false,
};

const bannerWithChanges = {
  ...bannerHidden,
  canExpandPromptChangeList: true,
  promptBannerSummary: (
    <span>3 files changed · +128 −24</span>
  ) as React.ReactNode,
  promptBannerFiles: [
    { path: "apps/app/src/components/promptbox/FollowUpPromptBox.tsx", status: "M" },
    { path: "apps/app/src/views/ThreadDetailPromptArea.tsx", status: "M" },
    { path: "apps/app/src/components/promptbox/QueuedMessagesList.tsx", status: "A" },
  ] satisfies WorkspaceFileStatus[],
  showPromptGitStatsBanner: true,
  workspaceStatus: null as WorkspaceStatus | null,
};

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const emptyQueue = {
  isQueueMutationPending: false,
  onDeleteQueuedMessage: noop,
  onEditQueuedMessage: noop,
  onSendQueuedImmediately: noop,
  processingQueuedMessageId: null,
  queuedMessages: [] as readonly ThreadQueuedMessage[],
};

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

// ---------------------------------------------------------------------------
// Per-row component (one controlled instance + variant config)
// ---------------------------------------------------------------------------

interface RowConfig {
  initialMessage?: string;
  submitMode: ComposerSubmitMode;
  isFollowUpSubmitting?: boolean;
  threadRuntimeDisplayStatus?: ComposerCoreRuntimeStatus;
  promptPlaceholder?: string;
  environmentSummary?: typeof localEnvironmentSummary | null;
  contextWindowUsage?: ThreadContextWindowUsage;
  banner?: typeof bannerHidden;
  queue?: typeof emptyQueue;
  zenModeResetKey?: string;
}

// re-export the runtime display status type narrowly for stories
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
  contextWindowUsage,
  banner = bannerHidden,
  queue = emptyQueue,
  zenModeResetKey = "thr_demo",
}: RowConfig) {
  const [message, setMessage] = useState(initialMessage);
  return (
    <PromptStage>
      <FollowUpPromptBox
        attachments={attachmentsBase}
        banner={banner}
        composer={{
          history: {
            currentDraft: { text: message, attachments: [] },
            entries: historyEntries,
            onSelectEntry: noop,
          },
          isFollowUpSubmitting,
          message,
          onChangeMessage: setMessage,
          onSubmit: noop,
          promptPlaceholder,
          submitMode,
          threadRuntimeDisplayStatus,
        }}
        environmentSummary={environmentSummary}
        contextWindowUsage={contextWindowUsage}
        execution={baseExecution}
        permission={basePermission}
        mentions={mentionsBase}
        queue={queue}
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
        hint="two follow-ups already queued behind the active turn"
      >
        <Row
          submitMode={{ kind: "queue", onStop: noop }}
          threadRuntimeDisplayStatus="active"
          queue={{ ...emptyQueue, queuedMessages }}
          contextWindowUsage={usage}
        />
      </StoryRow>
      <StoryRow label="with promptbox context banner">
        <Row
          submitMode={{ kind: "ready" }}
          banner={bannerWithChanges}
        />
      </StoryRow>
      <StoryRow
        label="sandbox environment"
        hint="environment summary uses Container icon, no branch"
      >
        <Row
          submitMode={{ kind: "ready" }}
          environmentSummary={sandboxEnvironmentSummary}
        />
      </StoryRow>
      <StoryRow
        label="no environment summary"
        hint="environmentSummary={null} hides the strip"
      >
        <Row
          submitMode={{ kind: "ready" }}
          environmentSummary={null}
        />
      </StoryRow>
    </StoryCard>
  );
}
