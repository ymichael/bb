import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { formatEnvironmentDisplayName } from "@bb/core";
import type {
  AvailableModel,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  SystemEnvironmentInfo,
} from "@bb/core";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  useAvailableModels,
  useSystemEnvironments,
  useSystemProvider,
  useSystemProviders,
} from "./useApi";

const MODEL_STORAGE_KEY = "bb.promptbox.model";
const SERVICE_TIER_STORAGE_KEY = "bb.promptbox.service-tier";
const REASONING_STORAGE_KEY = "bb.promptbox.reasoning";
const SANDBOX_STORAGE_KEY = "bb.promptbox.sandbox";
const ENVIRONMENT_STORAGE_KEY = "bb.promptbox.environment";
const PROVIDER_STORAGE_KEY = "bb.promptbox.provider";

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const SANDBOX_OPTIONS: PromptOption<SandboxMode>[] = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  {
    value: "danger-full-access",
    label: "Full Access",
    tone: "warning",
  },
];

interface PromptOption<T extends string> {
  value: T;
  label: string;
  tone?: "default" | "warning";
  icon?: import("react").ComponentType<{ className?: string }>;
}

interface PromptModelReasoningStorageKeys {
  provider: string;
  model: string;
  serviceTier: string;
  reasoning: string;
  sandbox: string;
  environment: string;
}

interface UsePromptModelReasoningOptions {
  scope?: "new-thread" | "thread";
  projectId?: string | null;
  resetKey?: string | number | null;
  initialProviderId?: string;
  initialModel?: string;
  initialServiceTier?: ServiceTier;
  initialReasoningLevel?: ReasoningLevel;
  initialSandboxMode?: SandboxMode;
  initialEnvironmentSelectionValue?: string;
}

interface PromptModelReasoningState {
  selectedModel: string;
  serviceTier: ServiceTier | undefined;
  reasoningLevel: ReasoningLevel;
  sandboxMode: SandboxMode;
  environmentSelectionValue: string;
  touched: {
    selectedModel: boolean;
    serviceTier: boolean;
    reasoningLevel: boolean;
    sandboxMode: boolean;
    environmentSelectionValue: boolean;
  };
}

type PromptModelReasoningField = Exclude<keyof PromptModelReasoningState, "touched">;

type PromptModelReasoningAction =
  | {
      type: "replace";
      state: PromptModelReasoningState;
    }
  | {
      type: "sync-untouched";
      state: Omit<PromptModelReasoningState, "touched">;
    }
  | {
      type: "set-field";
      field: PromptModelReasoningField;
      value: PromptModelReasoningState[PromptModelReasoningField];
      touched?: boolean;
    };

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

function isServiceTier(value: unknown): value is ServiceTier {
  return value === "fast" || value === "flex";
}

function getPromptModelReasoningStorageKeys(
  projectId?: string | null,
): PromptModelReasoningStorageKeys {
  return {
    provider: getProjectScopedStorageKey(PROVIDER_STORAGE_KEY, projectId),
    model: getProjectScopedStorageKey(MODEL_STORAGE_KEY, projectId),
    serviceTier: getProjectScopedStorageKey(SERVICE_TIER_STORAGE_KEY, projectId),
    reasoning: getProjectScopedStorageKey(REASONING_STORAGE_KEY, projectId),
    sandbox: getProjectScopedStorageKey(SANDBOX_STORAGE_KEY, projectId),
    environment: getProjectScopedStorageKey(ENVIRONMENT_STORAGE_KEY, projectId),
  };
}

function readStoredString(primaryStorageKey: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(primaryStorageKey);
}

function getStoredModel(storageKeys: PromptModelReasoningStorageKeys): string {
  return readStoredString(storageKeys.model) ?? "";
}

function getStoredReasoningLevel(storageKeys: PromptModelReasoningStorageKeys): ReasoningLevel {
  const raw = readStoredString(storageKeys.reasoning);
  return isReasoningLevel(raw) ? raw : "medium";
}

function getStoredServiceTier(
  storageKeys: PromptModelReasoningStorageKeys,
): ServiceTier | undefined {
  const raw = readStoredString(storageKeys.serviceTier);
  return isServiceTier(raw) ? raw : undefined;
}

function getStoredSandboxMode(storageKeys: PromptModelReasoningStorageKeys): SandboxMode {
  const raw = readStoredString(storageKeys.sandbox);
  return isSandboxMode(raw) ? raw : "danger-full-access";
}

function getStoredEnvironmentSelectionValue(storageKeys: PromptModelReasoningStorageKeys): string {
  return readStoredString(storageKeys.environment) ?? "";
}

function createPromptModelReasoningState(
  state: Omit<PromptModelReasoningState, "touched">,
): PromptModelReasoningState {
  return {
    ...state,
    touched: {
      selectedModel: false,
      serviceTier: false,
      reasoningLevel: false,
      sandboxMode: false,
      environmentSelectionValue: false,
    },
  };
}

function getStoredPromptModelReasoningState(
  storageKeys: PromptModelReasoningStorageKeys,
): PromptModelReasoningState {
  return createPromptModelReasoningState({
    selectedModel: getStoredModel(storageKeys),
    serviceTier: getStoredServiceTier(storageKeys),
    reasoningLevel: getStoredReasoningLevel(storageKeys),
    sandboxMode: getStoredSandboxMode(storageKeys),
    environmentSelectionValue: getStoredEnvironmentSelectionValue(storageKeys),
  });
}

function getInitialThreadPromptModelReasoningState(
  options?: UsePromptModelReasoningOptions,
): PromptModelReasoningState {
  return createPromptModelReasoningState({
    selectedModel: options?.initialModel ?? "",
    serviceTier: options?.initialServiceTier,
    reasoningLevel: options?.initialReasoningLevel ?? "medium",
    sandboxMode: options?.initialSandboxMode ?? "danger-full-access",
    environmentSelectionValue: options?.initialEnvironmentSelectionValue ?? "",
  });
}

function promptModelReasoningReducer(
  state: PromptModelReasoningState,
  action: PromptModelReasoningAction,
): PromptModelReasoningState {
  switch (action.type) {
    case "replace":
      return action.state;
    case "sync-untouched": {
      let changed = false;
      const nextState = { ...state };
      if (
        !state.touched.selectedModel &&
        state.selectedModel !== action.state.selectedModel
      ) {
        nextState.selectedModel = action.state.selectedModel;
        changed = true;
      }
      if (!state.touched.serviceTier && state.serviceTier !== action.state.serviceTier) {
        nextState.serviceTier = action.state.serviceTier;
        changed = true;
      }
      if (
        !state.touched.reasoningLevel &&
        state.reasoningLevel !== action.state.reasoningLevel
      ) {
        nextState.reasoningLevel = action.state.reasoningLevel;
        changed = true;
      }
      if (!state.touched.sandboxMode && state.sandboxMode !== action.state.sandboxMode) {
        nextState.sandboxMode = action.state.sandboxMode;
        changed = true;
      }
      if (
        !state.touched.environmentSelectionValue &&
        state.environmentSelectionValue !== action.state.environmentSelectionValue
      ) {
        nextState.environmentSelectionValue = action.state.environmentSelectionValue;
        changed = true;
      }

      return changed ? nextState : state;
    }
    case "set-field": {
      const nextTouched = action.touched ?? true;
      if (state[action.field] === action.value && state.touched[action.field] === nextTouched) {
        return state;
      }
      return {
        ...state,
        [action.field]: action.value,
        touched:
          state.touched[action.field] === nextTouched
            ? state.touched
            : {
                ...state.touched,
                [action.field]: nextTouched,
              },
      };
    }
  }
}

function toEnvironmentOptions(
  environments: readonly SystemEnvironmentInfo[] | undefined,
): PromptOption<string>[] {
  if (!environments || environments.length === 0) {
    return [];
  }
  return environments.map((environment) => ({
    value: environment.id,
    label:
      formatEnvironmentDisplayName({
        id: environment.id,
        displayName: environment.displayName,
      }) ?? environment.id,
  }));
}

export function formatModelLabel(value: string, providerId?: string): string {
  let label = value
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (/^[a-z]+$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join("-");

  // Strip "Claude " prefix for claude-code provider — the provider icon already
  // identifies the brand, so "Sonnet 4.6" is cleaner than "Claude Sonnet 4.6".
  if (providerId === "claude-code") {
    label = label.replace(/^Claude\s+/i, "");
  }

  return label;
}

export function usePromptModelReasoning(options?: UsePromptModelReasoningOptions) {
  const scope = options?.scope ?? "new-thread";
  const storageKeys = useMemo(
    () => getPromptModelReasoningStorageKeys(options?.projectId),
    [options?.projectId],
  );

  // --- Provider selection ---
  const providersQuery = useSystemProviders();
  const providers = providersQuery.data ?? [];
  const hasMultipleProviders = providers.length >= 2;

  const [selectedProviderId, setSelectedProviderIdRaw] = useState<string>(() => {
    if (scope === "thread") {
      return options?.initialProviderId ?? "";
    }
    return readStoredString(storageKeys.provider) ?? "";
  });

  // Resolve the effective provider: use selectedProviderId if it matches a known
  // provider, otherwise fall back to the first provider in the list.
  const effectiveProviderId = useMemo(() => {
    if (selectedProviderId && providers.some((p) => p.id === selectedProviderId)) {
      return selectedProviderId;
    }
    return providers[0]?.id ?? "";
  }, [providers, selectedProviderId]);

  const selectedProviderInfo = useMemo(
    () => providers.find((p) => p.id === effectiveProviderId),
    [effectiveProviderId, providers],
  );

  const providerOptions = useMemo(
    (): PromptOption<string>[] =>
      providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo(p.id)?.icon,
      })),
    [providers],
  );

  const availableModelsQuery = useAvailableModels(
    hasMultipleProviders ? effectiveProviderId || undefined : undefined,
  );
  const environmentsQuery = useSystemEnvironments();
  const providerInfoQuery = useSystemProvider();

  // Use per-provider capabilities when multiple providers are available.
  const activeProviderCapabilities = hasMultipleProviders
    ? selectedProviderInfo?.capabilities
    : providerInfoQuery.data?.capabilities;

  const supportsServiceTier =
    activeProviderCapabilities?.supportsServiceTier ?? false;

  const [state, dispatch] = useReducer(promptModelReasoningReducer, undefined, () =>
    scope === "new-thread"
      ? getStoredPromptModelReasoningState(storageKeys)
      : getInitialThreadPromptModelReasoningState(options),
  );
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(() =>
    scope === "new-thread" ? storageKeys.model : null,
  );
  const threadResetKeyRef = useRef<string | number | null | undefined>(options?.resetKey);
  const {
    selectedModel,
    serviceTier,
    reasoningLevel,
    sandboxMode,
    environmentSelectionValue,
  } = state;

  const availableModels = useMemo(
    () =>
      availableModelsQuery.data &&
      availableModelsQuery.data.length > 0
        ? availableModelsQuery.data
        : [],
    [availableModelsQuery.data],
  );

  const modelOptions = useMemo(
    (): PromptOption<string>[] =>
      availableModels.map((model) => ({
        value: model.model,
        label: formatModelLabel(model.displayName || model.model, effectiveProviderId),
      })),
    [availableModels, effectiveProviderId],
  );

  const activeModel = useMemo(
    () =>
      availableModels.find((model) => model.model === selectedModel) ??
      availableModels.find((model) => model.isDefault) ??
      availableModels[0],
    [availableModels, selectedModel],
  );

  const reasoningOptions = useMemo((): PromptOption<ReasoningLevel>[] => {
    if (!activeModel) {
      return [];
    }

    const options: PromptOption<ReasoningLevel>[] = [];
    const seen = new Set<ReasoningLevel>();
    const efforts = activeModel.supportedReasoningEfforts;

    for (const effort of efforts) {
      if (seen.has(effort.reasoningEffort)) continue;
      seen.add(effort.reasoningEffort);
      options.push({
        value: effort.reasoningEffort,
        label: REASONING_LABELS[effort.reasoningEffort],
      });
    }

    if (options.length === 0) {
      return [];
    }

    return options;
  }, [activeModel]);

  const environmentOptions = useMemo(
    () => toEnvironmentOptions(environmentsQuery.data),
    [environmentsQuery.data],
  );

  // Sync provider from localStorage when storageKeys change (project switch).
  useEffect(() => {
    if (scope !== "new-thread") return;
    const stored = readStoredString(storageKeys.provider) ?? "";
    setSelectedProviderIdRaw(stored);
  }, [scope, storageKeys.provider]);

  // For thread scope, sync from initialProviderId.
  useEffect(() => {
    if (scope !== "thread") return;
    setSelectedProviderIdRaw(options?.initialProviderId ?? "");
  }, [options?.initialProviderId, scope]);

  // Persist provider selection for new-thread scope.
  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    if (effectiveProviderId) {
      window.localStorage.setItem(storageKeys.provider, effectiveProviderId);
    } else {
      window.localStorage.removeItem(storageKeys.provider);
    }
  }, [effectiveProviderId, hydratedStorageKey, scope, storageKeys.model, storageKeys.provider]);

  useEffect(() => {
    if (availableModels.length === 0) return;
    if (availableModels.some((model) => model.model === selectedModel)) return;

    const fallbackModel =
      availableModels.find((model) => model.isDefault)?.model ?? availableModels[0].model;
    dispatch({
      type: "set-field",
      field: "selectedModel",
      value: fallbackModel,
      touched: false,
    });
  }, [availableModels, selectedModel]);

  useEffect(() => {
    if (supportsServiceTier) return;
    if (serviceTier !== undefined) {
      dispatch({
        type: "set-field",
        field: "serviceTier",
        value: undefined,
        touched: false,
      });
    }
  }, [serviceTier, supportsServiceTier]);

  useEffect(() => {
    if (reasoningOptions.length === 0) {
      return;
    }
    if (!reasoningOptions.some((option) => option.value === reasoningLevel)) {
      dispatch({
        type: "set-field",
        field: "reasoningLevel",
        value: activeModel?.defaultReasoningEffort ?? reasoningOptions[0].value,
        touched: false,
      });
    }
  }, [activeModel, reasoningLevel, reasoningOptions]);

  useEffect(() => {
    if (environmentOptions.length === 0) return;
    if (environmentOptions.some((option) => option.value === environmentSelectionValue)) return;
    dispatch({
      type: "set-field",
      field: "environmentSelectionValue",
      value: environmentOptions[0].value,
      touched: false,
    });
  }, [environmentOptions, environmentSelectionValue]);

  useEffect(() => {
    if (scope !== "new-thread") {
      setHydratedStorageKey(null);
      return;
    }

    dispatch({
      type: "replace",
      state: getStoredPromptModelReasoningState(storageKeys),
    });
    setHydratedStorageKey(storageKeys.model);
  }, [scope, storageKeys]);

  useEffect(() => {
    if (scope !== "thread") return;
    const nextState = getInitialThreadPromptModelReasoningState(options);
    if (threadResetKeyRef.current !== options?.resetKey) {
      threadResetKeyRef.current = options?.resetKey;
      dispatch({
        type: "replace",
        state: nextState,
      });
      return;
    }
    dispatch({
      type: "sync-untouched",
      state: {
        selectedModel: nextState.selectedModel,
        serviceTier: nextState.serviceTier,
        reasoningLevel: nextState.reasoningLevel,
        sandboxMode: nextState.sandboxMode,
        environmentSelectionValue: nextState.environmentSelectionValue,
      },
    });
  }, [
    options,
    options?.initialEnvironmentSelectionValue,
    options?.initialModel,
    options?.initialReasoningLevel,
    options?.initialSandboxMode,
    options?.initialServiceTier,
    options?.resetKey,
    scope,
  ]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    if (selectedModel) {
      window.localStorage.setItem(storageKeys.model, selectedModel);
    } else {
      window.localStorage.removeItem(storageKeys.model);
    }
    if (serviceTier) {
      window.localStorage.setItem(storageKeys.serviceTier, serviceTier);
    } else {
      window.localStorage.removeItem(storageKeys.serviceTier);
    }
    window.localStorage.setItem(storageKeys.reasoning, reasoningLevel);
    window.localStorage.setItem(storageKeys.sandbox, sandboxMode);
    if (environmentSelectionValue) {
      window.localStorage.setItem(storageKeys.environment, environmentSelectionValue);
    } else {
      window.localStorage.removeItem(storageKeys.environment);
    }
  }, [
    environmentSelectionValue,
    hydratedStorageKey,
    reasoningLevel,
    sandboxMode,
    scope,
    selectedModel,
    serviceTier,
    storageKeys.environment,
    storageKeys.model,
    storageKeys.reasoning,
    storageKeys.sandbox,
    storageKeys.serviceTier,
  ]);

  const setSelectedProviderId = useCallback(
    (value: string) => {
      setSelectedProviderIdRaw(value);
      // Don't eagerly reset the model here — the effect that watches
      // availableModels will fall back to the default if the current
      // selection isn't in the new provider's model list.
    },
    [],
  );

  const setSelectedModel = useCallback((value: string) => {
    dispatch({
      type: "set-field",
      field: "selectedModel",
      value,
    });
  }, []);
  const setServiceTier = useCallback((value: ServiceTier | undefined) => {
    dispatch({
      type: "set-field",
      field: "serviceTier",
      value,
    });
  }, []);
  const setReasoningLevel = useCallback((value: ReasoningLevel) => {
    dispatch({
      type: "set-field",
      field: "reasoningLevel",
      value,
    });
  }, []);
  const setSandboxMode = useCallback((value: SandboxMode) => {
    dispatch({
      type: "set-field",
      field: "sandboxMode",
      value,
    });
  }, []);
  const setEnvironmentSelectionValue = useCallback((value: string) => {
    dispatch({
      type: "set-field",
      field: "environmentSelectionValue",
      value,
    });
  }, []);

  return {
    selectedProviderId: effectiveProviderId,
    setSelectedProviderId,
    providerOptions,
    hasMultipleProviders,
    selectedProviderDisplayName: selectedProviderInfo?.displayName ?? effectiveProviderId,
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    environmentSelectionValue,
    setEnvironmentSelectionValue,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions: SANDBOX_OPTIONS,
    environmentOptions,
    supportsServiceTier,
  };
}
