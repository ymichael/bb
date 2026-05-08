import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import {
  isGitHubRepoProjectSource,
  type Host,
  type ProjectSource,
  type SandboxBackendInfo,
} from "@bb/domain";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type MentionsConfig,
  type PromptBoxHandle,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { BranchPicker } from "@/components/pickers/BranchPicker";
import {
  EnvironmentPickerUI,
  parseEnvironmentValue,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import {
  useProjectGithubBranches,
  useProjectSourceBranches,
} from "@/hooks/queries/project-queries";
import { useSandboxBackends } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { sandboxHostSupportedAtom } from "@/lib/system-config-atoms";

export interface NewThreadEnvironmentConfig {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
  hosts: readonly Host[];
  sandboxBackends: readonly SandboxBackendInfo[];
  sandboxHostSupported: boolean;
  isLocalHost: EnvironmentPickerUIProps["isLocalHost"];
}

export interface NewThreadBranchConfig {
  value: string;
  isNew: boolean;
  options: readonly string[];
  loading?: boolean;
  onChange: (value: string) => void;
  /**
   * When provided, the picker exposes a "Create new branch" item. Only set
   * for `host:local` (work locally / remotely) — managed-worktree and sandbox
   * select an existing branch to use as the merge base.
   */
  onCreate?: () => void;
}

export interface NewThreadPromptBoxUIProps {
  /** id forwarded to the underlying PromptBoxInternal (used for autofocus targeting). */
  id?: string;

  // PromptBox passthrough
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  disabled: boolean;
  /** zenMode storage key used for the project-main zen-mode atom. */
  zenModeStorageKey: string;

  history: HistoryConfig;
  mentions: MentionsConfig;
  attachments: AttachmentsConfig;

  // Execution + environment + permission strip
  execution: ExecutionControlsProps;
  environment: NewThreadEnvironmentConfig;
  branch: NewThreadBranchConfig;
  permission: ExecutionPermissionConfig;
}

/**
 * Prop-only variant. Stories render this directly with mock host data; the
 * connected NewThreadPromptBox below wires up the real hooks.
 */
export function NewThreadPromptBoxUI({
  id,
  value,
  onChange,
  onSubmit,
  isSubmitting,
  disabled,
  zenModeStorageKey,
  history,
  mentions,
  attachments,
  execution,
  environment,
  branch,
  permission,
}: NewThreadPromptBoxUIProps) {
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const voice = usePromptVoice(promptBoxRef);
  const parsedEnvironment = parseEnvironmentValue(environment.value);
  const showBranchPicker =
    parsedEnvironment?.type === "host" ||
    (parsedEnvironment?.type === "sandbox" &&
      environment.sources.some(isGitHubRepoProjectSource));
  return (
    <>
      <PromptBoxInternal
        id={id}
        promptBoxRef={promptBoxRef}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        history={history}
        mentions={mentions}
        mentionMenuPlacement="bottom"
        attachments={attachments}
        voice={voice}
        submission={{
          isSubmitting,
          disabled,
          title: isSubmitting ? "Submitting..." : "Submit (Enter)",
        }}
        zenMode={{
          layout: "project-main",
          storageKey: zenModeStorageKey,
        }}
        footerStart={<ExecutionControls {...execution} />}
      />
      <div className="flex items-center justify-between gap-2 px-3.5">
        <div className="flex min-w-0 items-center gap-1">
          <EnvironmentPickerUI
            value={environment.value}
            onChange={environment.onChange}
            projectId={environment.projectId}
            sources={environment.sources}
            hosts={environment.hosts}
            sandboxBackends={environment.sandboxBackends}
            sandboxHostSupported={environment.sandboxHostSupported}
            isLocalHost={environment.isLocalHost}
            muted
          />
          {showBranchPicker ? (
            <BranchPicker
              variant="option"
              muted
              value={branch.value}
              isCreatingNew={branch.isNew}
              options={branch.options}
              loading={branch.loading}
              onChange={branch.onChange}
              onCreate={branch.onCreate}
            />
          ) : null}
        </div>
        <PermissionModePicker
          value={permission.value}
          options={permission.options}
          onChange={permission.onChange}
          supported={permission.supported}
        />
      </div>
    </>
  );
}

export interface NewThreadConnectedEnvironmentConfig {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
}

export interface NewThreadConnectedBranchConfig {
  value: string;
  isNew: boolean;
  onChange: (value: string) => void;
  onCreate: () => void;
}

export interface NewThreadPromptBoxProps
  extends Omit<NewThreadPromptBoxUIProps, "environment" | "branch"> {
  environment: NewThreadConnectedEnvironmentConfig;
  branch: NewThreadConnectedBranchConfig;
}

/**
 * The composed prompt area for creating a new thread in a project — used by
 * ProjectMainView. Wires the host/sandbox queries that feed the environment
 * picker, then forwards everything to NewThreadPromptBoxUI.
 */
export function NewThreadPromptBox({
  environment,
  branch,
  ...rest
}: NewThreadPromptBoxProps) {
  const { isLocalHost } = useHostDaemon();
  const { data: hosts = [] } = useEffectiveHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: sandboxBackends = [] } =
    useSandboxBackends(sandboxHostSupported);

  const parsedEnvironment = parseEnvironmentValue(environment.value);
  const isHostMode = parsedEnvironment?.type === "host";
  const isSandboxMode = parsedEnvironment?.type === "sandbox";
  const hostBranchesQuery = useProjectSourceBranches(
    environment.projectId ?? undefined,
    isHostMode ? parsedEnvironment.hostId : null,
  );
  const githubBranchesQuery = useProjectGithubBranches(
    environment.projectId ?? undefined,
    { enabled: isSandboxMode },
  );
  const activeBranchesQuery = isSandboxMode
    ? githubBranchesQuery
    : hostBranchesQuery;
  // Source key the auto-default tracks. For host mode we re-sync when the
  // user flips host; for sandbox mode the project pins it (one github source
  // per project).
  const branchSourceKey = isHostMode
    ? `host|${parsedEnvironment.hostId}`
    : isSandboxMode
      ? "sandbox"
      : null;

  // Auto-default the picker to the source's current branch the first time we
  // see a current for a given (project, source-key) pair. Tracking via ref
  // means the user's manual pick survives subsequent flips back to a source
  // we've already synced.
  const lastSyncedBranchKeyRef = useRef<string | null>(null);
  const onBranchChange = branch.onChange;
  const branchesCurrent = activeBranchesQuery.data?.current ?? null;
  useEffect(() => {
    if (!environment.projectId || !branchSourceKey || !branchesCurrent) return;
    const key = `${environment.projectId}|${branchSourceKey}`;
    if (lastSyncedBranchKeyRef.current === key) return;
    lastSyncedBranchKeyRef.current = key;
    onBranchChange(branchesCurrent);
  }, [
    environment.projectId,
    branchSourceKey,
    branchesCurrent,
    onBranchChange,
  ]);

  // Create-new-branch is only meaningful for host:local (work locally /
  // remotely) — the server checks out a fresh branch in the primary checkout
  // before the thread starts. Worktree/sandbox env modes use the picked
  // branch as a merge base instead, so we omit onCreate there.
  const allowCreate = isHostMode && parsedEnvironment.mode === "local";

  return (
    <NewThreadPromptBoxUI
      {...rest}
      environment={{
        ...environment,
        hosts,
        sandboxBackends,
        sandboxHostSupported,
        isLocalHost,
      }}
      branch={{
        value: branch.value,
        // isNew is only meaningful when create-new is allowed; suppress
        // stale state when the user flips to a mode that uses baseBranch.
        isNew: allowCreate && branch.isNew,
        options: activeBranchesQuery.data?.branches ?? [],
        loading: activeBranchesQuery.isLoading,
        onChange: branch.onChange,
        ...(allowCreate ? { onCreate: branch.onCreate } : {}),
      }}
    />
  );
}
