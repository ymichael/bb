import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import type {
  AvailableModel,
  Host,
  ProviderInfo,
  ReasoningLevel,
} from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { HireProjectManagerRequest } from "@/hooks/mutations/project-mutations";
import { Button } from "@/components/ui/button.js";
import { DetailCard, DetailRow } from "@/components/ui/detail-card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { FormError } from "@/components/ui/form-error.js";
import { Icon } from "@/components/ui/icon.js";
import { Input } from "@/components/ui/input.js";
import { useHireProjectManager } from "@/hooks/mutations/project-mutations";
import { useNewManagerDialog } from "@/hooks/useNewManagerDialog";
import { useSystemExecutionOptions } from "@/hooks/queries/system-queries";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import { useProjects } from "@/hooks/queries/project-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  OptionPicker,
  type PickerOption,
} from "@/components/pickers/OptionPicker";
import { ProviderModelPicker } from "@/components/pickers/ProviderModelPicker";
import { HostPicker } from "@/components/pickers/HostPicker";

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
const EMPTY_PROVIDERS: ProviderInfo[] = [];
const EMPTY_MODELS: AvailableModel[] = [];
const EMPTY_PROJECTS: ProjectResponse[] = [];
const EMPTY_PROJECT_SOURCES: ProjectResponse["sources"] = [];
type ReasoningSelectionSource = "default" | "user";

type IsLocalHostFn = (id: string | null | undefined) => boolean;

export function NewManagerDialog() {
  const { state, setOpen } = useNewManagerDialog();
  return (
    <Dialog open={state.isOpen} onOpenChange={setOpen}>
      <DialogContent className="gap-3 md:max-w-md">
        <DialogHeader>
          <DialogTitle>New Manager</DialogTitle>
          <DialogDescription>
            A manager is a teammate that coordinates work for you and delegates
            to worker threads.
          </DialogDescription>
        </DialogHeader>
        {state.isOpen && state.initialProjectId ? (
          <NewManagerDialogBody
            key={state.initialProjectId}
            initialProjectId={state.initialProjectId}
            onClose={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface NewManagerDialogBodyProps {
  initialProjectId: string;
  onClose: () => void;
}

function NewManagerDialogBody({
  initialProjectId,
  onClose,
}: NewManagerDialogBodyProps) {
  const navigate = useNavigate();
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [selectedProviderId, setSelectedProviderId] = useState("");

  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const projectsAreLoaded = projectsQuery.data !== undefined;
  const { data: hosts = [] } = useEffectiveHosts();
  const { isLocalHost } = useHostDaemon();

  const executionOptionsQuery = useSystemExecutionOptions({
    providerId: selectedProviderId || undefined,
  });
  const providers = executionOptionsQuery.data?.providers ?? EMPTY_PROVIDERS;
  const providersAreLoaded = executionOptionsQuery.data !== undefined;
  const models = executionOptionsQuery.data?.models ?? EMPTY_MODELS;

  const hireManager = useHireProjectManager();
  const handleHire = useCallback(
    async (params: HireProjectManagerRequest) => {
      const thread = await hireManager.mutateAsync(params);
      onClose();
      navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
    },
    [hireManager, navigate, onClose],
  );

  return (
    <NewManagerForm
      projectId={selectedProjectId}
      projects={projects}
      projectsAreLoaded={projectsAreLoaded}
      providers={providers}
      providersAreLoaded={providersAreLoaded}
      hosts={hosts}
      isLocalHost={isLocalHost}
      models={models}
      selectedProviderId={selectedProviderId}
      onSelectedProviderIdChange={setSelectedProviderId}
      onProjectChange={setSelectedProjectId}
      onHire={handleHire}
      isHirePending={hireManager.isPending}
    />
  );
}

export interface NewManagerFormProps {
  projectId: string;
  projects: readonly ProjectResponse[];
  projectsAreLoaded: boolean;
  providers: readonly ProviderInfo[];
  providersAreLoaded: boolean;
  hosts: Host[];
  isLocalHost: IsLocalHostFn;
  models: readonly AvailableModel[];
  selectedProviderId: string;
  onSelectedProviderIdChange: (providerId: string) => void;
  onProjectChange: (projectId: string) => void;
  onHire: (params: HireProjectManagerRequest) => Promise<void>;
  isHirePending: boolean;
}

export function NewManagerForm({
  projectId,
  projects,
  projectsAreLoaded,
  providers,
  providersAreLoaded,
  hosts,
  isLocalHost,
  models,
  selectedProviderId,
  onSelectedProviderIdChange,
  onProjectChange,
  onHire,
  isHirePending,
}: NewManagerFormProps) {
  const nameInputId = useId();

  const [managerName, setManagerName] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<
    ReasoningLevel | ""
  >("");
  const [reasoningSelectionSource, setReasoningSelectionSource] =
    useState<ReasoningSelectionSource>("default");
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProvider = useMemo(() => {
    if (selectedProviderId) {
      const matchingProvider = providers.find(
        (provider) => provider.id === selectedProviderId,
      );
      if (matchingProvider) return matchingProvider;
    }
    return providers[0] ?? null;
  }, [providers, selectedProviderId]);
  const selectedProviderValue = selectedProvider?.id ?? "";
  const hasSelectedProvider = selectedProvider !== null;
  const unavailableProviderMessage = providersAreLoaded
    ? "No providers available"
    : "Loading…";
  const unavailableProjectMessage = projectsAreLoaded
    ? "No projects available"
    : "Loading projects…";

  const effectiveProjectId = useMemo(() => {
    if (projects.some((candidate) => candidate.id === projectId)) {
      return projectId;
    }
    return projects[0]?.id ?? projectId;
  }, [projectId, projects]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === effectiveProjectId) ?? null,
    [effectiveProjectId, projects],
  );

  const projectOptions = useMemo(
    (): readonly PickerOption<string>[] =>
      projects.map((project) => ({
        value: project.id,
        label: project.name,
      })),
    [projects],
  );

  const projectSources = selectedProject?.sources ?? EMPTY_PROJECT_SOURCES;

  useEffect(() => {
    // Keep the controlled id aligned with the visible fallback so a stale
    // provider returning later cannot snap the picker back.
    if (!providersAreLoaded || !selectedProviderId || !selectedProvider) {
      return;
    }
    if (selectedProvider.id !== selectedProviderId) {
      onSelectedProviderIdChange(selectedProvider.id);
    }
  }, [
    onSelectedProviderIdChange,
    providersAreLoaded,
    selectedProvider,
    selectedProviderId,
  ]);

  const selectedModelData = useMemo(
    () => models.find((m) => m.model === selectedModel),
    [models, selectedModel],
  );

  const reasoningOptions =
    useMemo((): readonly PickerOption<ReasoningLevel>[] => {
      if (!selectedModelData?.supportedReasoningEfforts?.length) return [];
      return selectedModelData.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        label:
          REASONING_LABELS[effort.reasoningEffort] ?? effort.reasoningEffort,
      }));
    }, [selectedModelData]);

  const providerOptions = useMemo(
    (): readonly PickerOption<string>[] =>
      providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo(p.id)?.icon,
      })),
    [providers],
  );

  const providerIdForLabel = selectedProvider?.id;
  const modelOptions = useMemo(
    (): readonly PickerOption<string>[] =>
      models.map((model) => ({
        value: model.model,
        label: formatModelLabel(
          model.displayName || model.model,
          providerIdForLabel,
        ),
      })),
    [models, providerIdForLabel],
  );

  useEffect(() => {
    if (
      hasSelectedProvider &&
      models.length > 0 &&
      !models.some((m) => m.model === selectedModel)
    ) {
      setSelectedModel(
        models.find((model) => model.isDefault)?.model ??
          models[0]?.model ??
          "",
      );
    }
  }, [hasSelectedProvider, models, selectedModel]);

  useEffect(() => {
    if (!selectedModelData) {
      setSelectedReasoningLevel("");
      return;
    }

    const currentReasoningStillSupported = reasoningOptions.some(
      (option) => option.value === selectedReasoningLevel,
    );
    if (reasoningSelectionSource === "user" && currentReasoningStillSupported) {
      return;
    }

    setSelectedReasoningLevel(
      selectedModelData.defaultReasoningEffort ??
        reasoningOptions[0]?.value ??
        "",
    );
  }, [
    reasoningOptions,
    reasoningSelectionSource,
    selectedModelData,
    selectedReasoningLevel,
  ]);
  const effectiveReasoningLevel =
    reasoningOptions.find((option) => option.value === selectedReasoningLevel)
      ?.value ?? reasoningOptions[0]?.value;

  // Auto-select the first connected host that has a source for this project.
  const eligibleHosts = useMemo(
    () =>
      hosts.filter(
        (h) =>
          h.status === "connected" &&
          findLocalPathProjectSourceForHost(projectSources, h.id) !== undefined,
      ),
    [hosts, projectSources],
  );

  useEffect(() => {
    if (eligibleHosts.length === 0) {
      if (selectedHostId) {
        setSelectedHostId("");
      }
      return;
    }
    if (!eligibleHosts.some((h) => h.id === selectedHostId)) {
      const local = eligibleHosts.find((h) => isLocalHost(h.id));
      setSelectedHostId(local?.id ?? eligibleHosts[0]!.id);
    }
  }, [eligibleHosts, selectedHostId, isLocalHost]);

  const handleProviderChange = useCallback(
    (value: string) => {
      onSelectedProviderIdChange(value);
      setError(null);
    },
    [onSelectedProviderIdChange],
  );

  const handleProjectChange = useCallback(
    (value: string) => {
      onProjectChange(value);
      setError(null);
    },
    [onProjectChange],
  );

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setReasoningSelectionSource("default");
    setError(null);
  }, []);

  const handleReasoningLevelChange = useCallback(
    (reasoningLevel: ReasoningLevel) => {
      setSelectedReasoningLevel(reasoningLevel);
      setReasoningSelectionSource("user");
      setError(null);
    },
    [],
  );

  const handleHire = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!effectiveProjectId || isPending || isHirePending) return;
      if (!selectedProvider) {
        setError("A provider is required");
        return;
      }
      if (!selectedModel) {
        setError("A model is required");
        return;
      }
      if (!selectedHostId) {
        setError("A host is required");
        return;
      }
      setIsPending(true);
      setError(null);
      try {
        const trimmedManagerName = managerName.trim();
        await onHire({
          projectId: effectiveProjectId,
          ...(trimmedManagerName ? { name: trimmedManagerName } : {}),
          providerId: selectedProvider.id,
          model: selectedModel,
          ...(effectiveReasoningLevel
            ? { reasoningLevel: effectiveReasoningLevel }
            : {}),
          environment: { type: "host", hostId: selectedHostId },
        });
      } catch (err) {
        setError(
          getMutationErrorMessage({
            error: err,
            fallbackMessage: "Failed to hire manager.",
          }),
        );
      } finally {
        setIsPending(false);
      }
    },
    [
      effectiveReasoningLevel,
      effectiveProjectId,
      isHirePending,
      isPending,
      managerName,
      onHire,
      selectedHostId,
      selectedModel,
      selectedProvider,
    ],
  );

  const isSubmitInProgress = isPending || isHirePending;

  return (
    <form
      aria-label="Hire manager"
      className="space-y-3"
      onSubmit={handleHire}
    >
      <DetailCard appearance="flat" labelWidth="64px">
        <DetailRow label="Project" valueClassName="min-w-0">
          {projectOptions.length > 0 ? (
            <OptionPicker
              label="Project"
              value={effectiveProjectId}
              options={projectOptions}
              onChange={handleProjectChange}
            />
          ) : (
            <LoadingOrEmptyText
              isLoading={!projectsAreLoaded}
              message={unavailableProjectMessage}
            />
          )}
        </DetailRow>
        <DetailRow
          label={<label htmlFor={nameInputId}>Name</label>}
          valueClassName="min-w-0"
        >
          <Input
            id={nameInputId}
            value={managerName}
            placeholder="Give them a name (optional)"
            disabled={isPending}
            className="h-7 text-xs"
            onChange={(event) => {
              setManagerName(event.target.value);
              setError(null);
            }}
          />
        </DetailRow>
        <DetailRow label="Model" valueClassName="min-w-0">
          {hasSelectedProvider ? (
            modelOptions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                <ProviderModelPicker
                  providerOptions={providerOptions}
                  selectedProviderId={selectedProviderValue}
                  onSelectedProviderChange={handleProviderChange}
                  hasMultipleProviders={providers.length > 1}
                  modelValue={selectedModel}
                  modelOptions={modelOptions}
                  onModelChange={handleModelChange}
                  formatModelLabel={formatModelLabel}
                  fastModeEnabled={false}
                  onFastModeChange={() => {}}
                  showFastModeToggle={false}
                />
                {reasoningOptions.length > 0 ? (
                  <OptionPicker
                    label="Reasoning"
                    value={
                      effectiveReasoningLevel ?? reasoningOptions[0]!.value
                    }
                    options={reasoningOptions}
                    onChange={handleReasoningLevelChange}
                  />
                ) : null}
              </div>
            ) : (
              <LoadingOrEmptyText isLoading message="Loading…" />
            )
          ) : (
            <LoadingOrEmptyText
              isLoading={!providersAreLoaded}
              message={unavailableProviderMessage}
            />
          )}
        </DetailRow>
        {eligibleHosts.length > 1 ? (
          <DetailRow label="Host" valueClassName="min-w-0">
            <HostPicker
              hosts={hosts}
              eligibleHosts={eligibleHosts}
              selectedHostId={selectedHostId}
              onChange={setSelectedHostId}
              isLocalHost={isLocalHost}
            />
          </DetailRow>
        ) : null}
      </DetailCard>

      <FormError message={error} />

      <DialogFooter>
        <Button type="submit" disabled={isSubmitInProgress}>
          {isSubmitInProgress ? (
            <>
              <Icon name="Spinner" className="mr-2 size-4 animate-spin" />
              Creating…
            </>
          ) : (
            "Create"
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LoadingOrEmptyText({
  isLoading,
  message,
}: {
  isLoading: boolean;
  message: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      {isLoading ? (
        <Icon name="Spinner" className="size-3 animate-spin" aria-hidden />
      ) : null}
      {message}
    </span>
  );
}
