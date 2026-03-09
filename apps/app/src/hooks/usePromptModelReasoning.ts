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

function getStoredEnvironmentId(storageKeys: PromptModelReasoningStorageKeys): string {
  return readStoredString(storageKeys.environment) ?? "";
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

  const availableModelsQuery = useAvailableModels();
  const environmentsQuery = useSystemEnvironments();
  const providerInfoQuery = useSystemProvider();
  const supportsModelList = providerInfoQuery.data?.capabilities.supportsModelList ?? false;
  const supportsReasoningLevels =
    providerInfoQuery.data?.capabilities.supportsReasoningLevels ?? false;
  const supportsServiceTier =
    providerInfoQuery.data?.capabilities.supportsServiceTier ?? false;

  const [selectedModel, setSelectedModel] = useState<string>(() =>
    scope === "new-thread"
      ? getStoredModel(storageKeys)
      : (options?.initialModel ?? ""),
  );
  const [serviceTier, setServiceTier] = useState<ServiceTier | undefined>(() =>
    scope === "new-thread"
      ? getStoredServiceTier(storageKeys)
      : options?.initialServiceTier,
  );
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() =>
    scope === "new-thread"
      ? getStoredReasoningLevel(storageKeys)
      : (options?.initialReasoningLevel ?? "medium"),
  );
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(() =>
    scope === "new-thread"
      ? getStoredSandboxMode(storageKeys)
      : (options?.initialSandboxMode ?? "danger-full-access"),
  );
  const [environmentId, setEnvironmentId] = useState<string>(() =>
    scope === "new-thread"
      ? getStoredEnvironmentId(storageKeys)
      : (options?.initialEnvironmentId ?? ""),
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
        : [],
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
    if (!supportsReasoningLevels || !activeModel) {
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
    if (reasoningOptions.length === 0) {
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

    setSelectedModel(getStoredModel(storageKeys));
    setServiceTier(getStoredServiceTier(storageKeys));
    setReasoningLevel(getStoredReasoningLevel(storageKeys));
    setSandboxMode(getStoredSandboxMode(storageKeys));
    setEnvironmentId(getStoredEnvironmentId(storageKeys));
    setHydratedStorageKey(storageKeys.model);
  }, [scope, storageKeys]);

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
    if (typeof window === "undefined") return;
    if (!selectedModel) {
      window.localStorage.removeItem(storageKeys.model);
      return;
    }
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
    if (environmentId) {
      window.localStorage.setItem(storageKeys.environment, environmentId);
      return;
    }
    window.localStorage.removeItem(storageKeys.environment);
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
