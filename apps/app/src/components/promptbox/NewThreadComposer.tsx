import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type EnvironmentMachineSelection,
  type Host,
  type JsonValue,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type {
  NewThreadRequest,
  PluginEnvironmentProviderInputsChange,
  PluginMachineProviderInputsChange,
} from "@get-bb/plugin-sdk";
import type {
  CreateExecutionInputSources,
  SidebarBootstrapResponse,
  SystemEnvironmentProvider,
  SystemMachineProvider,
  SystemExecutionOptionsModelLoadError,
} from "@bb/server-contract";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";
import {
  encodeReuseValue,
  encodeProviderValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { providerInputsControlRequired } from "@/components/pickers/environment-provider-inputs";
import { machineProviderInputsControlRequired } from "@/components/pickers/machine-provider-inputs";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import {
  NewThreadPromptBox,
  type NewThreadPromptBoxProps,
} from "@/components/promptbox/NewThreadPromptBox";
import { withAppPromptActions } from "@/components/promptbox/PromptBoxActionsMenu";
import {
  buildProviderPromptActionProps,
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
} from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { type PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { newThreadEnvironmentArgsToSeed } from "@/components/plugin/new-thread-environment-seed";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import {
  useSystemEnvironmentProviders,
  useSystemEnvironmentProvidersByHost,
} from "@/hooks/queries/environment-provider-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import {
  selectHosts,
  selectPrimaryHost,
  useHosts,
} from "@/hooks/queries/host-queries";
import { useProjectDefaultExecutionOptions } from "@/hooks/queries/project-default-execution-options-query";
import {
  stripProjectThreads,
  useProjectPromptHistory,
  useProjectSourceBranches,
  type SidebarProject,
} from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useCommandSuggestions } from "@/hooks/useCommandSuggestions";
import {
  usePromptDraftStorage,
  type PromptDraftScope,
} from "@/hooks/usePromptDraftStorage";
import { usePromptMentions } from "@/hooks/usePromptMentions";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { useComposerTextEffects } from "@/lib/composer-text-effects";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { promptHistoryEntriesToDrafts } from "@/lib/prompt-history";
import { usePromptHistoryEnabled } from "@/hooks/usePromptHistoryEnabled";
import {
  arePromptDraftStatesEqual,
  getProjectStoredPromptAttachmentPaths,
  isPromptDraftEmpty,
  promptDraftToInput,
  type PromptDraftAttachment,
  type PromptDraftState,
} from "@bb/client-core";
import {
  getProjectComposeRoutePath,
  getPluginConfigurationRoutePath,
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import {
  buildReuseThreadOptions,
  resolveProjectSourceGitDisabledReason,
  resolveRootComposeEffectiveEnvironmentValue,
} from "@/views/root-compose-environment-selection";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";

type NewThreadComposerSelectionScope = "new-thread" | "component-local";

export interface NewThreadComposerSeed {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
  environment?: NewThreadRequest["environment"];
  initialPrompt?: string;
}

interface NewThreadComposerLocks {
  project?: boolean;
  provider?: boolean;
  environment?: boolean;
}

interface NewThreadComposerPromptOptions {
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  allowSoftKeyboardAutoFocus?: boolean;
  banner?: ReactNode;
  header?: ReactNode;
  blockedReason?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  pluginComposerHost?: PluginComposerHost;
  textEffects?: NewThreadPromptBoxProps["textEffects"];
  allowNoProject?: boolean;
  createProject?: ProjectSelectorCreateProjectConfig;
  onRequestMachineSetup?: (host: Host) => void;
  locks?: NewThreadComposerLocks;
}

type PromptDraftController = ReturnType<typeof usePromptDraftStorage>;
type ParsedEnvironment = ReturnType<typeof parseEnvironmentValue>;

export interface NewThreadComposerState {
  projectId: string;
  isProjectless: boolean;
  projects: readonly SidebarProject[] | undefined;
  sidebarNavigation: SidebarBootstrapResponse | undefined;
  sidebarNavigationError: boolean;
  currentProject: SidebarProject | undefined;
  projectSources: SidebarProject["sources"];
  connectedHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  parsedEnvironment: ParsedEnvironment;
  projectHostId: string | null;
  panelThreadId: string | null;
  selectedProviderId: string;
  promptDraft: PromptDraftController;
  promptBoxRef: React.RefObject<PromptBoxHandle | null>;
  pluginComposerHost: PluginComposerHost;
  textEffects: NewThreadPromptBoxProps["textEffects"];
  isSubmitting: boolean;
  seedEnvironmentSelectionValue: (value: string) => void;
  setEnvironmentSelectionValue: (
    value: string,
    providerHostId?: string | null,
  ) => void;
  setProviderModelReasoning: (selection: {
    providerId: string;
    model: string;
    reasoningLevel: ReasoningLevel;
  }) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setServiceTier: (value: ServiceTier | undefined) => void;
  renderPromptBox: (options: NewThreadComposerPromptOptions) => ReactNode;
}

export interface NewThreadComposerSubmission extends NewThreadRequest {
  sendAt?: number;
}

export interface NewThreadComposerProps {
  projectId: string | null;
  onProjectChange: (projectId: string) => void | Promise<void>;
  draftStorage: PromptDraftScope;
  selectionScope: NewThreadComposerSelectionScope;
  seed?: NewThreadComposerSeed;
  resetKey?: string | number | null;
  preferReadyProviderWhenUnset?: boolean;
  onSubmit: (request: NewThreadComposerSubmission) => void | Promise<void>;
  focusRequest?: number;
  children: (state: NewThreadComposerState) => ReactNode;
}

type ProjectDefaultsState =
  | { status: "pending" }
  | { status: "error" }
  | { status: "resolved"; defaults: ProjectExecutionDefaults | null };

export interface ResolveNewThreadSubmitDisabledReasonArgs {
  environmentProviderInputsBlocker: string | null;
  isCopyingAttachments: boolean;
  isLoadingModels: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  gitCheckoutUnavailableReason: string | null;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  projectDefaultsStatus: ProjectDefaultsState["status"];
  projectDefaultsUnavailable: boolean;
  promptInputEmpty: boolean;
  providerDisplayName: string;
  selectedProviderId: string;
  selectedThreadModel: string;
  submissionEnvironmentUnavailable: boolean;
}

export function resolveNewThreadSubmitDisabledReason({
  environmentProviderInputsBlocker,
  isCopyingAttachments,
  isLoadingModels,
  isSubmitting,
  isUploading,
  gitCheckoutUnavailableReason,
  modelLoadError,
  projectDefaultsStatus,
  projectDefaultsUnavailable,
  promptInputEmpty,
  providerDisplayName,
  selectedProviderId,
  selectedThreadModel,
  submissionEnvironmentUnavailable,
}: ResolveNewThreadSubmitDisabledReasonArgs): string | null {
  if (isSubmitting) return "Starting thread...";
  if (isCopyingAttachments) {
    return "Moving attachments to the selected project...";
  }
  if (isUploading) return "Uploading attachments...";
  if (projectDefaultsUnavailable) {
    return projectDefaultsStatus === "error"
      ? "Could not load the project's execution defaults."
      : "Loading the project's execution defaults...";
  }
  if (!selectedProviderId) return "Select a provider.";
  if (isLoadingModels) {
    return "Loading models from the selected machine...";
  }

  const fatalModelLoadError =
    modelLoadError?.code === "provider_unavailable" ||
    modelLoadError?.code === "missing_executable" ||
    modelLoadError?.code === "auth_required";
  if (modelLoadError && (fatalModelLoadError || !selectedThreadModel)) {
    return formatModelLoadErrorText({
      error: modelLoadError,
      providerLabel: providerDisplayName || selectedProviderId,
    });
  }
  if (!selectedThreadModel) return "Select a model.";
  if (environmentProviderInputsBlocker) return environmentProviderInputsBlocker;
  if (submissionEnvironmentUnavailable) return "Select an environment.";
  if (gitCheckoutUnavailableReason) return gitCheckoutUnavailableReason;
  if (promptInputEmpty) return "Enter a prompt or attach a file.";
  return null;
}

export function resolveNewThreadProjectDefaultsState({
  cachedDefaults,
  projectFound,
  queryData,
  queryIsError,
  queryIsPlaceholderData,
  queryIsSuccess,
}: {
  cachedDefaults: ProjectExecutionDefaults | null | undefined;
  projectFound: boolean;
  queryData: ProjectExecutionDefaults | null | undefined;
  queryIsError: boolean;
  queryIsPlaceholderData: boolean;
  queryIsSuccess: boolean;
}): ProjectDefaultsState {
  if (cachedDefaults !== null && cachedDefaults !== undefined) {
    return { status: "resolved", defaults: cachedDefaults };
  }
  if (!projectFound) return { status: "pending" };
  if (queryIsSuccess && !queryIsPlaceholderData) {
    return { status: "resolved", defaults: queryData ?? null };
  }
  return queryIsError ? { status: "error" } : { status: "pending" };
}

export function mergeMissingPromptDraftAttachments(
  currentAttachments: readonly PromptDraftAttachment[],
  preservedAttachments: readonly PromptDraftAttachment[],
): PromptDraftAttachment[] | null {
  const existingPaths = new Set(
    currentAttachments.map((attachment) => attachment.path),
  );
  const missingAttachments = preservedAttachments.filter(
    (attachment) => !existingPaths.has(attachment.path),
  );
  return missingAttachments.length === 0
    ? null
    : [...currentAttachments, ...missingAttachments];
}

export function restorePromptDraftAfterOptionChange({
  currentDraft,
  preservedDraft,
}: {
  currentDraft: PromptDraftState;
  preservedDraft: PromptDraftState | null;
}): PromptDraftState | null {
  if (
    preservedDraft === null ||
    arePromptDraftStatesEqual(currentDraft, preservedDraft)
  ) {
    return null;
  }

  let restoredDraft = currentDraft;
  let changed = false;
  if (isPromptDraftEmpty(currentDraft) && !isPromptDraftEmpty(preservedDraft)) {
    restoredDraft = preservedDraft;
    changed = true;
  } else if (
    currentDraft.text === preservedDraft.text &&
    currentDraft.mentions !== preservedDraft.mentions &&
    JSON.stringify(currentDraft.mentions) !==
      JSON.stringify(preservedDraft.mentions)
  ) {
    restoredDraft = { ...restoredDraft, mentions: preservedDraft.mentions };
    changed = true;
  }

  const mergedAttachments = mergeMissingPromptDraftAttachments(
    restoredDraft.attachments,
    preservedDraft.attachments,
  );
  if (mergedAttachments !== null) {
    restoredDraft = { ...restoredDraft, attachments: mergedAttachments };
    changed = true;
  }
  return changed ? restoredDraft : null;
}

export function hasPromptOptionValueChanged<T>(
  currentValue: T,
  nextValue: T,
): boolean {
  return !Object.is(currentValue, nextValue);
}

function resolvePanelThreadId(
  environmentId: string | null,
  reuseThreadOptions: ReturnType<typeof buildReuseThreadOptions>,
): string | null {
  if (environmentId === null) return null;
  return (
    reuseThreadOptions.find((option) => option.environmentId === environmentId)
      ?.threads[0]?.id ?? null
  );
}

export function NewThreadComposer({
  projectId: requestedProjectId,
  onProjectChange,
  draftStorage,
  selectionScope,
  seed,
  resetKey,
  preferReadyProviderWhenUnset = false,
  onSubmit,
  focusRequest,
  children,
}: NewThreadComposerProps) {
  const navigate = useNavigate();
  const promptBoxRef = useRef<PromptBoxHandle>(null);

  const sidebarNavigationQuery = useSidebarNavigation();
  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );
  const requestedCandidate = requestedProjectId ?? PERSONAL_PROJECT_ID;
  const candidateKnown =
    isProjectlessProjectId(requestedCandidate) ||
    (projects?.some((project) => project.id === requestedCandidate) ?? false);
  const replayKnowsCandidate =
    !sidebarNavigationQuery.isPlaceholderData || candidateKnown;
  const sidebarNavigationSettled =
    sidebarNavigationQuery.isError ||
    (sidebarNavigationQuery.isSuccess && replayKnowsCandidate);
  const projectId = useMemo(() => {
    if (isProjectlessProjectId(requestedCandidate)) return PERSONAL_PROJECT_ID;
    if (!projects || !replayKnowsCandidate) return requestedCandidate;
    return candidateKnown ? requestedCandidate : PERSONAL_PROJECT_ID;
  }, [candidateKnown, projects, replayKnowsCandidate, requestedCandidate]);
  const isProjectless = isProjectlessProjectId(projectId);
  const currentProject = useMemo(() => {
    if (isProjectless) {
      const personalProject = sidebarNavigationQuery.data?.personalProject;
      return personalProject ? stripProjectThreads(personalProject) : undefined;
    }
    return projects?.find((project) => project.id === projectId);
  }, [isProjectless, projectId, projects, sidebarNavigationQuery.data]);
  const projectSources = useMemo(
    () => currentProject?.sources ?? [],
    [currentProject?.sources],
  );
  const projectOptions = useMemo(
    () => projects?.map(({ id, name }) => ({ id, name })) ?? [],
    [projects],
  );

  const hostsQuery = useHosts();
  const availableHosts = useMemo(
    () => selectHosts(hostsQuery.data),
    [hostsQuery.data],
  );
  const systemConfigQuery = useSystemConfig();
  const primaryHostId =
    selectPrimaryHost(
      availableHosts,
      systemConfigQuery.data?.primaryHostId ?? null,
    )?.id ?? null;
  const knownHostIds = useMemo(
    () => new Set(availableHosts.map((host) => host.id)),
    [availableHosts],
  );
  const availableHostIds = useMemo(
    () => availableHosts.map((host) => host.id),
    [availableHosts],
  );
  const connectedHostIds = useMemo(
    () =>
      new Set(
        availableHosts
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [availableHosts],
  );
  const worktreeHostNameById = useMemo(() => {
    const hosts = availableHosts;
    return hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name]));
  }, [availableHosts]);
  const projectThreads = useMemo(() => {
    const navigation = sidebarNavigationQuery.data;
    if (!navigation) return undefined;
    if (isProjectless) return navigation.personalProject.threads;
    return navigation.projects.find((project) => project.id === projectId)
      ?.threads;
  }, [isProjectless, projectId, sidebarNavigationQuery.data]);
  const reuseThreadOptionsLoading =
    projectThreads === undefined && !sidebarNavigationSettled;
  const reuseThreadOptions = useMemo(
    () => buildReuseThreadOptions(projectThreads ?? [], worktreeHostNameById),
    [projectThreads, worktreeHostNameById],
  );

  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders({ projectId });
  const environmentProvidersByHostId = useSystemEnvironmentProvidersByHost(
    projectId,
    availableHostIds,
  );
  const environmentProviders = useMemo(
    () =>
      registeredEnvironmentProviders?.filter((provider) =>
        isProjectless
          ? !provider.requires.projectCheckout && !provider.requires.gitRemote
          : !provider.requires.projectless,
      ),
    [isProjectless, registeredEnvironmentProviders],
  );
  const { providers: machineProviders } = useSystemMachineProviders(
    isProjectless ? {} : { projectId },
  );

  const seedSignature = JSON.stringify([
    resetKey ?? null,
    seed?.providerId ?? null,
    seed?.model ?? null,
    seed?.reasoningLevel ?? null,
    seed?.serviceTier ?? null,
    seed?.permissionMode ?? null,
    seed?.environment ?? null,
  ]);
  const environmentSeed = useMemo(
    () =>
      seed?.environment === undefined
        ? null
        : newThreadEnvironmentArgsToSeed(seed.environment),
    [seed?.environment],
  );
  const [activeSeedSignature, setActiveSeedSignature] = useState(seedSignature);
  const [seedOverridden, setBranchSeedOverridden] = useState(false);
  const [pickedProviderMachine, setPickedProviderMachine] = useState<{
    selectionValue: string;
    machine: EnvironmentMachineSelection;
  } | null>(null);
  if (activeSeedSignature !== seedSignature) {
    setActiveSeedSignature(seedSignature);
    setBranchSeedOverridden(false);
    setPickedProviderMachine(null);
  }

  const resolveProviderSelection = useCallback(
    (
      effectiveValue: string,
    ): {
      provider: SystemEnvironmentProvider;
      machine: EnvironmentMachineSelection | null;
    } | null => {
      const parsedValue = parseEnvironmentValue(effectiveValue);
      if (parsedValue?.type !== "provider") return null;
      const provider = environmentProviders?.find(
        (candidate) => candidate.id === parsedValue.environmentProviderId,
      );
      if (provider === undefined) return null;
      const usable = (hostId: string | null): boolean =>
        hostId !== null &&
        knownHostIds.has(hostId) &&
        (isProjectless ||
          !provider.requires.projectCheckout ||
          findLocalPathProjectSourceForHost(projectSources, hostId) !==
            undefined);
      const picked =
        pickedProviderMachine?.selectionValue === effectiveValue
          ? pickedProviderMachine.machine
          : null;
      const seeded =
        picked === null &&
        !seedOverridden &&
        environmentSeed !== null &&
        environmentSeed.selectionValue === effectiveValue
          ? environmentSeed.providerMachine
          : null;
      const candidate = picked ?? seeded;
      if (candidate?.type === "new") return { provider, machine: candidate };
      if (usable(candidate?.hostId ?? null)) {
        return { provider, machine: candidate };
      }
      return {
        provider,
        machine:
          primaryHostId !== null && usable(primaryHostId)
            ? { type: "existing", hostId: primaryHostId }
            : null,
      };
    },
    [
      seedOverridden,
      environmentSeed,
      environmentProviders,
      isProjectless,
      knownHostIds,
      pickedProviderMachine,
      primaryHostId,
      projectSources,
    ],
  );

  const resolveProviderRouting = useCallback(
    (environmentSelectionValue: string) => {
      const effectiveValue = resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      });
      const providerSelection = resolveProviderSelection(effectiveValue);
      if (providerSelection !== null) {
        return providerSelection.machine?.type !== "existing"
          ? {}
          : { hostId: providerSelection.machine.hostId };
      }
      const parsed = parseEnvironmentValue(effectiveValue);
      return parsed?.type === "reuse" && parsed.environmentId !== null
        ? { environmentId: parsed.environmentId }
        : {};
    },
    [
      environmentProviders,
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectSources,
      resolveProviderSelection,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
    ],
  );
  const projectDefaultsQuery = useProjectDefaultExecutionOptions(
    { projectId },
    {
      enabled:
        currentProject !== undefined &&
        currentProject.defaultExecutionOptions === null,
    },
  );
  const projectDefaultsState = resolveNewThreadProjectDefaultsState({
    cachedDefaults: currentProject?.defaultExecutionOptions,
    projectFound: currentProject !== undefined,
    queryData: projectDefaultsQuery.data,
    queryIsError: projectDefaultsQuery.isError,
    queryIsPlaceholderData: projectDefaultsQuery.isPlaceholderData,
    queryIsSuccess: projectDefaultsQuery.isSuccess,
  });
  const projectDefaults =
    projectDefaultsState.status === "resolved"
      ? projectDefaultsState.defaults
      : undefined;
  const projectDefaultsUnavailable =
    projectDefaultsState.status !== "resolved" &&
    (seed?.providerId === undefined ||
      seed?.model === undefined ||
      seed?.reasoningLevel === undefined ||
      seed?.permissionMode === undefined);
  const creationOptions = useThreadCreationOptions({
    scope: selectionScope,
    preferenceProjectId: projectId,
    resetKey: `${projectId}\0${seedSignature}`,
    resolveProviderRouting,
    initialProviderId: seed?.providerId ?? projectDefaults?.providerId,
    preferReadyProviderWhenUnset:
      preferReadyProviderWhenUnset && projectDefaults === null,
    initialModel: seed?.model ?? projectDefaults?.model,
    initialServiceTier: seed?.serviceTier ?? projectDefaults?.serviceTier,
    initialReasoningLevel:
      seed?.reasoningLevel ?? projectDefaults?.reasoningLevel,
    initialPermissionMode:
      seed?.permissionMode ?? projectDefaults?.permissionMode,
    initialEnvironmentSelectionValue: environmentSeed?.selectionValue,
  });
  const {
    activeModel,
    executionInputSources,
    executionOptionsRouting,
    environmentSelectionValue,
    hasMultipleProviders,
    isLoadingModels,
    modelLoadError,
    modelLoadFailed,
    modelOptions,
    moreModelOptions,
    permissionMode,
    permissionModeOptions,
    providerOptions,
    reasoningLevel,
    reasoningOptions,
    selectedModel,
    selectedProviderComposerActions,
    selectedProviderDisplayName,
    selectedProviderId,
    serviceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    setEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
    setPermissionMode,
    setProviderModelReasoning,
    setReasoningLevel,
    setSelectedModel,
    setSelectedProviderId,
    setServiceTier,
    supportsPermissionModeSelection,
    supportsServiceTier,
    clearReuseEnvironment,
  } = creationOptions;
  const selectedThreadModel = activeModel?.model ?? selectedModel;

  const promptDraft = usePromptDraftStorage(draftStorage);
  const textEffects = useComposerTextEffects(promptDraft.storageKey);
  const promptOptionDraftSnapshotRef = useRef<PromptDraftState | null>(null);
  const snapshotDraftBeforeOptionChange = useCallback(() => {
    const currentDraft = promptDraft.getCurrent();
    promptOptionDraftSnapshotRef.current = isPromptDraftEmpty(currentDraft)
      ? null
      : currentDraft;
  }, [promptDraft]);
  useEffect(() => {
    const preservedDraft = promptOptionDraftSnapshotRef.current;
    if (preservedDraft === null) return;
    promptOptionDraftSnapshotRef.current = null;
    const restoredDraft = restorePromptDraftAfterOptionChange({
      currentDraft: promptDraft.getCurrent(),
      preservedDraft,
    });
    if (restoredDraft !== null) promptDraft.setDraft(restoredDraft);
  });

  const changeEnvironment = useCallback(
    (
      value: string,
      providerTarget: string | EnvironmentMachineSelection | null = null,
    ) => {
      const providerMachine =
        typeof providerTarget === "string"
          ? { type: "existing" as const, hostId: providerTarget }
          : providerTarget;
      const currentProviderMachine =
        pickedProviderMachine?.selectionValue === value
          ? pickedProviderMachine.machine
          : null;
      if (
        !hasPromptOptionValueChanged(environmentSelectionValue, value) &&
        JSON.stringify(providerMachine) ===
          JSON.stringify(currentProviderMachine)
      ) {
        return;
      }
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      setPickedProviderMachine(
        providerMachine === null
          ? null
          : { selectionValue: value, machine: providerMachine },
      );
      setCreationEnvironmentSelectionValue(value);
    },
    [
      environmentSelectionValue,
      pickedProviderMachine,
      setCreationEnvironmentSelectionValue,
      snapshotDraftBeforeOptionChange,
    ],
  );
  const handleSelectProvider = useCallback(
    (provider: SystemEnvironmentProvider, hostId: string | null) => {
      changeEnvironment(
        encodeProviderValue(provider.id),
        hostId === null ? null : { type: "existing", hostId },
      );
    },
    [changeEnvironment],
  );
  const handleSelectMachineProvider = useCallback(
    (provider: SystemMachineProvider) => {
      if (provider.environmentRow === null) return;
      changeEnvironment(
        encodeProviderValue(provider.environmentRow.environmentProviderId),
        {
          type: "new",
          machineProviderId: provider.id,
          inputs:
            provider.inputs === null
              ? null
              : provider.acceptsEmptyInputs
                ? {}
                : null,
        },
      );
    },
    [changeEnvironment],
  );
  const effectiveEnvironmentValue = useMemo(
    () =>
      resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue,
        environmentProviders,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      }),
    [
      environmentSelectionValue,
      environmentProviders,
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectSources,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
    ],
  );
  const parsedEnvironment = useMemo(
    () => parseEnvironmentValue(effectiveEnvironmentValue),
    [effectiveEnvironmentValue],
  );
  const providerSelection = useMemo(
    () => resolveProviderSelection(effectiveEnvironmentValue),
    [effectiveEnvironmentValue, resolveProviderSelection],
  );
  const selectedEnvironmentProvider = providerSelection?.provider;
  const providerMachine = providerSelection?.machine ?? null;
  const providerHostId =
    providerMachine?.type === "existing" ? providerMachine.hostId : null;
  const selectedMachineProvider =
    providerMachine?.type === "new"
      ? machineProviders?.find(
          (provider) => provider.id === providerMachine.machineProviderId,
        )
      : undefined;
  const selectedScopedEnvironmentProvider = useMemo(() => {
    if (selectedEnvironmentProvider === undefined) return undefined;
    if (providerHostId === null) return undefined;
    return environmentProvidersByHostId
      .get(providerHostId)
      ?.find((provider) => provider.id === selectedEnvironmentProvider.id);
  }, [
    environmentProvidersByHostId,
    providerHostId,
    selectedEnvironmentProvider,
  ]);
  const setupRequiredPluginId =
    selectedMachineProvider?.availability?.status === "setup-required"
      ? selectedMachineProvider.pluginId
      : selectedScopedEnvironmentProvider?.availability?.status ===
          "setup-required"
        ? selectedScopedEnvironmentProvider.pluginId
        : null;
  const gitCheckoutProviderSelected =
    selectedEnvironmentProvider?.requires.gitCheckout === true;
  const projectCheckoutProviderSelected =
    selectedEnvironmentProvider?.requires.projectCheckout === true;
  const branchesQuery = useProjectSourceBranches(
    projectId,
    projectCheckoutProviderSelected ? providerHostId : null,
    { enabled: projectCheckoutProviderSelected && !isProjectless },
  );
  const gitSourceDisabledReason = resolveProjectSourceGitDisabledReason(
    branchesQuery.data,
  );
  const gitCheckoutUnavailable =
    gitCheckoutProviderSelected && gitSourceDisabledReason !== null;
  useEffect(() => {
    if (!gitCheckoutUnavailable || providerHostId === null) return;
    const checkoutValue = encodeProviderValue(
      PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
    );
    setPickedProviderMachine({
      selectionValue: checkoutValue,
      machine: { type: "existing", hostId: providerHostId },
    });
    setCreationEnvironmentSelectionValue(checkoutValue);
  }, [
    setCreationEnvironmentSelectionValue,
    providerHostId,
    gitCheckoutUnavailable,
  ]);
  const [environmentProviderInputsOverride, setProviderInputsOverride] =
    useState<{ scopeKey: string; value: JsonValue | null } | null>(null);
  const [environmentProviderInputsBlocked, setProviderInputsBlocked] =
    useState<{ scopeKey: string; reason: string } | null>(null);
  const environmentProviderInputsScopeKey = `${projectId}\0${effectiveEnvironmentValue}\0${providerHostId ?? ""}`;
  const handleProviderInputsChange = useCallback(
    (next: PluginEnvironmentProviderInputsChange) => {
      if (next.status === "blocked") {
        setProviderInputsBlocked((current) => {
          if (
            current?.scopeKey === environmentProviderInputsScopeKey &&
            current.reason === next.reason
          ) {
            return current;
          }
          return {
            scopeKey: environmentProviderInputsScopeKey,
            reason: next.reason,
          };
        });
        return;
      }
      setProviderInputsBlocked(null);
      setProviderInputsOverride((current) => {
        if (
          current?.scopeKey === environmentProviderInputsScopeKey &&
          JSON.stringify(current.value) === JSON.stringify(next.value)
        ) {
          return current;
        }
        return {
          scopeKey: environmentProviderInputsScopeKey,
          value: next.value,
        };
      });
    },
    [environmentProviderInputsScopeKey],
  );
  const activeProviderInputsOverride =
    environmentProviderInputsOverride !== null &&
    environmentProviderInputsOverride.scopeKey ===
      environmentProviderInputsScopeKey
      ? environmentProviderInputsOverride
      : null;
  const activeProviderInputsBlocked =
    environmentProviderInputsBlocked?.scopeKey ===
    environmentProviderInputsScopeKey
      ? environmentProviderInputsBlocked
      : null;
  const providerTakesInputs =
    selectedEnvironmentProvider !== undefined &&
    selectedEnvironmentProvider.inputs !== null;
  const pluginSlots = usePluginSlots();
  const environmentProviderInputsSlots = pluginSlots.environmentProviderInputs;
  const inputsControlProviderIds = useMemo(() => {
    const pluginIdByProviderId = new Map(
      (environmentProviders ?? []).map((provider) => [
        provider.id,
        provider.pluginId,
      ]),
    );
    return new Set(
      environmentProviderInputsSlots
        .filter(
          (slot) =>
            pluginIdByProviderId.get(slot.environmentProviderId) ===
            slot.pluginId,
        )
        .map((slot) => slot.environmentProviderId),
    );
  }, [environmentProviderInputsSlots, environmentProviders]);
  const environmentProviderInputsRegistration = useMemo(() => {
    if (
      selectedEnvironmentProvider === undefined ||
      selectedEnvironmentProvider.inputs === null
    ) {
      return undefined;
    }
    return environmentProviderInputsSlots.find(
      (slot) =>
        slot.environmentProviderId === selectedEnvironmentProvider.id &&
        slot.pluginId === selectedEnvironmentProvider.pluginId,
    );
  }, [environmentProviderInputsSlots, selectedEnvironmentProvider]);
  const controlRequiredForSelectedProvider =
    selectedEnvironmentProvider !== undefined &&
    providerInputsControlRequired(selectedEnvironmentProvider);
  const submissionProviderInputs = useMemo((): JsonValue | null => {
    if (!providerTakesInputs) return null;
    if (activeProviderInputsOverride !== null) {
      return activeProviderInputsOverride.value;
    }
    const seededInputs =
      !seedOverridden &&
      environmentSeed !== null &&
      effectiveEnvironmentValue === environmentSeed.selectionValue
        ? environmentSeed.providerInputs
        : null;
    if (seededInputs !== null) return seededInputs;
    return environmentProviderInputsRegistration === undefined &&
      !controlRequiredForSelectedProvider
      ? {}
      : null;
  }, [
    activeProviderInputsOverride,
    controlRequiredForSelectedProvider,
    seedOverridden,
    effectiveEnvironmentValue,
    environmentSeed,
    environmentProviderInputsRegistration,
    providerTakesInputs,
  ]);
  const environmentProviderInputsBlocker =
    selectedEnvironmentProvider === undefined || !providerTakesInputs
      ? null
      : activeProviderInputsBlocked !== null
        ? activeProviderInputsBlocked.reason
        : environmentProviderInputsRegistration === undefined &&
            controlRequiredForSelectedProvider
          ? `${selectedEnvironmentProvider.displayName} needs its plugin's control`
          : submissionProviderInputs === null
            ? `Configure ${selectedEnvironmentProvider.displayName}`
            : null;
  const environmentProviderInputsSlot = useMemo(() => {
    if (environmentProviderInputsRegistration === undefined) return null;
    const InputsComponent = environmentProviderInputsRegistration.component;
    return (
      <PluginSlotMount
        pluginId={environmentProviderInputsRegistration.pluginId}
        slotKind="environmentProviderInputs"
        slotId={environmentProviderInputsRegistration.environmentProviderId}
      >
        <InputsComponent
          projectId={isProjectless ? null : projectId}
          hostId={providerHostId}
          value={submissionProviderInputs}
          onChange={handleProviderInputsChange}
        />
      </PluginSlotMount>
    );
  }, [
    handleProviderInputsChange,
    isProjectless,
    projectId,
    providerHostId,
    submissionProviderInputs,
    environmentProviderInputsRegistration,
  ]);

  const machineProviderInputsSlots = pluginSlots.machineProviderInputs;
  const machineInputsControlProviderIds = useMemo(() => {
    const pluginIdByProviderId = new Map(
      (machineProviders ?? []).map((provider) => [
        provider.id,
        provider.pluginId,
      ]),
    );
    return new Set(
      machineProviderInputsSlots
        .filter(
          (slot) =>
            pluginIdByProviderId.get(slot.machineProviderId) === slot.pluginId,
        )
        .map((slot) => slot.machineProviderId),
    );
  }, [machineProviderInputsSlots, machineProviders]);
  const machineProviderInputsRegistration = useMemo(() => {
    if (
      selectedMachineProvider === undefined ||
      selectedMachineProvider.inputs === null
    ) {
      return undefined;
    }
    return machineProviderInputsSlots.find(
      (slot) =>
        slot.machineProviderId === selectedMachineProvider.id &&
        slot.pluginId === selectedMachineProvider.pluginId,
    );
  }, [machineProviderInputsSlots, selectedMachineProvider]);
  const machineProviderInputsScopeKey = `${projectId}\0${selectedMachineProvider?.id ?? ""}`;
  const [machineProviderInputsOverride, setMachineProviderInputsOverride] =
    useState<{ scopeKey: string; value: JsonValue } | null>(null);
  const [machineProviderInputsBlocked, setMachineProviderInputsBlocked] =
    useState<{ scopeKey: string; reason: string } | null>(null);
  const handleMachineProviderInputsChange = useCallback(
    (next: PluginMachineProviderInputsChange) => {
      if (next.status === "blocked") {
        setMachineProviderInputsBlocked({
          scopeKey: machineProviderInputsScopeKey,
          reason: next.reason,
        });
        return;
      }
      setMachineProviderInputsBlocked(null);
      setMachineProviderInputsOverride({
        scopeKey: machineProviderInputsScopeKey,
        value: next.value,
      });
    },
    [machineProviderInputsScopeKey],
  );
  const activeMachineInputsOverride =
    machineProviderInputsOverride?.scopeKey === machineProviderInputsScopeKey
      ? machineProviderInputsOverride
      : null;
  const activeMachineInputsBlocked =
    machineProviderInputsBlocked?.scopeKey === machineProviderInputsScopeKey
      ? machineProviderInputsBlocked
      : null;
  const machineProviderTakesInputs = selectedMachineProvider?.inputs !== null;
  const machineInputsControlRequired =
    selectedMachineProvider !== undefined &&
    machineProviderInputsControlRequired(selectedMachineProvider);
  const submissionMachineInputs = useMemo<JsonValue | null>(
    () =>
      selectedMachineProvider === undefined || !machineProviderTakesInputs
        ? null
        : (activeMachineInputsOverride?.value ??
          (providerMachine?.type === "new" ? providerMachine.inputs : null) ??
          (machineProviderInputsRegistration === undefined &&
          !machineInputsControlRequired
            ? {}
            : null)),
    [
      activeMachineInputsOverride?.value,
      machineInputsControlRequired,
      machineProviderInputsRegistration,
      machineProviderTakesInputs,
      providerMachine,
      selectedMachineProvider,
    ],
  );
  const machineProviderInputsBlocker =
    selectedMachineProvider === undefined || !machineProviderTakesInputs
      ? null
      : activeMachineInputsBlocked !== null
        ? activeMachineInputsBlocked.reason
        : machineProviderInputsRegistration === undefined &&
            machineInputsControlRequired
          ? `${selectedMachineProvider.displayName} needs its plugin's control`
          : submissionMachineInputs === null
            ? `Configure ${selectedMachineProvider.displayName}`
            : null;
  const machineProviderInputsSlot = useMemo(() => {
    if (machineProviderInputsRegistration === undefined) return null;
    const MachineProviderInputsComponent =
      machineProviderInputsRegistration.component;
    return (
      <PluginSlotMount
        pluginId={machineProviderInputsRegistration.pluginId}
        slotKind="machineProviderInputs"
        slotId={machineProviderInputsRegistration.machineProviderId}
      >
        <MachineProviderInputsComponent
          projectId={isProjectless ? null : projectId}
          value={submissionMachineInputs}
          onChange={handleMachineProviderInputsChange}
        />
      </PluginSlotMount>
    );
  }, [
    handleMachineProviderInputsChange,
    isProjectless,
    machineProviderInputsRegistration,
    projectId,
    submissionMachineInputs,
  ]);
  const submissionProviderMachine = useMemo(
    () =>
      providerMachine?.type === "new"
        ? { ...providerMachine, inputs: submissionMachineInputs }
        : providerMachine,
    [providerMachine, submissionMachineInputs],
  );

  const selectedEnvironment = useMemo(
    () =>
      resolveRootComposeThreadEnvironment({
        environmentValue: effectiveEnvironmentValue,
        projectId,
        environmentProviders,
        providerMachine: submissionProviderMachine,
        providerInputs: submissionProviderInputs,
      }),
    [
      effectiveEnvironmentValue,
      environmentProviders,
      projectId,
      submissionProviderInputs,
      submissionProviderMachine,
    ],
  );

  const seedInitialPrompt = promptDraft.restoreIfEmpty;
  useEffect(() => {
    if (!seed?.initialPrompt) return;
    seedInitialPrompt({
      text: seed.initialPrompt,
      mentions: [],
      attachments: [],
    });
  }, [seed?.initialPrompt, seedInitialPrompt]);
  useEffect(() => {
    if (focusRequest === undefined) return;
    promptBoxRef.current?.focusEnd();
  }, [focusRequest]);

  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCopyingAttachments, setIsCopyingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isUploadingRef = useRef(false);
  const isCopyingAttachmentsRef = useRef(false);
  const isSubmittingRef = useRef(false);
  const uploadPromptAttachment = useUploadPromptAttachment();
  const uploadTargetKey = `${projectId}\0${promptDraft.storageKey}`;
  const currentUploadTargetRef = useRef(uploadTargetKey);
  useEffect(() => {
    currentUploadTargetRef.current = uploadTargetKey;
  }, [uploadTargetKey]);
  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (!projectId || files.length === 0 || isUploadingRef.current) return;
      const capturedTarget = `${projectId}\0${promptDraft.storageKey}`;
      setAttachmentError(null);
      isUploadingRef.current = true;
      setIsUploading(true);
      try {
        for (const file of files) {
          try {
            const uploaded = await uploadPromptAttachment.mutateAsync({
              projectId,
              file,
            });
            if (currentUploadTargetRef.current !== capturedTarget) return;
            promptDraft.addAttachment(uploaded);
          } catch (error) {
            if (currentUploadTargetRef.current === capturedTarget) {
              setAttachmentError(
                getMutationErrorMessage({
                  error,
                  fallbackMessage: "Attachment upload failed",
                }),
              );
            }
            break;
          }
        }
      } finally {
        isUploadingRef.current = false;
        setIsUploading(false);
      }
    },
    [projectId, promptDraft, uploadPromptAttachment],
  );
  const handleProjectChange = useCallback(
    async (nextProjectId: string | null) => {
      const nextValue = nextProjectId ?? PERSONAL_PROJECT_ID;
      if (
        nextValue === projectId ||
        isCopyingAttachmentsRef.current ||
        isUploadingRef.current ||
        isSubmittingRef.current
      ) {
        return;
      }
      const attachmentPaths = getProjectStoredPromptAttachmentPaths(
        promptDraft.getCurrent().attachments,
      );
      isCopyingAttachmentsRef.current = true;
      setIsCopyingAttachments(true);
      try {
        if (attachmentPaths.length > 0) {
          setAttachmentError(null);
          try {
            await sdk.projects.attachments.copy({
              projectId: nextValue,
              sourceProjectId: projectId,
              paths: attachmentPaths,
            });
          } catch (error) {
            setAttachmentError(
              getMutationErrorMessage({
                error,
                fallbackMessage:
                  "Attachments could not be moved to the selected project",
              }),
            );
            return;
          }
        }
        snapshotDraftBeforeOptionChange();
        await onProjectChange(nextValue);
      } finally {
        isCopyingAttachmentsRef.current = false;
        setIsCopyingAttachments(false);
      }
    },
    [onProjectChange, projectId, promptDraft, snapshotDraftBeforeOptionChange],
  );

  const reuseEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;
  const projectHostId =
    reuseEnvironmentId !== null ? null : (providerHostId ?? primaryHostId);
  const panelThreadId = resolvePanelThreadId(
    reuseEnvironmentId,
    reuseThreadOptions,
  );
  const promptMentions = usePromptMentions(
    isProjectless ? undefined : projectId,
    {
      environmentId: reuseEnvironmentId,
      hostId: projectHostId,
      threadStorageThreadId: panelThreadId ?? undefined,
    },
  );
  const defaultMentionLinkResolver = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: targetProjectId,
              threadId: resource.threadId,
            }),
          );
      }
      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }
      return null;
    },
    [navigate, projectId],
  );
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [hasComposerFocused, setHasComposerFocused] = useState(false);
  const handleEditorFocus = useCallback(() => {
    setHasComposerFocused(true);
  }, []);
  const providerPromptActions = useMemo(
    () => buildProviderPromptActionProps(selectedProviderComposerActions),
    [selectedProviderComposerActions],
  );
  const promptActions = useMemo(
    () => withAppPromptActions(providerPromptActions.promptActions),
    [providerPromptActions.promptActions],
  );
  const commandSuggestions = useCommandSuggestions({
    projectId,
    providerId: selectedProviderId,
    commandScope: "new-thread",
    skillsTrigger: providerPromptActions.skillsTrigger,
    promptActions,
    environmentId: reuseEnvironmentId,
    hostId: projectHostId,
    query: commandQuery,
    composerFocused: hasComposerFocused,
  });
  const promptHistoryEnabled = usePromptHistoryEnabled();
  const { data: projectPromptHistory = [] } = useProjectPromptHistory(
    projectId,
    { enabled: promptHistoryEnabled && sidebarNavigationSettled },
  );
  const promptHistoryDrafts = useMemo(
    () => promptHistoryEntriesToDrafts(projectPromptHistory),
    [projectPromptHistory],
  );
  const currentDraft = useMemo(
    () => ({
      text: promptDraft.text,
      mentions: promptDraft.mentions,
      attachments: promptDraft.attachments,
    }),
    [promptDraft.attachments, promptDraft.mentions, promptDraft.text],
  );
  const promptInput = useMemo(
    () => promptDraftToInput(currentDraft),
    [currentDraft],
  );
  const submitScheduledRef = useRef<
    (options: { sendAt: number }) => Promise<void>
  >(async () => {});
  const submitScheduledThroughRef = useCallback(
    (options: { sendAt: number }) => submitScheduledRef.current(options),
    [],
  );
  const pluginComposerHost = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "new-thread", projectId },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: () => promptBoxRef.current?.focusEnd(),
      submit: submitScheduledThroughRef,
    }),
    [
      projectId,
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      submitScheduledThroughRef,
    ],
  );

  const seededExecutionInputSources = useMemo(
    (): CreateExecutionInputSources => ({
      ...(seed?.providerId !== undefined
        ? { providerId: "explicit" as const }
        : {}),
      ...(seed?.model !== undefined ? { model: "explicit" as const } : {}),
      ...(seed?.reasoningLevel !== undefined
        ? { reasoningLevel: "explicit" as const }
        : {}),
      ...(seed?.serviceTier !== undefined && supportsServiceTier && serviceTier
        ? { serviceTier: "explicit" as const }
        : {}),
      ...(seed?.permissionMode !== undefined
        ? { permissionMode: "explicit" as const }
        : {}),
    }),
    [
      seed?.model,
      seed?.permissionMode,
      seed?.providerId,
      seed?.reasoningLevel,
      seed?.serviceTier,
      serviceTier,
      supportsServiceTier,
    ],
  );
  const submissionEnvironment =
    selectedEnvironment ??
    (selectionScope === "new-thread" ? seed?.environment : undefined) ??
    null;
  const submitDisabledReason = resolveNewThreadSubmitDisabledReason({
    environmentProviderInputsBlocker:
      machineProviderInputsBlocker ?? environmentProviderInputsBlocker,
    isCopyingAttachments,
    isLoadingModels,
    isSubmitting,
    isUploading,
    gitCheckoutUnavailableReason: gitCheckoutUnavailable
      ? gitSourceDisabledReason
      : null,
    modelLoadError,
    projectDefaultsStatus: projectDefaultsState.status,
    projectDefaultsUnavailable,
    promptInputEmpty: promptInput.length === 0,
    providerDisplayName: selectedProviderDisplayName,
    selectedProviderId,
    selectedThreadModel,
    submissionEnvironmentUnavailable: submissionEnvironment === null,
  });
  const submitDraft = useCallback(
    async (blockedReason: string | null, sendAt: number | null) => {
      const submittedDraft = promptDraft.getCurrent();
      const input = promptDraftToInput(submittedDraft);
      if (
        blockedReason !== null ||
        submitDisabledReason !== null ||
        input.length === 0 ||
        isSubmittingRef.current ||
        projectDefaultsUnavailable ||
        submissionEnvironment === null ||
        !selectedProviderId ||
        !selectedThreadModel ||
        gitCheckoutUnavailable
      ) {
        throw new Error(
          blockedReason ??
            submitDisabledReason ??
            (input.length === 0
              ? "Type a message first."
              : "This composer is not ready to submit yet."),
        );
      }
      const sources: CreateExecutionInputSources = {
        ...executionInputSources,
        ...seededExecutionInputSources,
      };
      const request: NewThreadComposerSubmission = {
        projectId,
        providerId: selectedProviderId,
        model: selectedThreadModel,
        reasoningLevel,
        permissionMode,
        ...(supportsServiceTier && serviceTier ? { serviceTier } : {}),
        executionInputSources: sources,
        environment: submissionEnvironment,
        input,
        ...(sendAt === null ? {} : { sendAt }),
      };
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setAttachmentError(null);
      const clearedSubmittedDraft =
        promptDraft.clearIfCurrentMatches(submittedDraft);
      try {
        await onSubmit(request);
        clearReuseEnvironment();
      } catch (submitError) {
        if (clearedSubmittedDraft) {
          promptDraft.restoreIfEmpty(submittedDraft);
        }
        throw submitError;
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [
      clearReuseEnvironment,
      executionInputSources,
      gitCheckoutUnavailable,
      onSubmit,
      permissionMode,
      projectDefaultsUnavailable,
      projectId,
      promptDraft,
      reasoningLevel,
      seededExecutionInputSources,
      submitDisabledReason,
      submissionEnvironment,
      selectedProviderId,
      selectedThreadModel,
      serviceTier,
      supportsServiceTier,
    ],
  );

  const handleSubmit = useCallback(
    async (blockedReason: string | null) => {
      if (blockedReason === null && setupRequiredPluginId !== null) {
        navigate(
          getPluginConfigurationRoutePath({ pluginId: setupRequiredPluginId }),
        );
        return;
      }
      try {
        await submitDraft(blockedReason, null);
      } catch {}
    },
    [navigate, setupRequiredPluginId, submitDraft],
  );
  useEffect(() => {
    submitScheduledRef.current = async ({ sendAt }) => {
      await submitDraft(null, sendAt);
    };
  }, [submitDraft]);

  const handleProviderChange = useCallback(
    (value: string) => {
      if (!hasPromptOptionValueChanged(selectedProviderId, value)) return;
      snapshotDraftBeforeOptionChange();
      setSelectedProviderId(value);
    },
    [
      selectedProviderId,
      setSelectedProviderId,
      snapshotDraftBeforeOptionChange,
    ],
  );
  const handleModelChange = useCallback(
    (value: string) => {
      if (!hasPromptOptionValueChanged(selectedModel, value)) return;
      snapshotDraftBeforeOptionChange();
      setSelectedModel(value);
    },
    [selectedModel, setSelectedModel, snapshotDraftBeforeOptionChange],
  );
  const handleReasoningChange = useCallback(
    (value: ReasoningLevel) => {
      if (!hasPromptOptionValueChanged(reasoningLevel, value)) return;
      snapshotDraftBeforeOptionChange();
      setReasoningLevel(value);
    },
    [reasoningLevel, setReasoningLevel, snapshotDraftBeforeOptionChange],
  );
  const handlePermissionChange = useCallback(
    (value: PermissionMode) => {
      if (!hasPromptOptionValueChanged(permissionMode, value)) return;
      snapshotDraftBeforeOptionChange();
      setPermissionMode(value);
    },
    [permissionMode, setPermissionMode, snapshotDraftBeforeOptionChange],
  );
  const handleServiceTierChange = useCallback(
    (value: ServiceTier | undefined) => {
      if (!hasPromptOptionValueChanged(serviceTier, value)) return;
      snapshotDraftBeforeOptionChange();
      setServiceTier(value);
    },
    [serviceTier, setServiceTier, snapshotDraftBeforeOptionChange],
  );
  const handleWorktreeChange = useCallback(
    (environmentId: string) => {
      changeEnvironment(encodeReuseValue(environmentId));
    },
    [changeEnvironment],
  );

  const renderPromptBox = useCallback(
    (options: NewThreadComposerPromptOptions) => {
      const locks = options.locks ?? {};
      const disabledReason = options.blockedReason ?? submitDisabledReason;
      return (
        <NewThreadPromptBox
          id={options.id}
          promptBoxRef={promptBoxRef}
          value={promptDraft.text}
          mentionRanges={promptDraft.mentions}
          onChange={promptDraft.setTextAndMentions}
          onSubmit={() => void handleSubmit(options.blockedReason ?? null)}
          isSubmitting={isSubmitting}
          disabled={disabledReason !== null}
          disabledReason={disabledReason ?? undefined}
          placeholder={options.placeholder}
          autoFocus={options.autoFocus}
          allowSoftKeyboardAutoFocus={options.allowSoftKeyboardAutoFocus}
          pluginComposerHost={options.pluginComposerHost ?? pluginComposerHost}
          textEffects={options.textEffects ?? textEffects}
          history={{
            currentDraft,
            entries: promptHistoryDrafts,
            onSelectEntry: promptDraft.setDraft,
            resetKey: projectId,
          }}
          typeahead={{
            mention: {
              triggers: promptMentions.triggers,
              results: promptMentions.results,
              isLoading: promptMentions.isLoading,
              isError: promptMentions.isError,
              onQueryChange: promptMentions.setQuery,
              resolveLink:
                options.resolveMentionLink ?? defaultMentionLinkResolver,
            },
            command: {
              trigger: commandSuggestions.trigger,
              suggestions: commandSuggestions.suggestions,
              isLoading: commandSuggestions.isLoading,
              isError: commandSuggestions.isError,
              hasMore: commandSuggestions.hasMore,
              isLoadingMore: commandSuggestions.isLoadingMore,
              loadMore: commandSuggestions.loadMore,
              onQueryChange: setCommandQuery,
              onEditorFocus: handleEditorFocus,
            },
          }}
          attachments={{
            items: promptDraft.attachments,
            projectId,
            onAttachFiles: handleAttachFiles,
            onRemove: promptDraft.removeAttachment,
            isAttaching: isUploading || isCopyingAttachments,
            error: attachmentError,
          }}
          promptActions={promptActions}
          modeConfig={{
            environment: {
              value: effectiveEnvironmentValue,
              onChange: changeEnvironment,
              sources: projectSources,
              disabled: locks.environment,
              providers: environmentProviders ?? [],
              providersByHostId: environmentProvidersByHostId,
              selectedProviderHostId: providerHostId,
              inputsControlProviderIds,
              onSelectProvider: handleSelectProvider,
              machineProviders: machineProviders ?? [],
              selectedMachineProviderId: selectedMachineProvider?.id ?? null,
              machineInputsControlProviderIds,
              onSelectMachineProvider: handleSelectMachineProvider,
              ...(!isProjectless && options.onRequestMachineSetup
                ? { onRequestMachineSetup: options.onRequestMachineSetup }
                : {}),
            },
            worktree: {
              options: reuseThreadOptions,
              value: reuseEnvironmentId,
              onChange: handleWorktreeChange,
              disabled: locks.environment,
            },
            permission: {
              value: permissionMode,
              options: permissionModeOptions,
              onChange: handlePermissionChange,
              supported: supportsPermissionModeSelection,
            },
            environmentProviderInputsSlot,
            machineProviderInputsSlot,
            banner: options.banner,
            header: options.header,
          }}
          project={{
            projects: projectOptions,
            value: options.allowNoProject && isProjectless ? null : projectId,
            onChange: handleProjectChange,
            allowNoProject: options.allowNoProject,
            createProject: options.createProject,
            isLoading: !sidebarNavigationSettled,
            disabled:
              locks.project ||
              isUploading ||
              isCopyingAttachments ||
              isSubmitting,
            showChevronWhenDisabled: !locks.project,
          }}
          execution={{
            providerRouting: executionOptionsRouting,
            provider: {
              options: providerOptions,
              selectedId: selectedProviderId,
              onChange: locks.provider ? undefined : handleProviderChange,
              hasMultiple: hasMultipleProviders,
            },
            model: {
              active: activeModel,
              selected: selectedModel,
              options: modelOptions,
              moreOptions: moreModelOptions,
              isLoading: isLoadingModels,
              loadFailed: modelLoadFailed,
              loadError: modelLoadError,
              onChange: handleModelChange,
            },
            serviceTier: {
              value: serviceTier,
              onChange: handleServiceTierChange,
              supported: supportsServiceTier,
              supportByProvider: serviceTierSupportByProvider,
              fastLabel: serviceTierFastLabel,
            },
            reasoning: {
              value: reasoningLevel,
              options: reasoningOptions,
              onChange: handleReasoningChange,
            },
          }}
        />
      );
    },
    [
      activeModel,
      attachmentError,
      changeEnvironment,
      commandSuggestions,
      currentDraft,
      defaultMentionLinkResolver,
      effectiveEnvironmentValue,
      environmentProviders,
      executionOptionsRouting,
      handleAttachFiles,
      handleEditorFocus,
      handleModelChange,
      handlePermissionChange,
      handleProjectChange,
      handleProviderChange,
      handleReasoningChange,
      handleSelectProvider,
      handleSelectMachineProvider,
      handleServiceTierChange,
      handleSubmit,
      handleWorktreeChange,
      hasMultipleProviders,
      isCopyingAttachments,
      isLoadingModels,
      isProjectless,
      isSubmitting,
      isUploading,
      modelLoadError,
      modelLoadFailed,
      modelOptions,
      moreModelOptions,
      permissionMode,
      permissionModeOptions,
      projectId,
      projectOptions,
      projectSources,
      promptActions,
      promptDraft,
      promptHistoryDrafts,
      promptMentions,
      pluginComposerHost,
      providerOptions,
      reasoningLevel,
      reasoningOptions,
      reuseEnvironmentId,
      reuseThreadOptions,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      sidebarNavigationSettled,
      supportsPermissionModeSelection,
      supportsServiceTier,
      submitDisabledReason,
      environmentProviderInputsSlot,
      machineProviderInputsSlot,
      environmentProvidersByHostId,
      inputsControlProviderIds,
      machineInputsControlProviderIds,
      machineProviders,
      selectedMachineProvider,
      providerHostId,
      textEffects,
      serviceTierFastLabel,
    ],
  );

  return children({
    projectId,
    isProjectless,
    projects,
    sidebarNavigation: sidebarNavigationQuery.data,
    sidebarNavigationError: sidebarNavigationQuery.isError,
    currentProject,
    projectSources,
    connectedHostIds,
    primaryHostId,
    parsedEnvironment,
    projectHostId,
    panelThreadId,
    selectedProviderId,
    promptDraft,
    promptBoxRef,
    pluginComposerHost,
    textEffects,
    isSubmitting,
    seedEnvironmentSelectionValue: setCreationEnvironmentSelectionValue,
    setEnvironmentSelectionValue: changeEnvironment,
    setProviderModelReasoning,
    setPermissionMode,
    setServiceTier,
    renderPromptBox,
  });
}
