import { useEffect, useMemo, useState } from "react";
import type {
  AvailableModel,
  EnvironmentCapability,
  ReasoningLevel,
  SandboxMode,
  SystemEnvironmentInfo,
  SystemWorkflowInfo,
  WorkflowKind,
} from "@beanbag/agent-core";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";
import {
  useAvailableModels,
  useSystemEnvironments,
  useSystemProvider,
  useSystemWorkflows,
} from "./useApi";

const MODEL_STORAGE_KEY = "beanbag.promptbox.model";
const REASONING_STORAGE_KEY = "beanbag.promptbox.reasoning";
const SANDBOX_STORAGE_KEY = "beanbag.promptbox.sandbox";
const ENVIRONMENT_STORAGE_KEY = "beanbag.promptbox.environment";
const WORKFLOW_STORAGE_KEY = "beanbag.promptbox.workflow";

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
  reasoning: string;
  sandbox: string;
  environment: string;
  workflow: string;
}

interface UsePromptModelReasoningOptions {
  scope?: "new-thread" | "thread";
  projectId?: string | null;
  initialModel?: string;
  initialReasoningLevel?: ReasoningLevel;
  initialSandboxMode?: SandboxMode;
  initialEnvironmentId?: string;
  initialWorkflowId?: WorkflowKind;
}

const FALLBACK_WORKFLOWS: SystemWorkflowInfo[] = [
  {
    kind: "noop",
    displayName: "No Structured Workflow",
    description: "No pre-defined branch, commit, or merge policy.",
    requiredEnvironmentCapabilities: [],
  },
  {
    kind: "branch-commit-merge",
    displayName: "Branch, Commit, Merge",
    description: "Work in an isolated branch workspace and complete with commit and merge-back.",
    requiredEnvironmentCapabilities: [
      "isolated_workspace",
      "promote_primary_checkout",
      "demote_primary_checkout",
      "squash_merge",
    ],
  },
];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

function getPromptModelReasoningStorageKeys(
  projectId?: string | null,
): PromptModelReasoningStorageKeys {
  return {
    model: getProjectScopedStorageKey(MODEL_STORAGE_KEY, projectId),
    reasoning: getProjectScopedStorageKey(REASONING_STORAGE_KEY, projectId),
    sandbox: getProjectScopedStorageKey(SANDBOX_STORAGE_KEY, projectId),
    environment: getProjectScopedStorageKey(ENVIRONMENT_STORAGE_KEY, projectId),
    workflow: getProjectScopedStorageKey(WORKFLOW_STORAGE_KEY, projectId),
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

function getStoredWorkflowId(
  storageKeys: PromptModelReasoningStorageKeys,
  fallbackStorageKeys?: PromptModelReasoningStorageKeys,
): WorkflowKind {
  const raw = readStoredString(storageKeys.workflow, fallbackStorageKeys?.workflow);
  return raw === "branch-commit-merge" || raw === "noop" ? raw : "noop";
}

function supportsCapabilities(
  environment: SystemEnvironmentInfo,
  capabilities: readonly EnvironmentCapability[],
): boolean {
  return capabilities.every((capability) => environment.capabilities[capability] === true);
}

function toEnvironmentOptions(
  environments: readonly SystemEnvironmentInfo[] | undefined,
  workflows: readonly SystemWorkflowInfo[] | undefined,
  workflowId: WorkflowKind,
): PromptOption<string>[] {
  const workflow = (workflows ?? FALLBACK_WORKFLOWS).find((item) => item.kind === workflowId)
    ?? FALLBACK_WORKFLOWS[0];
  const source = environments && environments.length > 0
    ? environments
    : [
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
  return source
    .filter((environment) =>
      supportsCapabilities(environment, workflow.requiredEnvironmentCapabilities)
    )
    .map((environment) => ({
      value: environment.id,
      label: environment.displayName,
    }));
}

function toWorkflowOptions(
  workflows: readonly SystemWorkflowInfo[] | undefined,
): PromptOption<WorkflowKind>[] {
  const source = workflows && workflows.length > 0 ? workflows : FALLBACK_WORKFLOWS;
  return source.map((workflow) => ({
    value: workflow.kind,
    label: workflow.displayName,
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

export function usePromptModelReasoning(
  options?: UsePromptModelReasoningOptions,
) {
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
  const workflowsQuery = useSystemWorkflows();
  const providerInfoQuery = useSystemProvider();
  const supportsModelList =
    providerInfoQuery.data?.capabilities.supportsModelList ?? true;
  const supportsReasoningLevels =
    providerInfoQuery.data?.capabilities.supportsReasoningLevels ?? true;
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    scope === "new-thread"
      ? getStoredModel(storageKeys, fallbackStorageKeys)
      : (options?.initialModel ?? ""),
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
  const [workflowId, setWorkflowId] = useState<WorkflowKind>(() =>
    scope === "new-thread"
      ? getStoredWorkflowId(storageKeys, fallbackStorageKeys)
      : (options?.initialWorkflowId ?? "noop"),
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

  const reasoningOptions = useMemo(
    (): PromptOption<ReasoningLevel>[] => {
      if (!supportsReasoningLevels) {
        return [{ value: "medium", label: REASONING_LABELS.medium }];
      }
      const options: PromptOption<ReasoningLevel>[] = [];
      const seen = new Set<ReasoningLevel>();
      const efforts =
        activeModel?.supportedReasoningEfforts ??
        FALLBACK_MODELS[0].supportedReasoningEfforts;

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
    },
    [activeModel, supportsReasoningLevels],
  );
  const workflowOptions = useMemo(
    (): PromptOption<WorkflowKind>[] => toWorkflowOptions(workflowsQuery.data),
    [workflowsQuery.data],
  );
  const environmentOptions = useMemo(
    () => toEnvironmentOptions(environmentsQuery.data, workflowsQuery.data, workflowId),
    [environmentsQuery.data, workflowId, workflowsQuery.data],
  );

  useEffect(() => {
    if (availableModels.length === 0) return;
    const hasSelection = availableModels.some(
      (model) => model.model === selectedModel,
    );
    if (hasSelection) return;

    const fallbackModel =
      availableModels.find((model) => model.isDefault)?.model ??
      availableModels[0].model;
    setSelectedModel(fallbackModel);
  }, [availableModels, selectedModel]);

  useEffect(() => {
    if (!supportsReasoningLevels && reasoningLevel !== "medium") {
      setReasoningLevel("medium");
      return;
    }
    if (!reasoningOptions.some((option) => option.value === reasoningLevel)) {
      setReasoningLevel(
        activeModel?.defaultReasoningEffort ?? reasoningOptions[0].value,
      );
    }
  }, [activeModel, reasoningLevel, reasoningOptions, supportsReasoningLevels]);

  useEffect(() => {
    if (workflowOptions.length === 0) return;
    if (workflowOptions.some((option) => option.value === workflowId)) return;
    setWorkflowId(workflowOptions[0].value);
  }, [workflowId, workflowOptions]);

  useEffect(() => {
    if (environmentOptions.length === 0) return;
    const hasSelection = environmentOptions.some(
      (option) => option.value === environmentId,
    );
    if (hasSelection) return;
    setEnvironmentId(environmentOptions[0].value);
  }, [environmentId, environmentOptions]);

  useEffect(() => {
    if (scope !== "new-thread") {
      setHydratedStorageKey(null);
      return;
    }

    setSelectedModel(getStoredModel(storageKeys, fallbackStorageKeys));
    setReasoningLevel(getStoredReasoningLevel(storageKeys, fallbackStorageKeys));
    setSandboxMode(getStoredSandboxMode(storageKeys, fallbackStorageKeys));
    setEnvironmentId(getStoredEnvironmentId(storageKeys, fallbackStorageKeys));
    setWorkflowId(getStoredWorkflowId(storageKeys, fallbackStorageKeys));
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
    if (scope !== "thread") return;
    if (options?.initialWorkflowId !== undefined) {
      setWorkflowId(options.initialWorkflowId);
    }
  }, [options?.initialWorkflowId, scope]);

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
  }, [
    environmentId,
    hydratedStorageKey,
    scope,
    storageKeys.environment,
    storageKeys.model,
  ]);

  useEffect(() => {
    if (scope !== "new-thread") return;
    if (hydratedStorageKey !== storageKeys.model) return;
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKeys.workflow, workflowId);
  }, [hydratedStorageKey, scope, storageKeys.model, storageKeys.workflow, workflowId]);

  return {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    environmentId,
    setEnvironmentId,
    workflowId,
    setWorkflowId,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions: SANDBOX_OPTIONS,
    environmentOptions,
    workflowOptions,
    supportsModelList,
    supportsReasoningLevels,
  };
}
