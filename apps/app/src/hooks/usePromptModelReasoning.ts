import { useEffect, useMemo, useState } from "react";
import { formatEnvironmentDisplayName } from "@beanbag/agent-core";
import type {
  AvailableModel,
  ReasoningLevel,
  SandboxMode,
  ServiceTier,
  SystemEnvironmentInfo,
} from "@beanbag/agent-core";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import {
  useAvailableModels,
  useSystemEnvironments,
  useSystemProvider,
} from "./useApi";

const MODEL_STORAGE_KEY = "beanbag.promptbox.model";
const SERVICE_TIER_STORAGE_KEY = "beanbag.promptbox.service-tier";
const REASONING_STORAGE_KEY = "beanbag.promptbox.reasoning";
const SANDBOX_STORAGE_KEY = "beanbag.promptbox.sandbox";
const ENVIRONMENT_STORAGE_KEY = "beanbag.promptbox.environment";

const FALLBACK_REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

const FALLBACK_MODELS: AvailableModel[] = [
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "gpt-5.3-codex",
    description: "Latest frontier agentic coding model.",
    supportedReasoningEfforts: FALLBACK_REASONING_OPTIONS.map((option) => ({
      reasoningEffort: option.value,
      description: `${option.label} reasoning effort`,
    })),
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
];

const FALLBACK_ENVIRONMENTS: SystemEnvironmentInfo[] = [
  {
    id: "local",
    displayName: "Local Workspace",
    capabilities: {
      host_filesystem: true,
      isolated_workspace: false,
      promote_primary_checkout: false,
      demote_primary_checkout: false,
      squash_merge: false,
    },
  },
];

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
}

interface PromptModelReasoningStorageKeys {
  model: string;
  serviceTier: string;
  reasoning: string;
  sandbox: string;
  environment: string;
}

interface UsePromptModelReasoningOptions {
  scope?: "new-thread" | "thread";
  projectId?: string | null;
  initialModel?: string;
  initialServiceTier?: ServiceTier;
  initialReasoningLevel?: ReasoningLevel;
  initialSandboxMode?: SandboxMode;
  initialEnvironmentId?: string;
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

function getPromptModelReasoningStorageKeys(
  projectId?: string | null,
): PromptModelReasoningStorageKeys {
  return {
    model: getProjectScopedStorageKey(MODEL_STORAGE_KEY, projectId),
    serviceTier: getProjectScopedStorageKey(SERVICE_TIER_STORAGE_KEY, projectId),
    reasoning: getProjectScopedStorageKey(REASONING_STORAGE_KEY, projectId),
    sandbox: getProjectScopedStorageKey(SANDBOX_STORAGE_KEY, projectId),
    environment: getProjectScopedStorageKey(ENVIRONMENT_STORAGE_KEY, projectId),
  };
}

function readStoredString(primaryStorageKey: string, fallbackStorageKey?: string): string | null {
  if (typeof window === "undefined") return null;

  const scopedValue = window.localStorage.getItem(primaryStorageKey);
  if (scopedValue !== null) {
    return scopedValue;
  }

  if (!fallbackStorageKey || fallbackStorageKey === primaryStorageKey) {
    return null;
  }

  return window.localStorage.getItem(fallbackStorageKey);
}

function getStoredModel(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): string {
  return readStoredString(storageKeys.model, fallbackStorageKeys?.model) ?? "";
}

function getStoredReasoningLevel(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): ReasoningLevel {
  const raw = readStoredString(storageKeys.reasoning, fallbackStorageKeys?.reasoning);
  return isReasoningLevel(raw) ? raw : "medium";
}

function getStoredServiceTier(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): ServiceTier | undefined {
  const raw = readStoredString(storageKeys.serviceTier, fallbackStorageKeys?.serviceTier);
  return isServiceTier(raw) ? raw : undefined;
}

function getStoredSandboxMode(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): SandboxMode {
  const raw = readStoredString(storageKeys.sandbox, fallbackStorageKeys?.sandbox);
  return isSandboxMode(raw) ? raw : "danger-full-access";
}

function getStoredEnvironmentId(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): string {
  return readStoredString(storageKeys.environment, fallbackStorageKeys?.environment) ?? "local";
}

function toEnvironmentOptions(
  environments: readonly SystemEnvironmentInfo[] | undefined,
): PromptOption<string>[] {
  const source = environments && environments.length > 0 ? environments : FALLBACK_ENVIRONMENTS;
  return source.map((environment) => ({
    value: environment.id,
    label:
      formatEnvironmentDisplayName({
        id: environment.id,
        displayName: environment.displayName,
      }) ?? environment.id,
  }));
}

function formatModelLabel(value: string): string {
  return value
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
}

export function usePromptModelReasoning(options?: UsePromptModelReasoningOptions) {
  const scope = options?.scope ?? "new-thread";
  const storageKeys = useMemo(
    () => getPromptModelReasoningStorageKeys(options?.projectId),
    [options?.projectId],
  );
  const fallbackStorageKeys = useMemo(
    () => (options?.projectId ? getPromptModelReasoningStorageKeys() : undefined),
    [options?.projectId],
  );

  const availableModelsQuery = useAvailableModels();
  const environmentsQuery = useSystemEnvironments();
  const providerInfoQuery = useSystemProvider();
  const supportsModelList = providerInfoQuery.data?.capabilities.supportsModelList ?? true;
  const supportsReasoningLevels =
    providerInfoQuery.data?.capabilities.supportsReasoningLevels ?? true;
  const supportsServiceTier =
    providerInfoQuery.data?.capabilities.supportsServiceTier ?? false;

  const [selectedModel, setSelectedModel] = useState<string>(() =>
    scope === "new-thread"
      ? getStoredModel(storageKeys, fallbackStorageKeys)
      : (options?.initialModel ?? ""),
  );
  const [serviceTier, setServiceTier] = useState<ServiceTier | undefined>(() =>
    scope === "new-thread"
      ? getStoredServiceTier(storageKeys, fallbackStorageKeys)
      : options?.initialServiceTier,
  );
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() =>
    scope === "new-thread"
      ? getStoredReasoningLevel(storageKeys, fallbackStorageKeys)
      : (options?.initialReasoningLevel ?? "medium"),
  );
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(() =>
    scope === "new-thread"
      ? getStoredSandboxMode(storageKeys, fallbackStorageKeys)
      : (options?.initialSandboxMode ?? "danger-full-access"),
  );
  const [environmentId, setEnvironmentId] = useState<string>(() =>
    scope === "new-thread"
      ? getStoredEnvironmentId(storageKeys, fallbackStorageKeys)
      : (options?.initialEnvironmentId ?? "local"),
  );
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(() =>
    scope === "new-thread" ? storageKeys.model : null,
  );

  const availableModels = useMemo(
    () =>
      supportsModelList &&
      availableModelsQuery.data &&
      availableModelsQuery.data.length > 0
        ? availableModelsQuery.data
        : FALLBACK_MODELS,
    [availableModelsQuery.data, supportsModelList],
  );

  const modelOptions = useMemo(
    (): PromptOption<string>[] =>
      availableModels.map((model) => ({
        value: model.model,
        label: formatModelLabel(model.displayName || model.model),
      })),
    [availableModels],
  );

  const activeModel = useMemo(
    () =>
      availableModels.find((model) => model.model === selectedModel) ??
      availableModels.find((model) => model.isDefault) ??
      availableModels[0],
    [availableModels, selectedModel],
  );

  const reasoningOptions = useMemo((): PromptOption<ReasoningLevel>[] => {
    if (!supportsReasoningLevels) {
      return [{ value: "medium", label: REASONING_LABELS.medium }];
    }

    const options: PromptOption<ReasoningLevel>[] = [];
    const seen = new Set<ReasoningLevel>();
    const efforts =
      activeModel?.supportedReasoningEfforts ?? FALLBACK_MODELS[0].supportedReasoningEfforts;

    for (const effort of efforts) {
      if (seen.has(effort.reasoningEffort)) continue;
      seen.add(effort.reasoningEffort);
      options.push({
        value: effort.reasoningEffort,
        label: REASONING_LABELS[effort.reasoningEffort],
      });
    }

    if (options.length === 0) {
      return FALLBACK_REASONING_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
      }));
    }

    return options;
  }, [activeModel, supportsReasoningLevels]);

  const environmentOptions = useMemo(
    () => toEnvironmentOptions(environmentsQuery.data),
    [environmentsQuery.data],
  );
  useEffect(() => {
    if (availableModels.length === 0) return;
    if (availableModels.some((model) => model.model === selectedModel)) return;

    const fallbackModel =
      availableModels.find((model) => model.isDefault)?.model ?? availableModels[0].model;
    setSelectedModel(fallbackModel);
  }, [availableModels, selectedModel]);

  useEffect(() => {
    if (supportsServiceTier) return;
    if (serviceTier !== undefined) {
      setServiceTier(undefined);
    }
  }, [serviceTier, supportsServiceTier]);

  useEffect(() => {
    if (!supportsReasoningLevels && reasoningLevel !== "medium") {
      setReasoningLevel("medium");
      return;
    }
    if (!reasoningOptions.some((option) => option.value === reasoningLevel)) {
      setReasoningLevel(activeModel?.defaultReasoningEffort ?? reasoningOptions[0].value);
    }
  }, [activeModel, reasoningLevel, reasoningOptions, supportsReasoningLevels]);

  useEffect(() => {
    if (environmentOptions.length === 0) return;
    if (environmentOptions.some((option) => option.value === environmentId)) return;
    setEnvironmentId(environmentOptions[0].value);
  }, [environmentId, environmentOptions]);

  useEffect(() => {
    if (scope !== "new-thread") {
      setHydratedStorageKey(null);
      return;
    }

    setSelectedModel(getStoredModel(storageKeys, fallbackStorageKeys));
    setServiceTier(getStoredServiceTier(storageKeys, fallbackStorageKeys));
    setReasoningLevel(getStoredReasoningLevel(storageKeys, fallbackStorageKeys));
    setSandboxMode(getStoredSandboxMode(storageKeys, fallbackStorageKeys));
    setEnvironmentId(getStoredEnvironmentId(storageKeys, fallbackStorageKeys));
    setHydratedStorageKey(storageKeys.model);
  }, [fallbackStorageKeys, scope, storageKeys]);

  useEffect(() => {
    if (scope !== "thread") return;
    if (options?.initialModel !== undefined) {
      setSelectedModel(options.initialModel);
    }
  }, [options?.initialModel, scope]);

  useEffect(() => {
    if (scope !== "thread") return;
    setServiceTier(options?.initialServiceTier);
  }, [options?.initialServiceTier, scope]);

  useEffect(() => {
    if (scope !== "thread") return;
    if (options?.initialReasoningLevel !== undefined) {
      setReasoningLevel(options.initialReasoningLevel);
    }
  }, [options?.initialReasoningLevel, scope]);

  useEffect(() => {
    if (scope !== "thread") return;
    if (options?.initialSandboxMode !== undefined) {
      setSandboxMode(options.initialSandboxMode);
    }
  }, [options?.initialSandboxMode, scope]);

  useEffect(() => {
    if (scope !== "thread") return;
    if (options?.initialEnvironmentId !== undefined) {
      setEnvironmentId(options.initialEnvironmentId);
    }
  }, [options?.initialEnvironmentId, scope]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined" || !selectedModel) return;
    window.localStorage.setItem(storageKeys.model, selectedModel);
  }, [hydratedStorageKey, scope, selectedModel, storageKeys.model]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    if (serviceTier) {
      window.localStorage.setItem(storageKeys.serviceTier, serviceTier);
      return;
    }
    window.localStorage.removeItem(storageKeys.serviceTier);
  }, [hydratedStorageKey, scope, serviceTier, storageKeys.model, storageKeys.serviceTier]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKeys.reasoning, reasoningLevel);
  }, [hydratedStorageKey, reasoningLevel, scope, storageKeys.model, storageKeys.reasoning]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKeys.sandbox, sandboxMode);
  }, [hydratedStorageKey, sandboxMode, scope, storageKeys.model, storageKeys.sandbox]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKeys.environment, environmentId);
  }, [environmentId, hydratedStorageKey, scope, storageKeys.environment, storageKeys.model]);

  return {
    selectedModel,
    setSelectedModel,
    serviceTier,
    setServiceTier,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    environmentId,
    setEnvironmentId,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions: SANDBOX_OPTIONS,
    environmentOptions,
    supportsModelList,
    supportsReasoningLevels,
    supportsServiceTier,
  };
}
