import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AvailableModel,
  PermissionMode,
  ProviderComposerAction,
  ProviderInfo,
  ProviderModelCatalogScope,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import type {
  CreateExecutionInputSources,
  ExecutionInputFieldSource,
  ExistingThreadExecutionInputSources,
  SystemExecutionOptionsModelLoadError,
  SystemProvidersQuery,
} from "@bb/server-contract";
import type { PickerOption } from "@/components/pickers/OptionPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import type { ProviderPickerOption } from "@/components/pickers/model-brand-prefix";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { useRootComposeReuseEnvironment } from "@/lib/root-compose-selection";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { fastServiceTierLabel } from "@/lib/reasoning-labels";
import {
  permissionModeRank,
  providerModelCatalogDependsOnWorkspace,
} from "@bb/domain";
import { selectPrimaryHost, useHosts } from "./queries/host-queries";
import {
  useKnownProviderModelCatalogScope,
  useSystemProviderStates,
  useSystemConfig,
  useSystemExecutionOptions,
} from "./queries/system-queries";
import {
  usePromptBoxEnvironmentPreference,
  usePromptBoxModelPreference,
  usePromptBoxPermissionModePreference,
  usePromptBoxProviderPreference,
  usePromptBoxReasoningLevelPreference,
  usePromptBoxServiceTierPreference,
  useSetPromptBoxProviderModelReasoningPreference,
} from "./thread-creation-options/persisted-selection-fields";
import {
  buildExecutionInputSources,
  formatModelLabel,
  getInitialThreadPromptSelections,
  resolvePermissionModeSelection,
  syncUntouchedThreadPromptSelections,
  type ScopedExecutionInputSources,
  type ThreadPromptField,
  type ThreadPromptSelections,
  type UseComponentLocalCreationOptions,
  type UseNewThreadCreationOptions,
  type UsePromptModelReasoningOptions,
  updateThreadPromptSelections,
} from "./thread-creation-options/selection-state";
import {
  resolveModelCatalogSelection,
  resolveModelReasoningLevel,
} from "./thread-creation-options/model-catalog-selection";

export { formatModelLabel, resolvePermissionModeSelection };

const EMPTY_PROVIDERS: ProviderInfo[] = [];
const EMPTY_COMPOSER_ACTIONS: ProviderComposerAction[] = [];

const DEFAULT_SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ["full"];

const PERMISSION_CEILING_REASON =
  "Above the selected machine's permission limit. Change it in Settings → Machines.";

type StringSelectionSetter = (value: string) => void;
type ServiceTierSelectionSetter = (value: ServiceTier | undefined) => void;
type ReasoningLevelSelectionSetter = (value: ReasoningLevel) => void;
type PermissionModeSelectionSetter = (value: PermissionMode) => void;
type ClearSelectionHandler = () => void;

interface ModelReasoningSelection {
  model: string;
  reasoningLevel: ReasoningLevel;
}

interface ProviderModelReasoningSelection extends ModelReasoningSelection {
  providerId: string;
}

type ProviderModelReasoningSelectionSetter = (
  selection: ProviderModelReasoningSelection,
) => void;

interface UseThreadCreationOptionsResult<TExecutionInputSources> {
  executionOptionsRouting: SystemProvidersQuery;
  selectedProviderId: string;
  setSelectedProviderId: StringSelectionSetter;
  setProviderModelReasoning: ProviderModelReasoningSelectionSetter;
  providerOptions: ProviderPickerOption[];
  hasMultipleProviders: boolean;
  selectedProviderDisplayName: string;
  selectedProviderComposerActions: readonly ProviderComposerAction[];
  selectedModel: string;
  setSelectedModel: StringSelectionSetter;
  serviceTier: ServiceTier | undefined;
  setServiceTier: ServiceTierSelectionSetter;
  reasoningLevel: ReasoningLevel;
  setReasoningLevel: ReasoningLevelSelectionSetter;
  permissionMode: PermissionMode;
  setPermissionMode: PermissionModeSelectionSetter;
  environmentSelectionValue: string;
  setEnvironmentSelectionValue: StringSelectionSetter;
  clearReuseEnvironment: ClearSelectionHandler;
  activeModel: AvailableModel | undefined;
  modelOptions: ModelPickerOption[];
  moreModelOptions: ModelPickerOption[];
  isLoadingModels: boolean;
  modelLoadFailed: boolean;
  modelLoadError: SystemExecutionOptionsModelLoadError | null;
  modelCatalogIsVerified: boolean;
  reasoningOptions: PickerOption<ReasoningLevel>[];
  permissionModeOptions: PickerOption<PermissionMode>[];
  supportsPermissionModeSelection: boolean;
  permissionModeIsVerified: boolean;
  supportsServiceTier: boolean;
  serviceTierSupportByProvider: Record<string, boolean>;
  serviceTierFastLabel: string;
  executionInputSources: TExecutionInputSources;
}

interface ResolveThreadCreationProviderRoutingArgs {
  environmentId?: string;
  environmentHostId?: string;
  environmentSelectionValue: string;
  modelCatalogScope?: ProviderModelCatalogScope;
  scope: "component-local" | "new-thread";
}

function resolveThreadCreationProviderRouting({
  environmentId,
  environmentHostId,
  environmentSelectionValue,
  modelCatalogScope,
  scope,
}: ResolveThreadCreationProviderRoutingArgs): SystemProvidersQuery {
  if (scope === "component-local") {
    if (environmentId === undefined) {
      return {};
    }
    if (
      environmentHostId !== undefined &&
      !providerModelCatalogDependsOnWorkspace(modelCatalogScope)
    ) {
      return { hostId: environmentHostId };
    }
    return { environmentId };
  }
  const parsed = parseEnvironmentValue(environmentSelectionValue);
  if (parsed?.type === "host") {
    return { hostId: parsed.hostId };
  }
  if (parsed?.type === "reuse" && parsed.environmentId !== null) {
    return { environmentId: parsed.environmentId };
  }
  return {};
}

const NO_MODEL_LOAD_ERROR: SystemExecutionOptionsModelLoadError | null = null;

type InitialReadyProviderResolution =
  | { status: "unresolved" }
  | { status: "resolved"; providerId: string | null };

function sanitizeStoredEnvironmentValue(stored: string): string {
  if (!stored) return "";
  const parsed = parseEnvironmentValue(stored);
  if (parsed?.type === "reuse") return "";
  return stored;
}

export function useThreadCreationOptions(
  options: UseComponentLocalCreationOptions,
): UseThreadCreationOptionsResult<ExistingThreadExecutionInputSources>;
export function useThreadCreationOptions(
  options?: UseNewThreadCreationOptions,
): UseThreadCreationOptionsResult<CreateExecutionInputSources>;
export function useThreadCreationOptions(
  options: UsePromptModelReasoningOptions,
): UseThreadCreationOptionsResult<ScopedExecutionInputSources>;
export function useThreadCreationOptions(
  options?: UsePromptModelReasoningOptions,
): UseThreadCreationOptionsResult<ScopedExecutionInputSources> {
  const {
    enabled = true,
    environmentId,
    environmentHostId,
    initialEnvironmentSelectionValue,
    initialModel,
    initialProviderId,
    initialPermissionMode,
    initialReasoningLevel,
    initialServiceTier,
    preferReadyProviderWhenUnset = false,
    preferenceProjectId,
    resolveProviderRouting,
    resetKey,
    scope = "new-thread",
  } = options ?? {};
  const { setValue: setStoredProviderId, value: storedProviderId } =
    usePromptBoxProviderPreference();
  const setStoredProviderModelReasoning =
    useSetPromptBoxProviderModelReasoningPreference();
  const { setValue: setStoredServiceTier, value: storedServiceTier } =
    usePromptBoxServiceTierPreference();
  const { setValue: setStoredPermissionMode, value: storedPermissionMode } =
    usePromptBoxPermissionModePreference();
  const {
    setValue: setStoredEnvironmentSelectionValue,
    value: storedEnvironmentSelectionValue,
  } = usePromptBoxEnvironmentPreference(preferenceProjectId);
  const [rootComposeReuseValue, setRootComposeReuseValue] =
    useRootComposeReuseEnvironment();
  const [threadSelections, setThreadSelections] =
    useState<ThreadPromptSelections>(() =>
      getInitialThreadPromptSelections({
        initialEnvironmentSelectionValue,
        initialModel,
        initialProviderId,
        initialPermissionMode,
        initialReasoningLevel,
        initialServiceTier,
      }),
    );
  const [initialReadyProvider, setInitialReadyProvider] =
    useState<InitialReadyProviderResolution>({ status: "unresolved" });
  const localProviderSelectionsRef = useRef<
    Map<string, ModelReasoningSelection>
  >(new Map());
  const [localProvidersUsingDefaults, setLocalProvidersUsingDefaults] =
    useState<ReadonlySet<string>>(() => new Set());
  const touchedThreadFieldsRef = useRef<Set<ThreadPromptField>>(new Set());
  const threadResetKeyRef = useRef<string | number | null | undefined>(
    resetKey,
  );
  const usesLocalThreadSelections = scope !== "new-thread";
  const usesStoredCreateSelections = scope === "new-thread";
  const nextThreadSelections = useMemo(
    () =>
      getInitialThreadPromptSelections({
        initialEnvironmentSelectionValue,
        initialModel,
        initialProviderId,
        initialPermissionMode,
        initialReasoningLevel,
        initialServiceTier,
      }),
    [
      initialEnvironmentSelectionValue,
      initialModel,
      initialProviderId,
      initialPermissionMode,
      initialReasoningLevel,
      initialServiceTier,
    ],
  );
  const renderedThreadSelections = useMemo(() => {
    if (!usesLocalThreadSelections) {
      return nextThreadSelections;
    }
    if (threadResetKeyRef.current !== resetKey) {
      return nextThreadSelections;
    }
    return syncUntouchedThreadPromptSelections({
      currentSelections: threadSelections,
      nextSelections: nextThreadSelections,
      touchedFields: touchedThreadFieldsRef.current,
    });
  }, [
    nextThreadSelections,
    resetKey,
    threadSelections,
    usesLocalThreadSelections,
  ]);

  const selectedProviderIdBeforeReadyFallback = usesStoredCreateSelections
    ? storedProviderId || renderedThreadSelections.selectedProviderId
    : renderedThreadSelections.selectedProviderId;
  const rawServiceTier = usesStoredCreateSelections
    ? storedServiceTier || renderedThreadSelections.serviceTier
    : renderedThreadSelections.serviceTier;
  const rawPermissionMode = usesStoredCreateSelections
    ? storedPermissionMode || renderedThreadSelections.permissionMode
    : renderedThreadSelections.permissionMode;
  const rawEnvironmentSelectionValue =
    scope === "new-thread"
      ? (rootComposeReuseValue ??
        sanitizeStoredEnvironmentValue(storedEnvironmentSelectionValue))
      : renderedThreadSelections.environmentSelectionValue;

  const knownModelCatalogScope = useKnownProviderModelCatalogScope(
    selectedProviderIdBeforeReadyFallback,
  );
  const executionOptionsQueryEnabled = enabled;
  const executionOptionsRouting = resolveProviderRouting
    ? resolveProviderRouting(rawEnvironmentSelectionValue)
    : resolveThreadCreationProviderRouting({
        environmentId,
        environmentHostId,
        environmentSelectionValue: rawEnvironmentSelectionValue,
        ...(knownModelCatalogScope === undefined
          ? {}
          : { modelCatalogScope: knownModelCatalogScope }),
        scope,
      });
  const canResolveReadyProvider =
    executionOptionsQueryEnabled &&
    scope === "new-thread" &&
    preferReadyProviderWhenUnset &&
    selectedProviderIdBeforeReadyFallback.length === 0;
  const shouldResolveReadyProvider =
    canResolveReadyProvider && initialReadyProvider.status === "unresolved";
  const providerStatesQuery = useSystemProviderStates({
    enabled: shouldResolveReadyProvider,
    ...executionOptionsRouting,
    poll: false,
  });
  const queriedReadyProviderId = shouldResolveReadyProvider
    ? providerStatesQuery.data?.providers.find(
        (provider) => provider.status === "ready",
      )?.providerId
    : undefined;
  const readyProviderId =
    initialReadyProvider.status === "resolved"
      ? (initialReadyProvider.providerId ?? undefined)
      : queriedReadyProviderId;
  useEffect(() => {
    if (!shouldResolveReadyProvider || providerStatesQuery.isPending) {
      return;
    }
    setInitialReadyProvider((current) =>
      current.status === "resolved"
        ? current
        : {
            status: "resolved",
            providerId: queriedReadyProviderId ?? null,
          },
    );
  }, [
    providerStatesQuery.isPending,
    queriedReadyProviderId,
    shouldResolveReadyProvider,
  ]);
  const rawSelectedProviderId =
    selectedProviderIdBeforeReadyFallback || readyProviderId || "";
  const executionOptionsProviderId = executionOptionsQueryEnabled
    ? rawSelectedProviderId || undefined
    : undefined;
  const executionOptionsQuery = useSystemExecutionOptions({
    enabled: executionOptionsQueryEnabled,
    ...executionOptionsRouting,
    providerId: executionOptionsProviderId,
  });
  const hostsQuery = useHosts();
  const systemConfig = useSystemConfig();
  const providers = executionOptionsQuery.data?.providers ?? EMPTY_PROVIDERS;
  const isLoadingModels =
    executionOptionsQueryEnabled &&
    (executionOptionsQuery.isLoading ||
      (executionOptionsQuery.isPlaceholderData &&
        (executionOptionsQuery.data?.models.length ?? 0) === 0));
  const modelLoadError =
    executionOptionsQuery.data?.modelLoadError ?? NO_MODEL_LOAD_ERROR;
  const modelLoadFailed =
    executionOptionsQuery.isError || modelLoadError !== null;
  const modelCatalogIsVerified =
    executionOptionsQuery.data !== undefined &&
    !executionOptionsQuery.isPlaceholderData &&
    !executionOptionsQuery.isError &&
    modelLoadError === null;
  const permissionModeIsVerified =
    executionOptionsQuery.data !== undefined &&
    !executionOptionsQuery.isPlaceholderData &&
    !executionOptionsQuery.isError;
  const hasMultipleProviders = providers.length >= 2;

  const effectiveProviderId = useMemo(() => {
    if (
      rawSelectedProviderId &&
      providers.some((provider) => provider.id === rawSelectedProviderId)
    ) {
      return rawSelectedProviderId;
    }
    return providers[0]?.id ?? "";
  }, [providers, rawSelectedProviderId]);

  const { setValue: setStoredSelectedModel, value: storedSelectedModel } =
    usePromptBoxModelPreference(effectiveProviderId);
  const { setValue: setStoredReasoningLevel, value: storedReasoningLevel } =
    usePromptBoxReasoningLevelPreference(effectiveProviderId);
  const effectiveProviderMatchesInitialProvider =
    effectiveProviderId.length > 0 &&
    effectiveProviderId === renderedThreadSelections.selectedProviderId;
  const rawSelectedModel = usesStoredCreateSelections
    ? storedSelectedModel ||
      (effectiveProviderMatchesInitialProvider
        ? renderedThreadSelections.selectedModel
        : "")
    : renderedThreadSelections.selectedModel;
  const preferredReasoningLevel: ReasoningLevel | undefined =
    usesStoredCreateSelections
      ? storedReasoningLevel ||
        (effectiveProviderMatchesInitialProvider
          ? initialReasoningLevel
          : undefined)
      : localProvidersUsingDefaults.has(effectiveProviderId)
        ? undefined
        : renderedThreadSelections.reasoningLevel;

  const selectedProviderInfo = useMemo(
    () => providers.find((p) => p.id === effectiveProviderId),
    [effectiveProviderId, providers],
  );

  const providerOptions = useMemo(
    (): ProviderPickerOption[] =>
      providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo(p.id, p)?.icon,
        ...(p.strings?.brandPrefix === undefined
          ? {}
          : { brandPrefix: p.strings.brandPrefix }),
        ...(p.strings?.planModeCopy === undefined
          ? {}
          : { planModeCopy: p.strings.planModeCopy }),
        ...(p.strings?.installUrl === undefined
          ? {}
          : { installUrl: p.strings.installUrl }),
      })),
    [providers],
  );

  const activeProviderCapabilities = selectedProviderInfo?.capabilities;
  const selectedProviderComposerActions =
    selectedProviderInfo?.composerActions ?? EMPTY_COMPOSER_ACTIONS;

  const supportsServiceTier =
    activeProviderCapabilities?.supportsServiceTier ?? false;
  const permissionModes: readonly PermissionMode[] =
    activeProviderCapabilities?.permissionModes ??
    DEFAULT_SUPPORTED_PERMISSION_MODES;
  const supportsPermissionModeSelection = permissionModes.length > 1;
  const routedHostCeiling = useMemo(() => {
    const hosts = hostsQuery.data;
    if (!hosts) return null;
    const routedHostId =
      executionOptionsRouting.hostId ??
      selectPrimaryHost(hosts, systemConfig.data?.primaryHostId ?? null)?.id ??
      null;
    if (routedHostId === null) return null;
    return (
      hosts.find((host) => host.id === routedHostId)?.maxPermissionMode ?? null
    );
  }, [
    executionOptionsRouting.hostId,
    hostsQuery.data,
    systemConfig.data?.primaryHostId,
  ]);
  const routedCeiling = executionOptionsQuery.isPlaceholderData
    ? undefined
    : executionOptionsQuery.data?.permissionCeiling;
  const permissionCeiling: PermissionMode =
    routedCeiling ?? routedHostCeiling ?? "full";
  const allowedPermissionModes = useMemo(
    () =>
      permissionModes.filter(
        (mode) =>
          permissionModeRank(mode) <= permissionModeRank(permissionCeiling),
      ),
    [permissionCeiling, permissionModes],
  );
  const permissionModeOptions = useMemo(
    () =>
      PERMISSION_MODE_OPTIONS.filter((option) =>
        permissionModes.includes(option.value),
      ).map((option) =>
        permissionModeRank(option.value) > permissionModeRank(permissionCeiling)
          ? {
              ...option,
              disabled: true,
              disabledReason: PERMISSION_CEILING_REASON,
            }
          : option,
      ),
    [permissionCeiling, permissionModes],
  );

  const serviceTierSupportByProvider = useMemo(() => {
    const supportByProvider: Record<string, boolean> = {};
    for (const provider of providers) {
      supportByProvider[provider.id] =
        provider.capabilities.supportsServiceTier;
    }
    return supportByProvider;
  }, [providers]);
  const serviceTierFastLabel = fastServiceTierLabel(selectedProviderInfo);

  const {
    selectedModel,
    activeModel,
    modelOptions,
    moreModelOptions,
    reasoningLevel,
    reasoningOptions,
    isUnavailableModelRecovery,
  } = useMemo(
    () =>
      resolveModelCatalogSelection({
        models: executionOptionsQuery.data?.models ?? [],
        selectedOnlyModels:
          executionOptionsQuery.data?.selectedOnlyModels ?? [],
        selectedModel: rawSelectedModel,
        preferredReasoningLevel,
        provider: selectedProviderInfo,
        catalogIsVerified: modelCatalogIsVerified,
        formatModelLabel,
      }),
    [
      executionOptionsQuery.data?.models,
      executionOptionsQuery.data?.selectedOnlyModels,
      modelCatalogIsVerified,
      preferredReasoningLevel,
      rawSelectedModel,
      selectedProviderInfo,
    ],
  );
  const serviceTier = useMemo(
    () => (supportsServiceTier ? rawServiceTier : undefined),
    [rawServiceTier, supportsServiceTier],
  );

  const permissionMode = resolvePermissionModeSelection({
    rawPermissionMode,
    permissionModes:
      allowedPermissionModes.length > 0
        ? allowedPermissionModes
        : permissionModes,
  });
  const environmentSelectionValue = rawEnvironmentSelectionValue;
  const touchedFieldsPendingReset =
    usesLocalThreadSelections && threadResetKeyRef.current !== resetKey;
  const effectiveInitialProviderSource: ExecutionInputFieldSource | undefined =
    canResolveReadyProvider &&
    readyProviderId !== undefined &&
    effectiveProviderId === readyProviderId
      ? "client-preference"
      : undefined;
  const executionInputSources = useMemo(
    () =>
      buildExecutionInputSources({
        effectiveValues: {
          selectedProviderId: effectiveProviderId,
          selectedModel,
          serviceTier,
          reasoningLevel,
          permissionMode,
        },
        forceExplicitModel: isUnavailableModelRecovery,
        initialProviderSource: effectiveInitialProviderSource,
        scope,
        storedValues: {
          selectedProviderId: storedProviderId,
          selectedModel: storedSelectedModel,
          serviceTier: storedServiceTier,
          reasoningLevel: storedReasoningLevel,
          permissionMode: storedPermissionMode,
        },
        touchedFields: touchedFieldsPendingReset
          ? new Set<ThreadPromptField>()
          : touchedThreadFieldsRef.current,
      }),
    [
      effectiveProviderId,
      effectiveInitialProviderSource,
      isUnavailableModelRecovery,
      permissionMode,
      reasoningLevel,
      scope,
      selectedModel,
      serviceTier,
      storedPermissionMode,
      storedProviderId,
      storedReasoningLevel,
      storedSelectedModel,
      storedServiceTier,
      touchedFieldsPendingReset,
    ],
  );

  useLayoutEffect(() => {
    if (!usesLocalThreadSelections) return;
    if (threadResetKeyRef.current !== resetKey) {
      threadResetKeyRef.current = resetKey;
      touchedThreadFieldsRef.current = new Set();
      localProviderSelectionsRef.current = new Map();
      setLocalProvidersUsingDefaults(new Set());
      setThreadSelections(nextThreadSelections);
      return;
    }
    setThreadSelections((currentSelections) =>
      syncUntouchedThreadPromptSelections({
        currentSelections,
        nextSelections: nextThreadSelections,
        touchedFields: touchedThreadFieldsRef.current,
      }),
    );
  }, [nextThreadSelections, resetKey, usesLocalThreadSelections]);

  const setSelectedProviderId = useCallback(
    (value: string) => {
      touchedThreadFieldsRef.current.add("selectedProviderId");
      if (usesStoredCreateSelections) {
        if (effectiveProviderId.length > 0) {
          setStoredSelectedModel(selectedModel);
          setStoredReasoningLevel(reasoningLevel);
        }
        setStoredProviderId(value);
        return;
      }
      touchedThreadFieldsRef.current.add("selectedModel");
      touchedThreadFieldsRef.current.add("reasoningLevel");
      if (effectiveProviderId.length > 0) {
        localProviderSelectionsRef.current.set(effectiveProviderId, {
          model: selectedModel,
          reasoningLevel,
        });
      }
      const rememberedSelection = localProviderSelectionsRef.current.get(value);
      setLocalProvidersUsingDefaults((current) => {
        const next = new Set(current);
        if (rememberedSelection) {
          next.delete(value);
        } else {
          next.add(value);
        }
        return next;
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedProviderId: value,
        selectedModel: rememberedSelection?.model ?? "",
        reasoningLevel:
          rememberedSelection?.reasoningLevel ??
          currentSelections.reasoningLevel,
      }));
    },
    [
      effectiveProviderId,
      reasoningLevel,
      selectedModel,
      setStoredReasoningLevel,
      setStoredSelectedModel,
      setStoredProviderId,
      usesStoredCreateSelections,
    ],
  );

  const setProviderModelReasoning = useCallback(
    ({
      providerId,
      model,
      reasoningLevel: nextReasoningLevel,
    }: ProviderModelReasoningSelection) => {
      touchedThreadFieldsRef.current.add("selectedProviderId");
      touchedThreadFieldsRef.current.add("selectedModel");
      touchedThreadFieldsRef.current.add("reasoningLevel");
      if (usesStoredCreateSelections) {
        if (
          effectiveProviderId.length > 0 &&
          effectiveProviderId !== providerId
        ) {
          setStoredSelectedModel(selectedModel);
          setStoredReasoningLevel(reasoningLevel);
        }
        setStoredProviderModelReasoning({
          providerId,
          model,
          reasoningLevel: nextReasoningLevel,
        });
        setStoredProviderId(providerId);
        return;
      }
      if (
        effectiveProviderId.length > 0 &&
        effectiveProviderId !== providerId
      ) {
        localProviderSelectionsRef.current.set(effectiveProviderId, {
          model: selectedModel,
          reasoningLevel,
        });
      }
      localProviderSelectionsRef.current.set(providerId, {
        model,
        reasoningLevel: nextReasoningLevel,
      });
      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(providerId)) return current;
        const next = new Set(current);
        next.delete(providerId);
        return next;
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedProviderId: providerId,
        selectedModel: model,
        reasoningLevel: nextReasoningLevel,
      }));
    },
    [
      effectiveProviderId,
      reasoningLevel,
      selectedModel,
      setStoredProviderId,
      setStoredProviderModelReasoning,
      setStoredReasoningLevel,
      setStoredSelectedModel,
      usesStoredCreateSelections,
    ],
  );

  const setSelectedModel = useCallback(
    (value: string) => {
      touchedThreadFieldsRef.current.add("selectedModel");
      const nextModel =
        executionOptionsQuery.data?.models.find(
          (model) => model.model === value,
        ) ??
        executionOptionsQuery.data?.selectedOnlyModels.find(
          (model) => model.model === value,
        );
      const nextReasoningLevel = resolveModelReasoningLevel(
        nextModel,
        reasoningLevel,
      );
      if (usesStoredCreateSelections) {
        setStoredProviderModelReasoning({
          providerId: effectiveProviderId,
          model: value,
          reasoningLevel: nextReasoningLevel,
        });
        return;
      }
      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(effectiveProviderId)) return current;
        const next = new Set(current);
        next.delete(effectiveProviderId);
        return next;
      });
      localProviderSelectionsRef.current.set(effectiveProviderId, {
        model: value,
        reasoningLevel: nextReasoningLevel,
      });
      setThreadSelections((currentSelections) => ({
        ...currentSelections,
        selectedModel: value,
        reasoningLevel: nextReasoningLevel,
      }));
    },
    [
      effectiveProviderId,
      executionOptionsQuery.data?.models,
      executionOptionsQuery.data?.selectedOnlyModels,
      reasoningLevel,
      setStoredProviderModelReasoning,
      usesStoredCreateSelections,
    ],
  );
  const setServiceTier = useCallback(
    (value: ServiceTier | undefined) => {
      touchedThreadFieldsRef.current.add("serviceTier");
      if (usesStoredCreateSelections) {
        setStoredServiceTier(value ?? "");
        return;
      }
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "serviceTier",
          value,
        }),
      );
    },
    [setStoredServiceTier, usesStoredCreateSelections],
  );
  const setReasoningLevel = useCallback(
    (value: ReasoningLevel) => {
      touchedThreadFieldsRef.current.add("reasoningLevel");
      if (usesStoredCreateSelections) {
        setStoredReasoningLevel(value);
        return;
      }
      setLocalProvidersUsingDefaults((current) => {
        if (!current.has(effectiveProviderId)) return current;
        const next = new Set(current);
        next.delete(effectiveProviderId);
        return next;
      });
      localProviderSelectionsRef.current.set(effectiveProviderId, {
        model: selectedModel,
        reasoningLevel: value,
      });
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "reasoningLevel",
          value,
        }),
      );
    },
    [
      effectiveProviderId,
      selectedModel,
      setStoredReasoningLevel,
      usesStoredCreateSelections,
    ],
  );
  const setPermissionMode = useCallback(
    (value: PermissionMode) => {
      touchedThreadFieldsRef.current.add("permissionMode");
      if (usesStoredCreateSelections) {
        setStoredPermissionMode(value);
        return;
      }
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "permissionMode",
          value,
        }),
      );
    },
    [setStoredPermissionMode, usesStoredCreateSelections],
  );
  const setEnvironmentSelectionValue = useCallback(
    (value: string) => {
      if (scope === "new-thread") {
        const parsed = parseEnvironmentValue(value);
        if (parsed?.type === "reuse") {
          setRootComposeReuseValue(value);
          return;
        }
        setRootComposeReuseValue(null);
        setStoredEnvironmentSelectionValue(value);
        return;
      }
      touchedThreadFieldsRef.current.add("environmentSelectionValue");
      setThreadSelections((currentSelections) =>
        updateThreadPromptSelections({
          currentSelections,
          field: "environmentSelectionValue",
          value,
        }),
      );
    },
    [scope, setRootComposeReuseValue, setStoredEnvironmentSelectionValue],
  );
  const clearReuseEnvironment = useCallback(() => {
    if (scope !== "new-thread") return;
    setRootComposeReuseValue(null);
  }, [scope, setRootComposeReuseValue]);

  return {
    executionOptionsRouting,
    selectedProviderId: effectiveProviderId,
    setSelectedProviderId,
    setProviderModelReasoning,
    providerOptions,
    hasMultipleProviders,
    selectedProviderDisplayName:
      selectedProviderInfo?.displayName ?? effectiveProviderId,
    selectedProviderComposerActions,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    permissionMode,
    setPermissionMode,
    environmentSelectionValue,
    setEnvironmentSelectionValue,
    clearReuseEnvironment,
    activeModel,
    modelOptions,
    moreModelOptions,
    isLoadingModels,
    modelLoadFailed,
    modelLoadError,
    modelCatalogIsVerified,
    reasoningOptions,
    permissionModeOptions,
    supportsPermissionModeSelection,
    permissionModeIsVerified,
    supportsServiceTier,
    serviceTierSupportByProvider,
    serviceTierFastLabel,
    executionInputSources,
  };
}
