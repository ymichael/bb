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
import type { SystemEnvironmentProvider } from "@bb/server-contract";
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
  EnvironmentPickerUI,
  type EnvironmentPickerMachines,
  type EnvironmentPickerUIProps,
} from "@/components/pickers/EnvironmentPicker";
import { MachinePickerUI } from "@/components/pickers/MachinePicker";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import {
  ProjectSelector,
  type ProjectSelectorCreateProjectConfig,
  type ProjectSelectorOption,
} from "@/components/pickers/ProjectSelector";
import {
  ReuseEnvironmentPicker,
  type ReuseThreadOption,
} from "@/components/pickers/ReuseEnvironmentPicker";
import {
  selectHosts,
  selectPrimaryHost,
  useHosts,
} from "@/hooks/queries/host-queries";
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
  disabled?: boolean;
  providers?: readonly SystemEnvironmentProvider[];
  providersByHostId?: EnvironmentPickerUIProps["providersByHostId"];
  selectedProviderHostId?: string | null;
  inputsControlProviderIds?: ReadonlySet<string>;
  onSelectProvider?: EnvironmentPickerUIProps["onSelectProvider"];
  machineProviders?: EnvironmentPickerUIProps["machineProviders"];
  selectedMachineProviderId?: string | null;
  machineInputsControlProviderIds?: ReadonlySet<string>;
  onSelectMachineProvider?: EnvironmentPickerUIProps["onSelectMachineProvider"];
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
  worktree: NewThreadWorktreeConfig;
  permission: ExecutionPermissionConfig;
  environmentProviderInputsSlot?: ReactNode;
  machineProviderInputsSlot?: ReactNode;
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
              worktree={modeConfig.worktree}
              environmentProviderInputsSlot={
                modeConfig.environmentProviderInputsSlot
              }
              machineProviderInputsSlot={modeConfig.machineProviderInputsSlot}
            />
          ) : (
            <ProjectlessEnvSlot
              environment={modeConfig.environment}
              worktree={modeConfig.worktree}
              environmentProviderInputsSlot={
                modeConfig.environmentProviderInputsSlot
              }
              machineProviderInputsSlot={modeConfig.machineProviderInputsSlot}
            />
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
  worktree: NewThreadWorktreeConfig;
  environmentProviderInputsSlot?: ReactNode;
  machineProviderInputsSlot?: ReactNode;
}

export function ThreadEnvSlot({
  environment,
  worktree,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
}: ThreadEnvSlotProps) {
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(environment.value),
    [environment.value],
  );
  const selectedProvider = useMemo(
    () =>
      parsedEnvironment?.type === "provider"
        ? environment.providers?.find(
            (provider) =>
              provider.id === parsedEnvironment.environmentProviderId,
          )
        : undefined,
    [environment.providers, parsedEnvironment],
  );
  const showReuseEnvironmentPicker = parsedEnvironment?.type === "reuse";
  return (
    <>
      <EnvironmentPickerUI
        value={environment.value}
        sources={environment.sources}
        host={environment.host}
        isLocal={environment.isLocal}
        machines={environment.machines}
        onRequestMachineSetup={environment.onRequestMachineSetup}
        disabled={environment.disabled}
        providers={environment.providers}
        providersByHostId={environment.providersByHostId}
        selectedProviderHostId={environment.selectedProviderHostId}
        inputsControlProviderIds={environment.inputsControlProviderIds}
        onSelectProvider={environment.onSelectProvider}
        machineProviders={environment.machineProviders}
        selectedMachineProviderId={environment.selectedMachineProviderId}
        machineInputsControlProviderIds={
          environment.machineInputsControlProviderIds
        }
        onSelectMachineProvider={environment.onSelectMachineProvider}
        className="shrink-0"
        muted
      />
      {showReuseEnvironmentPicker ? (
        <ReuseEnvironmentPicker
          muted
          options={worktree.options}
          value={worktree.value}
          onChange={worktree.onChange}
          disabled={worktree.disabled}
        />
      ) : null}
      {selectedProvider !== undefined && selectedProvider.inputs !== null
        ? environmentProviderInputsSlot
        : null}
      {environment.selectedMachineProviderId === undefined ||
      environment.selectedMachineProviderId === null
        ? null
        : machineProviderInputsSlot}
    </>
  );
}

interface ProjectlessEnvSlotProps {
  environment: NewThreadEnvironmentConfig;
  worktree: NewThreadWorktreeConfig;
  environmentProviderInputsSlot?: ReactNode;
  machineProviderInputsSlot?: ReactNode;
}

export function ProjectlessEnvSlot({
  environment,
  worktree,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
}: ProjectlessEnvSlotProps) {
  const providers = (environment.providers ?? []).filter(
    (provider) => provider.requires.projectless,
  );
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(environment.value),
    [environment.value],
  );
  const selectedProvider =
    parsedEnvironment?.type === "provider"
      ? providers.find(
          (provider) => provider.id === parsedEnvironment.environmentProviderId,
        )
      : undefined;
  const showReuseEnvironmentPicker = parsedEnvironment?.type === "reuse";

  if (providers.length <= 1 && !showReuseEnvironmentPicker) {
    return <ProjectlessMachineSlot environment={environment} />;
  }

  return (
    <>
      <EnvironmentPickerUI
        value={environment.value}
        projectless
        sources={environment.sources}
        host={environment.host}
        isLocal={environment.isLocal}
        machines={environment.machines}
        disabled={environment.disabled}
        providers={providers}
        providersByHostId={environment.providersByHostId}
        selectedProviderHostId={environment.selectedProviderHostId}
        inputsControlProviderIds={environment.inputsControlProviderIds}
        onSelectProvider={environment.onSelectProvider}
        machineProviders={environment.machineProviders}
        selectedMachineProviderId={environment.selectedMachineProviderId}
        machineInputsControlProviderIds={
          environment.machineInputsControlProviderIds
        }
        onSelectMachineProvider={environment.onSelectMachineProvider}
        className="shrink-0"
        muted
      />
      {showReuseEnvironmentPicker ? (
        <ReuseEnvironmentPicker
          muted
          options={worktree.options}
          value={worktree.value}
          onChange={worktree.onChange}
          disabled={worktree.disabled}
        />
      ) : null}
      {selectedProvider !== undefined && selectedProvider.inputs !== null
        ? environmentProviderInputsSlot
        : null}
      {environment.selectedMachineProviderId === undefined ||
      environment.selectedMachineProviderId === null
        ? null
        : machineProviderInputsSlot}
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
  const availableHosts = useMemo(
    () => selectHosts(machines?.hosts),
    [machines?.hosts],
  );
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(environment.value),
    [environment.value],
  );
  const selectedProvider =
    parsedEnvironment?.type === "provider"
      ? environment.providers?.find(
          (provider) => provider.id === parsedEnvironment.environmentProviderId,
        )
      : undefined;
  const handleSelectProvider = environment.onSelectProvider;
  const handleMachineChange = useCallback(
    (hostId: string) => {
      if (
        selectedProvider !== undefined &&
        handleSelectProvider !== undefined
      ) {
        handleSelectProvider(selectedProvider, hostId);
      }
    },
    [handleSelectProvider, selectedProvider],
  );
  if (!machines || availableHosts.length <= 1) {
    return null;
  }
  return (
    <MachinePickerUI
      hosts={availableHosts}
      localDaemonHostId={machines.localDaemonHostId}
      primaryHostId={machines.primaryHostId}
      selectedHostId={
        selectedProvider !== undefined
          ? (environment.selectedProviderHostId ?? null)
          : null
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

interface NewThreadConnectedModeConfig {
  environment: NewThreadConnectedEnvironmentConfig;
  worktree: NewThreadWorktreeConfig;
  permission: ExecutionPermissionConfig;
  environmentProviderInputsSlot?: ReactNode;
  machineProviderInputsSlot?: ReactNode;
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
  const availableHosts = useMemo(() => selectHosts(hosts), [hosts]);
  const primaryHost = useMemo(
    () => selectPrimaryHost(availableHosts, primaryHostId),
    [availableHosts, primaryHostId],
  );
  const { isLocalDaemonHost, localDaemonHostId } = useHostDaemon();

  const parsedEnvironment = parseEnvironmentValue(
    threadConfig.environment.value,
  );
  const selectedEnvironmentHostId =
    parsedEnvironment?.type === "provider"
      ? (threadConfig.environment.selectedProviderHostId ?? null)
      : null;
  const selectedHost =
    selectedEnvironmentHostId !== null
      ? (availableHosts.find((host) => host.id === selectedEnvironmentHostId) ??
        primaryHost)
      : primaryHost;
  const isLocalHost = selectedHost ? isLocalDaemonHost(selectedHost.id) : false;
  const machines = useMemo<EnvironmentPickerMachines | null>(
    () =>
      hosts
        ? { hosts: availableHosts, localDaemonHostId, primaryHostId }
        : null,
    [availableHosts, hosts, localDaemonHostId, primaryHostId],
  );

  const uiEnvironment = useMemo(
    () => ({
      ...threadConfig.environment,
      host: selectedHost,
      isLocal: isLocalHost,
      machines,
    }),
    [threadConfig.environment, selectedHost, isLocalHost, machines],
  );
  return (
    <NewThreadPromptBoxUI
      {...rest}
      modeConfig={{
        environment: uiEnvironment,
        worktree: threadConfig.worktree,
        permission: threadConfig.permission,
        environmentProviderInputsSlot:
          threadConfig.environmentProviderInputsSlot,
        machineProviderInputsSlot: threadConfig.machineProviderInputsSlot,
        banner: threadConfig.banner,
        header: threadConfig.header,
      }}
    />
  );
}
