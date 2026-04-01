import { useAtom } from "jotai";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
} from "@bb/domain";
import {
  createLocalStorageEnumStorage,
  createProjectScopedStorageAtomFamily,
  rawStringLocalStorage,
} from "@/lib/browser-storage";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  useAvailableModels,
  useSystemProviders,
} from "./queries/system-queries";

const MODEL_STORAGE_KEY = "bb.promptbox.model";
const SERVICE_TIER_STORAGE_KEY = "bb.promptbox.service-tier";
const REASONING_STORAGE_KEY = "bb.promptbox.reasoning";
const SANDBOX_STORAGE_KEY = "bb.promptbox.sandbox";
const ENVIRONMENT_STORAGE_KEY = "bb.promptbox.environment";
const PROVIDER_STORAGE_KEY = "bb.promptbox.provider";
type StoredServiceTier = "" | ServiceTier;

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
  icon?: ComponentType<{ className?: string }>;
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

interface ThreadPromptSelections {
  selectedProviderId: string;
  selectedModel: string;
  serviceTier: ServiceTier | undefined;
  reasoningLevel: ReasoningLevel;
  sandboxMode: SandboxMode;
  environmentSelectionValue: string;
}

type ThreadPromptField = keyof ThreadPromptSelections;

interface SyncThreadPromptSelectionsArgs {
  currentSelections: ThreadPromptSelections;
  nextSelections: ThreadPromptSelections;
  touchedFields: ReadonlySet<ThreadPromptField>;
}

interface UpdateThreadPromptSelectionsArgs {
  currentSelections: ThreadPromptSelections;
  field: ThreadPromptField;
  value: ThreadPromptSelections[ThreadPromptField];
}

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

function isStoredServiceTier(value: string): value is StoredServiceTier {
  return value === "" || isServiceTier(value);
}

const storedServiceTierStorage = createLocalStorageEnumStorage<StoredServiceTier>(
  isStoredServiceTier,
);
const reasoningLevelStorage = createLocalStorageEnumStorage<ReasoningLevel>(
  (value): value is ReasoningLevel => isReasoningLevel(value),
);
const sandboxModeStorage = createLocalStorageEnumStorage<SandboxMode>(
  (value): value is SandboxMode => isSandboxMode(value),
);
const providerIdAtomFamily = createProjectScopedStorageAtomFamily(
  PROVIDER_STORAGE_KEY,
  "",
  rawStringLocalStorage,
);
const modelAtomFamily = createProjectScopedStorageAtomFamily(
  MODEL_STORAGE_KEY,
  "",
  rawStringLocalStorage,
);
const serviceTierAtomFamily = createProjectScopedStorageAtomFamily<StoredServiceTier>(
  SERVICE_TIER_STORAGE_KEY,
  "",
  storedServiceTierStorage,
);
const reasoningLevelAtomFamily = createProjectScopedStorageAtomFamily(
  REASONING_STORAGE_KEY,
  "medium",
  reasoningLevelStorage,
);
const sandboxModeAtomFamily = createProjectScopedStorageAtomFamily(
  SANDBOX_STORAGE_KEY,
  "danger-full-access",
  sandboxModeStorage,
);
const environmentSelectionAtomFamily = createProjectScopedStorageAtomFamily(
  ENVIRONMENT_STORAGE_KEY,
  "",
  rawStringLocalStorage,
);

function getInitialThreadPromptSelections(
  options?: UsePromptModelReasoningOptions,
): ThreadPromptSelections {
  return {
    selectedProviderId: options?.initialProviderId ?? "",
    selectedModel: options?.initialModel ?? "",
    serviceTier: options?.initialServiceTier,
    reasoningLevel: options?.initialReasoningLevel ?? "medium",
    sandboxMode: options?.initialSandboxMode ?? "danger-full-access",
    environmentSelectionValue: options?.initialEnvironmentSelectionValue ?? "",
  };
}

function syncUntouchedThreadPromptSelections({
  currentSelections,
  nextSelections,
  touchedFields,
}: SyncThreadPromptSelectionsArgs): ThreadPromptSelections {
  let changed = false;
  const updatedSelections = { ...currentSelections };

  if (
    !touchedFields.has("selectedProviderId") &&
    currentSelections.selectedProviderId !== nextSelections.selectedProviderId
  ) {
    updatedSelections.selectedProviderId = nextSelections.selectedProviderId;
    changed = true;
  }
  if (
    !touchedFields.has("selectedModel") &&
    currentSelections.selectedModel !== nextSelections.selectedModel
  ) {
    updatedSelections.selectedModel = nextSelections.selectedModel;
    changed = true;
  }
  if (
    !touchedFields.has("serviceTier") &&
    currentSelections.serviceTier !== nextSelections.serviceTier
  ) {
    updatedSelections.serviceTier = nextSelections.serviceTier;
    changed = true;
  }
  if (
    !touchedFields.has("reasoningLevel") &&
    currentSelections.reasoningLevel !== nextSelections.reasoningLevel
  ) {
    updatedSelections.reasoningLevel = nextSelections.reasoningLevel;
    changed = true;
  }
  if (
    !touchedFields.has("sandboxMode") &&
    currentSelections.sandboxMode !== nextSelections.sandboxMode
  ) {
    updatedSelections.sandboxMode = nextSelections.sandboxMode;
    changed = true;
  }
  if (
    !touchedFields.has("environmentSelectionValue") &&
    currentSelections.environmentSelectionValue !== nextSelections.environmentSelectionValue
  ) {
    updatedSelections.environmentSelectionValue = nextSelections.environmentSelectionValue;
    changed = true;
  }

  return changed ? updatedSelections : currentSelections;
}

function updateThreadPromptSelections({
  currentSelections,
  field,
  value,
}: UpdateThreadPromptSelectionsArgs): ThreadPromptSelections {
  if (currentSelections[field] === value) {
    return currentSelections;
  }

  return {
    ...currentSelections,
    [field]: value,
  };
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

export function useThreadCreationOptions(options?: UsePromptModelReasoningOptions) {
  const scope = options?.scope ?? "new-thread";
  const [storedProviderId, setStoredProviderId] = useAtom(
    providerIdAtomFamily(options?.projectId),
  );
  const [storedSelectedModel, setStoredSelectedModel] = useAtom(
    modelAtomFamily(options?.projectId),
  );
  const [storedServiceTier, setStoredServiceTier] = useAtom(
    serviceTierAtomFamily(options?.projectId),
  );
  const [storedReasoningLevel, setStoredReasoningLevel] = useAtom(
    reasoningLevelAtomFamily(options?.projectId),
  );
  const [storedSandboxMode, setStoredSandboxMode] = useAtom(
    sandboxModeAtomFamily(options?.projectId),
  );
  const [storedEnvironmentSelectionValue, setStoredEnvironmentSelectionValue] = useAtom(
    environmentSelectionAtomFamily(options?.projectId),
  );
  const [threadSelections, setThreadSelections] = useState<ThreadPromptSelections>(() =>
    getInitialThreadPromptSelections(options),
  );
  const touchedThreadFieldsRef = useRef<Set<ThreadPromptField>>(new Set());
  const threadResetKeyRef = useRef<string | number | null | undefined>(options?.resetKey);

  // --- Provider selection ---
  const providersQuery = useSystemProviders();
  const providers = providersQuery.data ?? [];
  const hasMultipleProviders = providers.length >= 2;

  const rawSelectedProviderId =
    scope === "new-thread" ? storedProviderId : threadSelections.selectedProviderId;
  const rawSelectedModel =
    scope === "new-thread" ? storedSelectedModel : threadSelections.selectedModel;
  const rawServiceTier =
    scope === "new-thread" ? storedServiceTier || undefined : threadSelections.serviceTier;
  const rawReasoningLevel =
    scope === "new-thread" ? storedReasoningLevel : threadSelections.reasoningLevel;
  const rawSandboxMode =
    scope === "new-thread" ? storedSandboxMode : threadSelections.sandboxMode;
  const rawEnvironmentSelectionValue =
    scope === "new-thread"
      ? storedEnvironmentSelectionValue
      : threadSelections.environmentSelectionValue;

  // Resolve the effective provider: use selectedProviderId if it matches a known
  // provider, otherwise fall back to the first provider in the list.
  const effectiveProviderId = useMemo(() => {
    if (
      rawSelectedProviderId &&
      providers.some((provider) => provider.id === rawSelectedProviderId)
    ) {
      return rawSelectedProviderId;
    }
    return providers[0]?.id ?? "";
  }, [providers, rawSelectedProviderId]);

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

  const activeProviderCapabilities = selectedProviderInfo?.capabilities;

  const supportsServiceTier =
    activeProviderCapabilities?.supportsServiceTier ?? false;

  const availableModels = useMemo(
    () =>
      availableModelsQuery.data &&
      availableModelsQuery.data.length > 0
        ? availableModelsQuery.data
        : [],
    [availableModelsQuery.data],
  );
  const selectedModel = useMemo(() => {
    if (availableModels.length === 0) {
      return rawSelectedModel;
    }
    if (availableModels.some((model) => model.model === rawSelectedModel)) {
      return rawSelectedModel;
    }
    return availableModels.find((model) => model.isDefault)?.model ?? availableModels[0].model;
  }, [availableModels, rawSelectedModel]);

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
  const serviceTier = useMemo(
    () => (supportsServiceTier ? rawServiceTier : undefined),
    [rawServiceTier, supportsServiceTier],
  );
  const reasoningLevel = useMemo(() => {
    if (reasoningOptions.length === 0) {
      return rawReasoningLevel;
    }
    if (reasoningOptions.some((option) => option.value === rawReasoningLevel)) {
      return rawReasoningLevel;
    }
    return activeModel?.defaultReasoningEffort ?? reasoningOptions[0].value;
  }, [activeModel, rawReasoningLevel, reasoningOptions]);

  const environmentOptions = useMemo(
    (): PromptOption<string>[] => [
      { value: "local", label: "Direct" },
      { value: "worktree", label: "Worktree" },
    ],
    [],
  );
  const environmentSelectionValue = useMemo(() => {
    if (environmentOptions.some((option) => option.value === rawEnvironmentSelectionValue)) {
      return rawEnvironmentSelectionValue;
    }
    return environmentOptions[0]?.value ?? "";
  }, [environmentOptions, rawEnvironmentSelectionValue]);
  const sandboxMode = rawSandboxMode;

  useEffect(() => {
    if (scope !== "thread") return;
    const nextSelections = getInitialThreadPromptSelections(options);
    if (threadResetKeyRef.current !== options?.resetKey) {
      threadResetKeyRef.current = options?.resetKey;
      touchedThreadFieldsRef.current = new Set();
      setThreadSelections(nextSelections);
      return;
    }
    setThreadSelections((currentSelections) => syncUntouchedThreadPromptSelections({
      currentSelections,
      nextSelections,
      touchedFields: touchedThreadFieldsRef.current,
    }));
  }, [
    options?.initialProviderId,
    options?.initialEnvironmentSelectionValue,
    options?.initialModel,
    options?.initialReasoningLevel,
    options?.initialSandboxMode,
    options?.initialServiceTier,
    options?.resetKey,
    scope,
  ]);

  const setSelectedProviderId = useCallback(
    (value: string) => {
      if (scope === "new-thread") {
        setStoredProviderId(value);
        return;
      }
      touchedThreadFieldsRef.current.add("selectedProviderId");
      setThreadSelections((currentSelections) => updateThreadPromptSelections({
        currentSelections,
        field: "selectedProviderId",
        value,
      }));
      // Don't eagerly reset the model here — the effect that watches
      // derived values will fall back to the default if the current
      // selection isn't in the new provider's model list.
    },
    [scope, setStoredProviderId],
  );

  const setSelectedModel = useCallback((value: string) => {
    if (scope === "new-thread") {
      setStoredSelectedModel(value);
      return;
    }
    touchedThreadFieldsRef.current.add("selectedModel");
    setThreadSelections((currentSelections) => updateThreadPromptSelections({
      currentSelections,
      field: "selectedModel",
      value,
    }));
  }, [scope, setStoredSelectedModel]);
  const setServiceTier = useCallback((value: ServiceTier | undefined) => {
    if (scope === "new-thread") {
      setStoredServiceTier(value ?? "");
      return;
    }
    touchedThreadFieldsRef.current.add("serviceTier");
    setThreadSelections((currentSelections) => updateThreadPromptSelections({
      currentSelections,
      field: "serviceTier",
      value,
    }));
  }, [scope, setStoredServiceTier]);
  const setReasoningLevel = useCallback((value: ReasoningLevel) => {
    if (scope === "new-thread") {
      setStoredReasoningLevel(value);
      return;
    }
    touchedThreadFieldsRef.current.add("reasoningLevel");
    setThreadSelections((currentSelections) => updateThreadPromptSelections({
      currentSelections,
      field: "reasoningLevel",
      value,
    }));
  }, [scope, setStoredReasoningLevel]);
  const setSandboxMode = useCallback((value: SandboxMode) => {
    if (scope === "new-thread") {
      setStoredSandboxMode(value);
      return;
    }
    touchedThreadFieldsRef.current.add("sandboxMode");
    setThreadSelections((currentSelections) => updateThreadPromptSelections({
      currentSelections,
      field: "sandboxMode",
      value,
    }));
  }, [scope, setStoredSandboxMode]);
  const setEnvironmentSelectionValue = useCallback((value: string) => {
    if (scope === "new-thread") {
      setStoredEnvironmentSelectionValue(value);
      return;
    }
    touchedThreadFieldsRef.current.add("environmentSelectionValue");
    setThreadSelections((currentSelections) => updateThreadPromptSelections({
      currentSelections,
      field: "environmentSelectionValue",
      value,
    }));
  }, [scope, setStoredEnvironmentSelectionValue]);

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
