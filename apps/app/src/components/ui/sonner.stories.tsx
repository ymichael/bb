import { appToast, AppToastContent, type AppToastTone } from "./app-toast";
import { AppToastCommitDescription } from "./app-toast-descriptions";
import { ArchivedThreadToastDescription } from "../thread/ArchivedThreadToastDescription";
import { pluginNotificationDescription } from "../plugin/PluginNotificationDescription";
import { Button } from "@bb/shared-ui/button";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { useState, type ReactNode } from "react";
import { toast as sonnerToast } from "sonner";

export default {
  title: "Toasts",
};

type ToastTone = AppToastTone;

interface ToastExample {
  id: string;
  group: string;
  label: string;
  source: string;
  usage: readonly string[];
  current: CurrentToast;
}

interface CurrentToast {
  title: ReactNode;
  description?: ReactNode;
  dismissible?: boolean;
  tone: ToastTone;
  primaryAction?: () => void;
  primaryActionLabel?: string;
  secondaryAction?: () => void;
  secondaryActionLabel?: string;
}

interface CurrentToastPreviewProps {
  onDismiss?: () => void;
  toast: CurrentToast;
}

interface ToastRowHintProps {
  example: ToastExample;
}

interface ToastUsageHintProps {
  usage: readonly string[];
}

interface GitSuccessDescriptionParams {
  commitSha: string;
  commitSubject: string;
}

const LIVE_TOAST_DURATION = Infinity;
const GIT_SUCCESS_COMMIT_SHA = "e547e81c0ffee1234567890abcdef123456789";
const GIT_SUCCESS_COMMIT_SUBJECT = "Update provider CLI health toasts";

function gitSuccessDescription({
  commitSha,
  commitSubject,
}: GitSuccessDescriptionParams): ReactNode {
  return (
    <AppToastCommitDescription
      commitSha={commitSha}
      commitSubject={commitSubject}
    />
  );
}

const TOAST_EXAMPLES: readonly ToastExample[] = [
  {
    id: "provider-queued",
    group: "Provider CLI",
    label: "setup queued",
    source: "useProviderCliInstallRunner",
    usage: ["Click Install/Update while another setup is running"],
    current: {
      tone: "message",
      title: "Claude Code update queued",
      description: "Starts after the current update.",
    },
  },
  {
    id: "provider-up-to-date",
    group: "Provider CLI",
    label: "provider success",
    source: "useProviderCliInstallRunner",
    usage: ["Provider CLI install/update succeeds"],
    current: {
      tone: "success",
      title: "Codex is up to date",
    },
  },
  {
    id: "provider-update-failed",
    group: "Provider CLI",
    label: "provider update failed",
    source: "useProviderCliInstallRunner",
    usage: [
      "Provider CLI install/update fails",
      "View log opens the command output dialog",
    ],
    current: {
      tone: "error",
      title: "Codex update failed",
      description: "Command exited with code 1",
      primaryActionLabel: "View log",
    },
  },
  {
    id: "plugin-update-failed",
    group: "Plugin management",
    label: "update failed",
    source: "UpdatePluginDialog / PluginUpdatesCard",
    usage: [
      "Plugin update fails",
      "Plugin name opens its installed detail page",
    ],
    current: {
      tone: "error",
      title: "Plugin update failed",
      description: pluginNotificationDescription(
        { id: "usage", name: "Usage" },
        "installed",
        "bb connect: timed out waiting for the tunnel client.",
      ),
    },
  },
  {
    id: "plugin-updated",
    group: "Plugin management",
    label: "update success",
    source: "UpdatePluginDialog / PluginUpdatesCard",
    usage: [
      "Plugin update succeeds",
      "Plugin name opens its installed detail page",
    ],
    current: {
      tone: "success",
      title: "Plugin updated",
      description: pluginNotificationDescription(
        { id: "usage", name: "Usage" },
        "installed",
        "Now running 1.4.0.",
      ),
    },
  },
  {
    id: "plugin-installed",
    group: "Plugin management",
    label: "install success",
    source: "AddPluginDialog",
    usage: [
      "Plugin install succeeds",
      "Plugin name opens its installed detail page",
    ],
    current: {
      tone: "success",
      title: "Plugin installed",
      description: pluginNotificationDescription(
        { id: "linear", name: "Linear" },
        "installed",
      ),
    },
  },
  {
    id: "git-loading",
    group: "Git actions",
    label: "git loading",
    source: "useThreadGitActions",
    usage: ["Click Commit in thread header", "Replaced by success/error"],
    current: {
      tone: "loading",
      title: "Creating commit",
    },
  },
  {
    id: "git-commit-success",
    group: "Git actions",
    label: "commit success",
    source: "useThreadGitActions",
    usage: ["Commit action succeeds"],
    current: {
      tone: "success",
      title: "Commit created",
      description: gitSuccessDescription({
        commitSha: GIT_SUCCESS_COMMIT_SHA,
        commitSubject: GIT_SUCCESS_COMMIT_SUBJECT,
      }),
    },
  },
  {
    id: "git-error",
    group: "Git actions",
    label: "git error",
    source: "useThreadGitActions",
    usage: ["Thread git action fails"],
    current: {
      tone: "error",
      title: "Commit failed",
      description: "Command exited with code 1",
    },
  },
  {
    id: "archive-thread",
    group: "Thread actions",
    label: "archive success",
    source: "ThreadActionsProvider",
    usage: ["Thread archive succeeds", "Thread name opens the archived thread"],
    current: {
      tone: "success",
      title: "Thread Archived",
      description: (
        <ArchivedThreadToastDescription
          archivedThreadCount={1}
          threadTitle="Audit recurring permission failures"
          onOpenThread={() => undefined}
        />
      ),
      secondaryActionLabel: "Undo",
    },
  },
  {
    id: "archive-thread-children",
    group: "Thread actions",
    label: "archive with children",
    source: "ThreadActionsProvider",
    usage: [
      "Archive includes child threads",
      "Long titles truncate to one line",
    ],
    current: {
      tone: "success",
      title: "Thread Archived",
      description: (
        <ArchivedThreadToastDescription
          archivedThreadCount={3}
          threadTitle="Investigate intermittent provider CLI health check timeouts on managed environments"
          onOpenThread={() => undefined}
        />
      ),
      secondaryActionLabel: "Undo",
    },
  },
  {
    id: "archive-worktree-group",
    group: "Thread actions",
    label: "archive worktree group",
    source: "ProjectRow",
    usage: ["Sidebar project row", "Archive worktree group succeeds"],
    current: {
      tone: "success",
      title: "Archived 3 threads",
    },
  },
  {
    id: "thread-action-error",
    group: "Thread actions",
    label: "thread action error",
    source: "ThreadActionsProvider",
    usage: ["Thread archive fails", "Title varies by thread type/error"],
    current: {
      tone: "error",
      title: "Failed to archive thread and children",
    },
  },
  {
    id: "prompt-send-error",
    group: "Prompt",
    label: "send message error",
    source: "ThreadDetailPromptArea",
    usage: ["Follow-up or steer send fails"],
    current: {
      tone: "error",
      title: "Failed to send message",
    },
  },
  {
    id: "queued-message-error",
    group: "Prompt",
    label: "queued message error",
    source: "ThreadDetailPromptArea",
    usage: ["Send queued message now fails", "Other queued actions differ"],
    current: {
      tone: "error",
      title: "Failed to send queued message",
    },
  },
  {
    id: "local-open-error",
    group: "Local files",
    label: "local open error",
    source: "useLocalOpenTargets / ThreadDetailView",
    usage: [
      "Local/workspace/storage open fails",
      "Target, daemon, path, or storage missing",
    ],
    current: {
      tone: "error",
      title: "Failed to open file locally",
      description: "Thread storage path is not available yet.",
    },
  },
  {
    id: "opening-editor",
    group: "Local files",
    label: "opening editor",
    source: "GitDiffCard story",
    usage: ["Story-only GitDiffCard fixture", "Open in editor handler runs"],
    current: {
      tone: "message",
      title: "Opening in editor",
      description:
        "apps/app/src/components/settings/UpdatesSettingsSection.tsx",
    },
  },
  {
    id: "clipboard-success",
    group: "Clipboard",
    label: "copy success",
    source: "copyToClipboardWithToast",
    usage: ["Default helper success", "Often overridden or suppressed"],
    current: {
      tone: "success",
      title: "Copied",
    },
  },
  {
    id: "clipboard-error",
    group: "Clipboard",
    label: "copy error",
    source: "copyToClipboardWithToast",
    usage: [
      "Clipboard unavailable or write fails",
      "Default unless overridden",
    ],
    current: {
      tone: "error",
      title: "Failed to copy",
    },
  },
  {
    id: "mutation-error",
    group: "Mutation errors",
    label: "generic mutation error",
    source: "query-client / mutation-errors",
    usage: [
      "Global React Query mutation fallback",
      "No specific meta message",
      "Opt-out not set",
    ],
    current: {
      tone: "error",
      title: "Request failed",
      description: "Please try again",
    },
  },
  {
    id: "merge-base-error",
    group: "Merge base",
    label: "merge base error",
    source: "useEnvironmentMergeBase",
    usage: [
      "Merge-base update fails",
      "Provisioning not-ready suppressed",
      "Lifecycle warnings keep operation context",
    ],
    current: {
      tone: "warning",
      title: "Failed to update merge base",
      description: "Workspace is unavailable.",
    },
  },
];

function toastCatalogId(example: ToastExample): string {
  return `toast-catalog:${example.id}`;
}

function showToastExample(example: ToastExample): void {
  const id = toastCatalogId(example);
  const { current } = example;
  sonnerToast.custom(
    () => (
      <CurrentToastPreview
        toast={current}
        onDismiss={() => sonnerToast.dismiss(id)}
      />
    ),
    {
      className: "bb-app-toast",
      dismissible: current.dismissible ?? true,
      duration: LIVE_TOAST_DURATION,
      id,
    },
  );
}

function showAllToastExamples(): void {
  appToast.dismiss();
  for (const example of TOAST_EXAMPLES) {
    showToastExample(example);
  }
}

function CurrentToastPreview({ onDismiss, toast }: CurrentToastPreviewProps) {
  const [visible, setVisible] = useState(true);

  if (!visible) {
    return null;
  }

  const dismiss = () => {
    setVisible(false);
    onDismiss?.();
  };

  return (
    <AppToastContent
      action={
        toast.primaryActionLabel
          ? {
              label: toast.primaryActionLabel,
              onClick: () => {
                toast.primaryAction?.();
                dismiss();
              },
            }
          : undefined
      }
      cancel={
        toast.secondaryActionLabel
          ? {
              label: toast.secondaryActionLabel,
              onClick: () => {
                toast.secondaryAction?.();
                dismiss();
              },
            }
          : undefined
      }
      description={toast.description}
      dismissible={toast.dismissible}
      onDismiss={dismiss}
      title={toast.title}
      tone={toast.tone}
    />
  );
}

function ToastRowHint({ example }: ToastRowHintProps) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-2">
      <span>{example.source}</span>
      <ToastUsageHint usage={example.usage} />
      <Button
        variant="outline"
        size="sm"
        className="text-foreground"
        onClick={() => showToastExample(example)}
      >
        Show
      </Button>
    </span>
  );
}

function ToastUsageHint({ usage }: ToastUsageHintProps) {
  if (usage.length === 1) {
    return <span className="leading-4">{usage[0]}</span>;
  }

  return (
    <span className="flex min-w-0 flex-col gap-1 leading-4">
      {usage.map((item) => (
        <span
          key={item}
          className="relative pl-3 before:absolute before:left-0 before:top-1.5 before:size-1 before:rounded-full before:bg-muted-foreground/70"
        >
          {item}
        </span>
      ))}
    </span>
  );
}

export function Catalog() {
  return (
    <>
      <StoryCard labelWidth="260px">
        <StoryRow
          label="live controls"
          hint="Trigger the implemented appToast stack rendered by the Ladle provider."
        >
          <Button onClick={showAllToastExamples}>
            Trigger all live toasts
          </Button>
          <Button variant="outline" onClick={() => appToast.dismiss()}>
            Dismiss live toasts
          </Button>
        </StoryRow>
      </StoryCard>

      <StoryCard labelWidth="320px" className="items-start gap-y-6 py-5">
        {TOAST_EXAMPLES.map((example) => (
          <StoryRow
            key={example.id}
            label={`${example.group} / ${example.label}`}
            hint={<ToastRowHint example={example} />}
          >
            <CurrentToastPreview toast={example.current} />
          </StoryRow>
        ))}
      </StoryCard>
    </>
  );
}
