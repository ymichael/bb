import type { ProjectSource } from "@bb/domain";
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
} from "@/components/promptbox/PromptBoxInternal";
import { EnvironmentPicker } from "@/components/pickers/EnvironmentPicker";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";

export interface NewThreadEnvironmentConfig {
  value: string;
  onChange: (value: string) => void;
  projectId: string | null;
  sources: readonly ProjectSource[];
}

export interface NewThreadPromptBoxProps {
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
 * The composed prompt area for creating a new thread in a project — used by
 * ProjectMainView. Wraps PromptBoxInternal + ExecutionControls (in
 * footerStart) plus an environment picker and permission-mode picker strip.
 */
export function NewThreadPromptBox({
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
}: NewThreadPromptBoxProps) {
  return (
    <>
      <PromptBoxInternal
        id={id}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        history={history}
        mentions={mentions}
        attachments={attachments}
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
        <EnvironmentPicker
          value={environment.value}
          onChange={environment.onChange}
          projectId={environment.projectId}
          sources={environment.sources}
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
