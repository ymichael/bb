import { useAtomValue } from "jotai";
import { useRef } from "react";
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
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
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
  value: string | null;
  isNew: boolean;
  options: readonly string[];
  loading?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
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
              placeholder={branch.placeholder}
              onChange={branch.onChange}
              onOpenChange={branch.onOpenChange}
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
  current: string | null;
  value: string | null;
  isNew: boolean;
  options: readonly string[];
  loading?: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  onCreate: () => void;
}

export interface NewThreadPromptBoxProps extends Omit<
  NewThreadPromptBoxUIProps,
  "environment" | "branch"
> {
  environment: NewThreadConnectedEnvironmentConfig;
  branch: NewThreadConnectedBranchConfig;
}

/**
 * The composed prompt area for creating a new thread in a project — used by
 * ProjectMainView. Wires the host/sandbox environment-picker queries, then
 * forwards everything to NewThreadPromptBoxUI.
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

  // Create-new-branch is only meaningful for host:local (work locally /
  // remotely) — the server checks out a fresh branch in the primary checkout
  // before the thread starts. Worktree/sandbox env modes use the picked
  // branch as a merge base instead, so we omit onCreate there.
  const allowCreate = isHostMode && parsedEnvironment.mode === "local";
  const branchPickerValue = branch.value ?? branch.current;
  const canCreate = allowCreate && branchPickerValue !== null;

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
        value: branchPickerValue,
        // isNew is only meaningful when create-new is allowed; suppress
        // stale state when the user flips to a mode that uses baseBranch.
        isNew: allowCreate && branch.isNew,
        options: branch.options,
        loading: branch.loading,
        placeholder: branch.placeholder,
        onChange: branch.onChange,
        onOpenChange: branch.onOpenChange,
        ...(canCreate ? { onCreate: branch.onCreate } : {}),
      }}
    />
  );
}
