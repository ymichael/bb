import { useAtomValue } from "jotai";
import { useRef } from "react";
import type { Host, ProjectSource, SandboxBackendInfo } from "@bb/domain";
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
import {
  EnvironmentPickerUI,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import { useSandboxBackends } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { sandboxHostSupportedAtom } from "@/lib/atoms";

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
  permission,
}: NewThreadPromptBoxUIProps) {
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const voice = usePromptVoice(promptBoxRef);
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

export interface NewThreadPromptBoxProps
  extends Omit<NewThreadPromptBoxUIProps, "environment"> {
  environment: NewThreadConnectedEnvironmentConfig;
}

/**
 * The composed prompt area for creating a new thread in a project — used by
 * ProjectMainView. Wires the host/sandbox queries that feed the environment
 * picker, then forwards everything to NewThreadPromptBoxUI.
 */
export function NewThreadPromptBox({
  environment,
  ...rest
}: NewThreadPromptBoxProps) {
  const { isLocalHost } = useHostDaemon();
  const { data: hosts = [] } = useEffectiveHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: sandboxBackends = [] } =
    useSandboxBackends(sandboxHostSupported);

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
    />
  );
}
