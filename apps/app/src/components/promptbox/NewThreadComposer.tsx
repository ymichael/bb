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
  PERSONAL_PROJECT_ID,
  type Host,
  type PermissionMode,
  type ProjectExecutionDefaults,
  type ReasoningLevel,
  type ServiceTier,
} from "@bb/domain";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type {
  CreateExecutionInputSources,
  SidebarBootstrapResponse,
  SystemExecutionOptionsModelLoadError,
} from "@bb/server-contract";
import type { ProjectSelectorCreateProjectConfig } from "@/components/pickers/ProjectSelector";
import {
  encodeHostValue,
  encodeReuseValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { formatModelLoadErrorText } from "@/components/pickers/model-load-error-message";
import {
  NewThreadPromptBox,
  type NewThreadPromptBoxProps,
} from "@/components/promptbox/NewThreadPromptBox";
import { withAppPromptActions } from "@/components/promptbox/PromptBoxActionsMenu";
import { buildProviderPromptActionProps } from "@bb/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import { type PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { newThreadEnvironmentArgsToSeed } from "@/components/plugin/new-thread-environment-seed";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { selectPrimaryHost, useHosts } from "@/hooks/queries/host-queries";
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
  getThreadRoutePath,
  isProjectlessProjectId,
} from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";
import {
  buildRootComposeBranchUiState,
  type RootComposeBranchEnvironmentMode,
} from "@/views/root-compose-branch-ui";
import { useScopedBranchSelection } from "@/views/root-compose-branch-selection";
import {
  buildReuseThreadOptions,
  resolveProjectSourceWorktreeDisabledReason,
  resolveRootComposeEffectiveEnvironmentValue,
  resolveRootComposeProjectRouting,
  resolveRootComposeProviderRouting,
} from "@/views/root-compose-environment-selection";
import {
  resolveRootComposeThreadEnvironment,
  type RootComposeSelectedBranch,
} from "@/views/root-compose-thread-environment";

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
  branch?: boolean;
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
  setEnvironmentSelectionValue: (value: string) => void;
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
  branchMutationBlockerTitle: string | null;
  isCopyingAttachments: boolean;
  isLoadingModels: boolean;
  isSubmitting: boolean;
  isUploading: boolean;
  managedWorktreeUnavailableReason: string | null;
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
  branchMutationBlockerTitle,
  isCopyingAttachments,
  isLoadingModels,
  isSubmitting,
  isUploading,
  managedWorktreeUnavailableReason,
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
  if (submissionEnvironmentUnavailable) return "Select an environment.";
  if (managedWorktreeUnavailableReason) {
    return managedWorktreeUnavailableReason;
  }
  if (branchMutationBlockerTitle) return branchMutationBlockerTitle;
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

export function hasPromptBranchSelectionChanged(
  currentBranch: RootComposeSelectedBranch | null,
  nextBranch: RootComposeSelectedBranch | null,
): boolean {
  if (currentBranch === null || nextBranch === null) {
    return currentBranch !== nextBranch;
  }
  return (
    currentBranch.name !== nextBranch.name ||
    currentBranch.isNew !== nextBranch.isNew
  );
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
  const systemConfigQuery = useSystemConfig();
  const primaryHostId =
    selectPrimaryHost(
      hostsQuery.data,
      systemConfigQuery.data?.primaryHostId ?? null,
    )?.id ?? null;
  const knownHostIds = useMemo(
    () => new Set((hostsQuery.data ?? []).map((host) => host.id)),
    [hostsQuery.data],
  );
  const connectedHostIds = useMemo(
    () =>
      new Set(
        (hostsQuery.data ?? [])
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [hostsQuery.data],
  );
  const worktreeHostNameById = useMemo(() => {
    const hosts = hostsQuery.data ?? [];
    return hosts.length <= 1
      ? null
      : new Map(hosts.map((host) => [host.id, host.name]));
  }, [hostsQuery.data]);
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
  const [branchSeedOverridden, setBranchSeedOverridden] = useState(false);
  if (activeSeedSignature !== seedSignature) {
    setActiveSeedSignature(seedSignature);
    setBranchSeedOverridden(false);
  }

  const resolveProviderRouting = useCallback(
    (environmentSelectionValue: string) =>
      resolveRootComposeProviderRouting({
        environmentSelectionValue,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      }),
    [
      isProjectless,
      knownHostIds,
      primaryHostId,
      projectSources,
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
    (value: string) => {
      if (!hasPromptOptionValueChanged(environmentSelectionValue, value))
        return;
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      setCreationEnvironmentSelectionValue(value);
    },
    [
      environmentSelectionValue,
      setCreationEnvironmentSelectionValue,
      snapshotDraftBeforeOptionChange,
    ],
  );
  const effectiveEnvironmentValue = useMemo(
    () =>
      resolveRootComposeEffectiveEnvironmentValue({
        environmentSelectionValue,
        isProjectless,
        knownHostIds,
        primaryHostId,
        projectSources,
        reuseThreadOptions,
        reuseThreadOptionsLoading,
      }),
    [
      environmentSelectionValue,
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
  const isHostMode = parsedEnvironment?.type === "host";
  const branchEnvironmentMode: RootComposeBranchEnvironmentMode = isProjectless
    ? "other"
    : isHostMode && parsedEnvironment.mode === "local"
      ? "local"
      : isHostMode && parsedEnvironment.mode === "worktree"
        ? "worktree"
        : "other";
  const {
    selectedBranch: pickedBranch,
    onBranchChange,
    onClearBranch,
    onCreateBranch,
    onCreateBranchFrom,
  } = useScopedBranchSelection({
    environmentValue: effectiveEnvironmentValue,
    projectId,
    selectionScope,
  });
  const selectedBranch =
    pickedBranch ??
    (!branchSeedOverridden &&
    environmentSeed !== null &&
    effectiveEnvironmentValue === environmentSeed.selectionValue
      ? environmentSeed.branch
      : null);
  const [branchSearchQuery, setBranchSearchQuery] = useState("");
  useEffect(() => {
    setBranchSearchQuery("");
  }, [effectiveEnvironmentValue, projectId]);
  const branchesQuery = useProjectSourceBranches(
    projectId,
    isHostMode ? parsedEnvironment.hostId : null,
    {
      enabled: isHostMode && !isProjectless,
      query: branchSearchQuery,
      selectedBranch: selectedBranch?.name ?? "",
    },
  );
  const worktreeDisabledReason = resolveProjectSourceWorktreeDisabledReason(
    branchesQuery.data,
  );
  const worktreeUnavailable = worktreeDisabledReason !== null;
  const requestsManagedWorktree =
    isHostMode && parsedEnvironment.mode === "worktree";
  const managedWorktreeUnavailable =
    requestsManagedWorktree && worktreeUnavailable;
  useEffect(() => {
    if (
      !worktreeUnavailable ||
      parsedEnvironment?.type !== "host" ||
      parsedEnvironment.mode !== "worktree"
    ) {
      return;
    }
    setCreationEnvironmentSelectionValue(
      encodeHostValue(parsedEnvironment.hostId, "local"),
    );
  }, [
    parsedEnvironment,
    setCreationEnvironmentSelectionValue,
    worktreeUnavailable,
  ]);
  const branchOptions = useMemo(() => {
    const branches = branchesQuery.data?.branches ?? [];
    const selectedRef = branchesQuery.data?.selectedBranch;
    return selectedRef?.kind === "local" && !branches.includes(selectedRef.name)
      ? [selectedRef.name, ...branches]
      : branches;
  }, [branchesQuery.data?.branches, branchesQuery.data?.selectedBranch]);
  const remoteBranchOptions = useMemo(() => {
    if (branchEnvironmentMode === "other") return [];
    const branches = branchesQuery.data?.remoteBranches ?? [];
    const selectedRef = branchesQuery.data?.selectedBranch;
    return selectedRef?.kind === "remote" &&
      !branches.includes(selectedRef.name)
      ? [selectedRef.name, ...branches]
      : branches;
  }, [
    branchEnvironmentMode,
    branchesQuery.data?.remoteBranches,
    branchesQuery.data?.selectedBranch,
  ]);
  const branchSelectionSeed =
    branchEnvironmentMode === "local" &&
    branchesQuery.data?.checkout.kind === "branch"
      ? branchesQuery.data.checkout.branchName
      : branchEnvironmentMode === "worktree"
        ? (branchesQuery.data?.defaultWorktreeBaseBranch ??
          branchesQuery.data?.defaultBranch ??
          null)
        : null;
  const branchUiState = useMemo(
    () =>
      buildRootComposeBranchUiState({
        checkout: branchesQuery.data,
        isFetching: branchesQuery.isFetching,
        isLoading: branchesQuery.isLoading,
        mode: branchEnvironmentMode,
        selectedBranch,
      }),
    [
      branchEnvironmentMode,
      branchesQuery.data,
      branchesQuery.isFetching,
      branchesQuery.isLoading,
      selectedBranch,
    ],
  );
  const handleBranchChange = useCallback(
    (name: string) => {
      const nextBranch = { name, isNew: false };
      if (!hasPromptBranchSelectionChanged(selectedBranch, nextBranch)) return;
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      onBranchChange(name);
    },
    [onBranchChange, selectedBranch, snapshotDraftBeforeOptionChange],
  );
  const handleClearBranch = useCallback(() => {
    if (!hasPromptBranchSelectionChanged(selectedBranch, null)) return;
    snapshotDraftBeforeOptionChange();
    setBranchSeedOverridden(true);
    onClearBranch();
  }, [onClearBranch, selectedBranch, snapshotDraftBeforeOptionChange]);
  const handleCreateBranch = useCallback(() => {
    const name = selectedBranch?.name ?? branchSelectionSeed;
    const nextBranch = name === null ? null : { name, isNew: true };
    if (!hasPromptBranchSelectionChanged(selectedBranch, nextBranch)) return;
    snapshotDraftBeforeOptionChange();
    setBranchSeedOverridden(true);
    onCreateBranch(name);
  }, [
    branchSelectionSeed,
    onCreateBranch,
    selectedBranch,
    snapshotDraftBeforeOptionChange,
  ]);
  const handleCreateBranchFrom = useCallback(
    (name: string) => {
      const nextBranch = { name, isNew: true };
      if (!hasPromptBranchSelectionChanged(selectedBranch, nextBranch)) return;
      snapshotDraftBeforeOptionChange();
      setBranchSeedOverridden(true);
      onCreateBranchFrom(name);
    },
    [onCreateBranchFrom, selectedBranch, snapshotDraftBeforeOptionChange],
  );
  const selectedEnvironment = useMemo(
    () =>
      resolveRootComposeThreadEnvironment({
        defaultBranch: branchesQuery.data?.defaultBranch,
        defaultWorktreeBaseBranch:
          branchesQuery.data?.defaultWorktreeBaseBranch,
        environmentValue: effectiveEnvironmentValue,
        projectId,
        selectedBranch,
      }),
    [
      branchesQuery.data?.defaultBranch,
      branchesQuery.data?.defaultWorktreeBaseBranch,
      effectiveEnvironmentValue,
      projectId,
      selectedBranch,
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
  const projectRouting = resolveRootComposeProjectRouting(
    parsedEnvironment,
    primaryHostId,
  );
  const projectHostId = projectRouting.hostId ?? null;
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
    branchMutationBlockerTitle:
      branchEnvironmentMode === "local" && selectedBranch !== null
        ? (branchUiState.mutationBlocker?.title ?? null)
        : null,
    isCopyingAttachments,
    isLoadingModels,
    isSubmitting,
    isUploading,
    managedWorktreeUnavailableReason: managedWorktreeUnavailable
      ? worktreeDisabledReason
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
        managedWorktreeUnavailable
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
      managedWorktreeUnavailable,
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
      try {
        await submitDraft(blockedReason, null);
      } catch {}
    },
    [submitDraft],
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
  const refreshBranchesFromRemote = branchesQuery.refreshFromRemote;
  const handleBranchOpenChange = useCallback(
    (open: boolean) => {
      if (open) void refreshBranchesFromRemote().catch(() => undefined);
    },
    [refreshBranchesFromRemote],
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
              reuseDisabled: reuseThreadOptions.length === 0,
              worktreeDisabledReason,
              disabled: locks.environment,
              ...(!isProjectless && options.onRequestMachineSetup
                ? { onRequestMachineSetup: options.onRequestMachineSetup }
                : {}),
            },
            branch: {
              value:
                selectedBranch?.name ??
                (branchEnvironmentMode === "worktree"
                  ? branchUiState.currentBranch
                  : null),
              currentBranch: branchUiState.currentBranch,
              isNew: selectedBranch?.isNew ?? false,
              hidden: worktreeUnavailable,
              options: branchOptions,
              remoteOptions: remoteBranchOptions,
              loading: branchesQuery.isFetching,
              placeholder: branchUiState.placeholder,
              triggerLabel: branchUiState.triggerLabel,
              triggerTitle: branchUiState.triggerTitle,
              currentOptionLabel:
                branchEnvironmentMode === "local"
                  ? branchUiState.currentOptionLabel
                  : null,
              currentOptionTitle:
                branchEnvironmentMode === "local"
                  ? (branchUiState.currentOptionLabel ?? undefined)
                  : undefined,
              optionDisabledReason: branchUiState.mutationBlocker?.label,
              optionDisabledTitle: branchUiState.mutationBlocker?.title,
              createDisabledReason: branchUiState.mutationBlocker?.label,
              createDisabledTitle: branchUiState.mutationBlocker?.title,
              disabled: locks.branch,
              onChange: handleBranchChange,
              onClear: handleClearBranch,
              onCreate: handleCreateBranch,
              onCreateBaseChange: handleCreateBranchFrom,
              onOpenChange: handleBranchOpenChange,
              onSearchQueryChange: setBranchSearchQuery,
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
      branchEnvironmentMode,
      branchOptions,
      branchUiState,
      branchesQuery.isFetching,
      changeEnvironment,
      commandSuggestions,
      currentDraft,
      defaultMentionLinkResolver,
      effectiveEnvironmentValue,
      executionOptionsRouting,
      handleAttachFiles,
      handleBranchChange,
      handleBranchOpenChange,
      handleClearBranch,
      handleCreateBranch,
      handleCreateBranchFrom,
      handleEditorFocus,
      handleModelChange,
      handlePermissionChange,
      handleProjectChange,
      handleProviderChange,
      handleReasoningChange,
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
      remoteBranchOptions,
      reuseEnvironmentId,
      reuseThreadOptions,
      selectedBranch,
      selectedModel,
      selectedProviderId,
      serviceTier,
      serviceTierSupportByProvider,
      sidebarNavigationSettled,
      supportsPermissionModeSelection,
      supportsServiceTier,
      submitDisabledReason,
      textEffects,
      worktreeDisabledReason,
      worktreeUnavailable,
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
