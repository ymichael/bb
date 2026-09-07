import {
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { Host, ProjectSource, PromptTextMention } from "@bb/domain";
import type { ComposerView } from "@get-bb/plugin-sdk";
import type { ComposerTextEffectSource } from "@/lib/composer-text-effects";
import { ComposerBannersSlot } from "@/components/plugin/PluginComposerBanners";
import { PROMPT_STACK_TRACK_CLASS } from "@/components/promptbox/banner/PromptStackCard";
import {
  type PluginComposerHost,
  usePluginComposerViewModel,
} from "@/components/plugin/plugin-composer-host";
import {
  ComposerExtensionHost,
  useComposerExtensionController,
} from "@/components/plugin/ComposerExtensionHost";
import {
  ExecutionControls,
  type ExecutionControlsProps,
  type ExecutionPermissionConfig,
} from "@/components/promptbox/ExecutionControls";
import {
  PromptBoxInternal,
  type AttachmentsConfig,
  type HistoryConfig,
  type PromptBoxAction,
  type PromptBoxHandle,
  type TypeaheadConfig,
} from "@/components/promptbox/PromptBoxInternal";
import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import {
  BranchPicker,
  type BranchPickerMenuKind,
} from "@/components/pickers/BranchPicker";
import {
  EnvironmentPickerUI,
  type EnvironmentPickerMachines,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { MachinePickerUI } from "@/components/pickers/MachinePicker";
import {
  encodeHostValue,
  type ParsedEnvironmentValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ProjectSelector,
  type ProjectSelectorCreateProjectConfig,
  type ProjectSelectorOption,
} from "@/components/pickers/ProjectSelector";
import {
  WorktreePicker,
  type ReuseThreadOption,
} from "@/components/pickers/WorktreePicker";
import { selectPrimaryHost, useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import {
  isPlanModePrompt,
  permissionDisplayForPromptMode,
} from "@bb/client-core";

const NEW_THREAD_PROMPT_BOX_MIN_HEIGHT = 80;
const DEFAULT_NEW_THREAD_COMPOSER_SCOPE = {
  kind: "new-thread",
  projectId: null,
} as const;

export interface NewThreadEnvironmentConfig {
  value: string;
  onChange: (value: string) => void;
  sources: readonly ProjectSource[];
  host: EnvironmentPickerUIProps["host"];
  isLocal: EnvironmentPickerUIProps["isLocal"];
  machines?: EnvironmentPickerMachines | null;
  onRequestMachineSetup?: (host: Host) => void;
  reuseDisabled?: boolean;
  worktreeDisabledReason?: string | null;
  disabled?: boolean;
}

export interface NewThreadBranchConfig {
  value: string | null;
  currentBranch?: string | null;
  isNew: boolean;
  hidden?: boolean;
  options: readonly string[];
  remoteOptions?: readonly string[];
  loading?: boolean;
  placeholder?: string;
  triggerLabel?: string;
  triggerTitle?: string;
  currentOptionLabel?: string | null;
  currentOptionTitle?: string;
  optionDisabledReason?: string | null;
  optionDisabledTitle?: string;
  createDisabledReason?: string | null;
  createDisabledTitle?: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  onOpenChange?: (open: boolean) => void;
  onSearchQueryChange?: (query: string) => void;
  onCreateBaseChange?: (value: string) => void;
  disabled?: boolean;
  onCreate?: () => void;
}

export interface NewThreadWorktreeConfig {
  options: readonly ReuseThreadOption[];
  value: string | null;
  onChange: (environmentId: string) => void;
  disabled?: boolean;
}

export interface NewThreadProjectConfig {
  projects: readonly ProjectSelectorOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  disabled?: boolean;
  isLoading?: boolean;
  showChevronWhenDisabled?: boolean;
}

export interface NewThreadModeConfig {
  environment: NewThreadEnvironmentConfig;
  branch: NewThreadBranchConfig;
  worktree: NewThreadWorktreeConfig;
  permission: ExecutionPermissionConfig;
  banner?: ReactNode;
  header?: ReactNode;
}

interface NewThreadPromptBoxUIProps {
  id?: string;

  value: string;
  mentionRanges: readonly PromptTextMention[];
  onChange: (value: string, mentionRanges: PromptTextMention[]) => void;
  onSubmit: () => void;
  promptBoxRef?: Ref<PromptBoxHandle>;
  isSubmitting: boolean;
  disabled: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  allowSoftKeyboardAutoFocus?: boolean;
  pluginComposerHost?: PluginComposerHost | null;
  textEffects?: readonly ComposerTextEffectSource[];
  placeholder?: string;

  history: HistoryConfig;
  typeahead: TypeaheadConfig;
  attachments: AttachmentsConfig;
  promptActions?: readonly PromptBoxAction[];

  modeConfig: NewThreadModeConfig;

  project?: NewThreadProjectConfig;
  execution: ExecutionControlsProps;
}

interface GetBranchPickerMenuKindArgs {
  parsedEnvironment: ParsedEnvironmentValue;
}

function getBranchPickerMenuKind({
  parsedEnvironment,
}: GetBranchPickerMenuKindArgs): BranchPickerMenuKind | undefined {
  if (parsedEnvironment?.type !== "host") {
    return undefined;
  }

  return parsedEnvironment.mode === "worktree" ? "base" : "checkout";
}

function getNewThreadPromptPlaceholder(isProjectless: boolean): string {
  return isProjectless
    ? "Ask anything."
    : "Ask anything. @ to mention files, folders, or sections";
}

export const NewThreadPromptBoxUI = memo(function NewThreadPromptBoxUI({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit,
  promptBoxRef: externalPromptBoxRef,
  isSubmitting,
  disabled,
  disabledReason,
  autoFocus,
  allowSoftKeyboardAutoFocus,
  pluginComposerHost,
  textEffects,
  placeholder: placeholderOverride,
  history,
  typeahead,
  attachments,
  promptActions,
  modeConfig,
  project,
  execution,
}: NewThreadPromptBoxUIProps) {
  const promptBoxRef = useRef<PromptBoxHandle>(null);
  const isFocusedPane = useOptionalPaneContext()?.isFocused ?? true;
  const focusDefault = useCallback(() => {
    promptBoxRef.current?.focusEnd();
    return promptBoxRef.current !== null;
  }, []);
  useImperativeHandle(
    externalPromptBoxRef,
    () => ({
      captureHeightForLayoutChange: () => {
        promptBoxRef.current?.captureHeightForLayoutChange();
      },
      focusEnd: () => {
        promptBoxRef.current?.focusEnd();
      },
      insertTextAtCursor: (text) => {
        promptBoxRef.current?.insertTextAtCursor(text);
      },
      getTextBeforeCursor: () => promptBoxRef.current?.getTextBeforeCursor(),
      playVoiceCompletionTransition: () =>
        promptBoxRef.current?.playVoiceCompletionTransition() ??
        Promise.resolve(),
    }),
    [],
  );
  const voice = usePromptVoice(promptBoxRef);
  const attachmentCount = attachments.items?.length ?? 0;
  const [composerLayout, setComposerLayout] =
    useState<ComposerView["layout"]>("expanded");
  const composerView = usePluginComposerViewModel({
    scope: pluginComposerHost?.scope ?? DEFAULT_NEW_THREAD_COMPOSER_SCOPE,
    layout: composerLayout,
    text: value,
    attachmentCount,
    isRunning: false,
    isSubmitting,
  });
  const controller = useComposerExtensionController({
    host: pluginComposerHost ?? null,
    view: composerView,
    isFocused: isFocusedPane,
    isPrimary: true,
    focusDefault,
  });

  return (
    <ComposerExtensionHost
      controller={controller}
      defaultRenderer={
        <DefaultNewThreadComposer
          id={id}
          value={value}
          mentionRanges={mentionRanges}
          onChange={onChange}
          onSubmit={onSubmit}
          promptBoxRef={promptBoxRef}
          isSubmitting={isSubmitting}
          disabled={disabled}
          disabledReason={disabledReason}
          autoFocus={autoFocus}
          allowSoftKeyboardAutoFocus={allowSoftKeyboardAutoFocus}
          textEffects={textEffects}
          placeholder={placeholderOverride}
          history={history}
          typeahead={typeahead}
          attachments={attachments}
          promptActions={promptActions}
          modeConfig={modeConfig}
          project={project}
          execution={execution}
          voice={voice}
          onComposerLayoutChange={setComposerLayout}
        />
      }
    />
  );
});

interface DefaultNewThreadComposerProps extends Omit<
  NewThreadPromptBoxUIProps,
  "promptBoxRef" | "pluginComposerHost"
> {
  promptBoxRef: RefObject<PromptBoxHandle | null>;
  voice: ReturnType<typeof usePromptVoice>;
  onComposerLayoutChange: (layout: ComposerView["layout"]) => void;
}

const DefaultNewThreadComposer = memo(function DefaultNewThreadComposer({
  id,
  value,
  mentionRanges,
  onChange,
  onSubmit,
  promptBoxRef,
  isSubmitting,
  disabled,
  disabledReason,
  autoFocus,
  allowSoftKeyboardAutoFocus,
  textEffects,
  placeholder: placeholderOverride,
  history,
  typeahead,
  attachments,
  promptActions,
  modeConfig,
  project,
  execution,
  voice,
  onComposerLayoutChange,
}: DefaultNewThreadComposerProps) {
  const isProjectlessPrompt = project?.value === null;
  const placeholder =
    placeholderOverride ?? getNewThreadPromptPlaceholder(isProjectlessPrompt);
  const selectedProviderPlanModeCopy = execution.provider.options?.find(
    (option) => option.value === execution.provider.selectedId,
  )?.planModeCopy;
  const promptModeInput = useMemo(
    () => ({
      planModeCopy: selectedProviderPlanModeCopy,
      value,
      mentionRanges,
    }),
    [selectedProviderPlanModeCopy, mentionRanges, value],
  );
  const permissionDisplayOverride = useMemo(
    () => permissionDisplayForPromptMode(promptModeInput),
    [promptModeInput],
  );
  const permissionPickerDisabledByPlanMode = isPlanModePrompt(promptModeInput);
  const submitTitle = isSubmitting
    ? "Submitting..."
    : execution.model.isLoading
      ? "Loading models..."
      : "Submit (Enter)";

  return (
    <div
      data-app-composer=""
      data-app-composer-role="primary"
      data-promptbox-shell=""
      className="w-full"
    >
      <div
        className={`mb-2 grid gap-2 empty:hidden ${PROMPT_STACK_TRACK_CLASS}`}
      >
        <ComposerBannersSlot ownerPlacement="before">
          {modeConfig.banner}
        </ComposerBannersSlot>
      </div>
      <PromptBoxInternal
        id={id}
        promptBoxRef={promptBoxRef}
        value={value}
        mentionRanges={mentionRanges}
        onChange={onChange}
        onSubmit={onSubmit}
        textEffects={textEffects}
        onComposerLayoutChange={onComposerLayoutChange}
        history={history}
        typeahead={typeahead}
        mentionMenuPlacement="bottom"
        attachments={attachments}
        promptActions={promptActions}
        voice={voice}
        submission={{
          isSubmitting,
          disabled,
          disabledReason,
          title: submitTitle,
        }}
        autoFocus={autoFocus}
        allowSoftKeyboardAutoFocus={allowSoftKeyboardAutoFocus}
        editorLayout="root-compose"
        minHeight={NEW_THREAD_PROMPT_BOX_MIN_HEIGHT}
        placeholder={placeholder}
        header={modeConfig.header}
        footerStart={<ExecutionControls {...execution} />}
      />
      {}
      <div className="mt-1 flex select-none items-center justify-between gap-2 px-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {project ? (
            <ProjectSelector
              projects={project.projects}
              value={project.value}
              onChange={project.onChange}
              allowNoProject={project.allowNoProject ?? false}
              createProject={project.createProject}
              disabled={project.disabled}
              isLoading={project.isLoading}
              showChevronWhenDisabled={project.showChevronWhenDisabled}
              className="shrink-0"
            />
          ) : null}
          {project?.value !== null ? (
            <ThreadEnvSlot
              environment={modeConfig.environment}
              branch={modeConfig.branch}
              worktree={modeConfig.worktree}
            />
          ) : (
            <ProjectlessMachineSlot environment={modeConfig.environment} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PermissionModePicker
            value={modeConfig.permission.value}
            options={modeConfig.permission.options}
            onChange={modeConfig.permission.onChange}
            supported={modeConfig.permission.supported}
            disabled={permissionPickerDisabledByPlanMode}
            showChevronWhenDisabled={permissionPickerDisabledByPlanMode}
            displayOverride={permissionDisplayOverride}
          />
        </div>
      </div>
    </div>
  );
});

interface ThreadEnvSlotProps {
  environment: NewThreadEnvironmentConfig;
  branch: NewThreadBranchConfig;
  worktree: NewThreadWorktreeConfig;
}

export function ThreadEnvSlot({
  environment,
  branch,
  worktree,
}: ThreadEnvSlotProps) {
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(environment.value),
    [environment.value],
  );
  const branchMenuKind = getBranchPickerMenuKind({ parsedEnvironment });
  const showBranchPicker =
    parsedEnvironment?.type === "host" && branch.hidden !== true;
  const showWorktreePicker = parsedEnvironment?.type === "reuse";
  return (
    <>
      <EnvironmentPickerUI
        value={environment.value}
        onChange={environment.onChange}
        sources={environment.sources}
        host={environment.host}
        isLocal={environment.isLocal}
        machines={environment.machines}
        onRequestMachineSetup={environment.onRequestMachineSetup}
        reuseDisabled={environment.reuseDisabled}
        worktreeDisabledReason={environment.worktreeDisabledReason}
        disabled={environment.disabled}
        className="shrink-0"
        muted
      />
      {showBranchPicker ? (
        <BranchPicker
          variant="option"
          muted
          value={branch.value}
          isCreatingNew={branch.isNew}
          options={branch.options}
          remoteOptions={branch.remoteOptions}
          loading={branch.loading}
          placeholder={branch.placeholder}
          triggerLabel={branch.triggerLabel}
          triggerTitle={branch.triggerTitle}
          menuKind={branchMenuKind}
          currentOptionLabel={branch.currentOptionLabel}
          currentOptionTitle={branch.currentOptionTitle}
          optionDisabledReason={branch.optionDisabledReason}
          optionDisabledTitle={branch.optionDisabledTitle}
          createDisabledReason={branch.createDisabledReason}
          createDisabledTitle={branch.createDisabledTitle}
          disabled={branch.disabled}
          onChange={branch.onChange}
          onClear={branch.onClear}
          onOpenChange={branch.onOpenChange}
          onSearchQueryChange={branch.onSearchQueryChange}
          onCreateBaseChange={branch.onCreateBaseChange}
          onCreate={branch.onCreate}
        />
      ) : null}
      {showWorktreePicker ? (
        <WorktreePicker
          muted
          options={worktree.options}
          value={worktree.value}
          onChange={worktree.onChange}
          disabled={worktree.disabled}
        />
      ) : null}
    </>
  );
}

interface ProjectlessMachineSlotProps {
  environment: NewThreadEnvironmentConfig;
}

export function ProjectlessMachineSlot({
  environment,
}: ProjectlessMachineSlotProps) {
  const machines = environment.machines ?? null;
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(environment.value),
    [environment.value],
  );
  const handleChange = environment.onChange;
  const handleMachineChange = useCallback(
    (hostId: string) => {
      handleChange(encodeHostValue(hostId, "local"));
    },
    [handleChange],
  );
  if (!machines || machines.hosts.length <= 1) {
    return null;
  }
  return (
    <MachinePickerUI
      hosts={machines.hosts}
      localDaemonHostId={machines.localDaemonHostId}
      primaryHostId={machines.primaryHostId}
      selectedHostId={
        parsedEnvironment?.type === "host" ? parsedEnvironment.hostId : null
      }
      onChange={handleMachineChange}
      disabled={environment.disabled}
      className="shrink-0"
      muted
    />
  );
}

type NewThreadConnectedEnvironmentConfig = Omit<
  NewThreadEnvironmentConfig,
  "host" | "isLocal" | "machines"
>;

type NewThreadConnectedBranchConfig = Omit<
  NewThreadBranchConfig,
  "onCreate"
> & {
  onCreate: () => void;
};

interface NewThreadConnectedModeConfig {
  environment: NewThreadConnectedEnvironmentConfig;
  branch: NewThreadConnectedBranchConfig;
  worktree: NewThreadWorktreeConfig;
  permission: ExecutionPermissionConfig;
  banner?: ReactNode;
  header?: ReactNode;
}

export interface NewThreadPromptBoxProps extends Omit<
  NewThreadPromptBoxUIProps,
  "modeConfig"
> {
  modeConfig: NewThreadConnectedModeConfig;
}

export function NewThreadPromptBox({
  modeConfig: threadConfig,
  ...rest
}: NewThreadPromptBoxProps) {
  const { data: hosts } = useHosts();
  const systemConfigQuery = useSystemConfig();
  const primaryHostId = systemConfigQuery.data?.primaryHostId ?? null;
  const primaryHost = useMemo(
    () => selectPrimaryHost(hosts, primaryHostId),
    [hosts, primaryHostId],
  );
  const { isLocalDaemonHost, localDaemonHostId } = useHostDaemon();

  const parsedEnvironment = parseEnvironmentValue(
    threadConfig.environment.value,
  );
  const selectedHost =
    parsedEnvironment?.type === "host"
      ? (hosts?.find((host) => host.id === parsedEnvironment.hostId) ??
        primaryHost)
      : primaryHost;
  const isLocalHost = selectedHost ? isLocalDaemonHost(selectedHost.id) : false;
  const machines = useMemo<EnvironmentPickerMachines | null>(
    () => (hosts ? { hosts, localDaemonHostId, primaryHostId } : null),
    [hosts, localDaemonHostId, primaryHostId],
  );

  const isHostMode = parsedEnvironment?.type === "host";
  const allowCreate = isHostMode && parsedEnvironment.mode === "local";

  const uiEnvironment = useMemo(
    () => ({
      ...threadConfig.environment,
      host: selectedHost,
      isLocal: isLocalHost,
      machines,
    }),
    [threadConfig.environment, selectedHost, isLocalHost, machines],
  );
  const uiBranch = useMemo<NewThreadBranchConfig>(() => {
    const branch = threadConfig.branch;
    return {
      ...branch,
      isNew: allowCreate && branch.isNew,
      onCreate: allowCreate ? branch.onCreate : undefined,
    };
  }, [allowCreate, threadConfig.branch]);

  return (
    <NewThreadPromptBoxUI
      {...rest}
      modeConfig={{
        environment: uiEnvironment,
        branch: uiBranch,
        worktree: threadConfig.worktree,
        permission: threadConfig.permission,
        banner: threadConfig.banner,
        header: threadConfig.header,
      }}
    />
  );
}
