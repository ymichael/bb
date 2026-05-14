import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AvailableModel, Host, ReasoningLevel } from "@bb/domain";
import type { ProjectResponse, SystemProviderInfo } from "@bb/server-contract";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { HireProjectManagerRequest } from "@/hooks/mutations/project-mutations";
import { Button } from "@/components/ui/button.js";
import { FormError } from "@/components/ui/form-error.js";
import { Icon } from "@/components/ui/icon.js";
import { Input } from "@/components/ui/input.js";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsRow,
  SettingsRowList,
} from "@/components/ui/settings-section.js";
import { useHireProjectManager } from "@/hooks/mutations/project-mutations";
import {
  useAvailableModels,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
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
};
const EMPTY_SYSTEM_PROVIDERS: SystemProviderInfo[] = [];
const EMPTY_PROJECTS: ProjectResponse[] = [];
const EMPTY_PROJECT_SOURCES: ProjectResponse["sources"] = [];
type ReasoningSelectionSource = "default" | "user";

type IsLocalHostFn = (id: string | null | undefined) => boolean;

function newManagerRoutePath(projectId: string) {
  return `/projects/${projectId}/managers/new`;
}

export function NewManagerView() {
  const { projectId } = useParams<"projectId">();
  const navigate = useNavigate();
  const [selectedProviderId, setSelectedProviderId] = useState("");

  const providersQuery = useSystemProviders();
  const providers = providersQuery.data ?? EMPTY_SYSTEM_PROVIDERS;
  const providersAreLoaded = providersQuery.data !== undefined;

  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? EMPTY_PROJECTS;
  const projectsAreLoaded = projectsQuery.data !== undefined;
  const { data: hosts = [] } = useEffectiveHosts();
  const { isLocalHost } = useHostDaemon();

  const resolvedProvider = useMemo(() => {
    if (selectedProviderId) {
      const matchingProvider = providers.find(
        (provider) => provider.id === selectedProviderId,
      );
      if (matchingProvider) return matchingProvider;
    }
    return providers[0] ?? null;
  }, [providers, selectedProviderId]);

  const modelsQuery = useAvailableModels({
    providerId: resolvedProvider?.id,
    enabled: resolvedProvider !== null,
  });
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  const hireManager = useHireProjectManager();
  const handleHire = useCallback(
    async (params: HireProjectManagerRequest) => {
      const thread = await hireManager.mutateAsync(params);
      navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
    },
    [hireManager, navigate],
  );
  const handleProjectChange = useCallback(
    (nextProjectId: string) => {
      if (nextProjectId === projectId) return;
      navigate(newManagerRoutePath(nextProjectId));
    },
    [navigate, projectId],
  );
  const handleCancel = useCallback(() => {
    if (projectId) {
      navigate(`/projects/${projectId}`);
    } else {
      navigate("/");
    }
  }, [navigate, projectId]);

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <Icon
            name="FolderOpen"
            className="size-5 text-muted-foreground"
            aria-hidden
          />
          <p className="text-sm text-muted-foreground">
            Pick a project from the sidebar to hire a manager.
          </p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="pt-8 md:pt-12">
      <div className="mx-auto w-full max-w-md">
        <NewManagerForm
          projectId={projectId}
          projects={projects}
          projectsAreLoaded={projectsAreLoaded}
          providers={providers}
          providersAreLoaded={providersAreLoaded}
          hosts={hosts}
          isLocalHost={isLocalHost}
          models={models}
          selectedProviderId={selectedProviderId}
          onSelectedProviderIdChange={setSelectedProviderId}
          onProjectChange={handleProjectChange}
          onCancel={handleCancel}
          onHire={handleHire}
          isHirePending={hireManager.isPending}
        />
      </div>
    </PageShell>
  );
}

export interface NewManagerFormProps {
  projectId: string;
  projects: readonly ProjectResponse[];
  projectsAreLoaded: boolean;
  providers: readonly SystemProviderInfo[];
  providersAreLoaded: boolean;
  hosts: Host[];
  isLocalHost: IsLocalHostFn;
  models: readonly AvailableModel[];
  selectedProviderId: string;
  onSelectedProviderIdChange: (providerId: string) => void;
  onProjectChange: (projectId: string) => void;
  onCancel: () => void;
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
  onCancel,
  onHire,
  isHirePending,
}: NewManagerFormProps) {
  const nameInputId = useId();
  const formTitleId = useId();

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
    : "Loading providers…";
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

  const modelOptions = useMemo(
    (): readonly PickerOption<string>[] =>
      models.map((model) => ({
        value: model.model,
        label: formatModelLabel(
          model.displayName || model.model,
          selectedProvider?.id,
        ),
      })),
    [models, selectedProvider],
  );

  useEffect(() => {
    if (!providersAreLoaded || selectedProviderId === selectedProviderValue) {
      return;
    }
    onSelectedProviderIdChange(selectedProviderValue);
  }, [
    providersAreLoaded,
    selectedProviderId,
    selectedProviderValue,
    onSelectedProviderIdChange,
  ]);

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

  const projectName = selectedProject?.name;

  return (
    <form
      aria-labelledby={formTitleId}
      className="space-y-6"
      onSubmit={handleHire}
    >
      <header className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon name="UserRoundPlus" className="size-6" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1
            id={formTitleId}
            className="text-xl font-semibold leading-tight tracking-tight text-foreground"
          >
            New Manager
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            A manager coordinates sustained work on a project — delegating to
            worker threads, tracking progress, and surfacing updates. Hiring
            starts a new thread
            {projectName ? (
              <>
                {" "}
                on{" "}
                <span className="font-medium text-foreground">
                  {projectName}
                </span>
              </>
            ) : null}
            .
          </p>
        </div>
      </header>

      <Input
        id={nameInputId}
        value={managerName}
        placeholder="Give them a name (optional)"
        autoFocus
        disabled={isPending}
        aria-label="Manager name"
        className="h-10 border-border bg-card px-3 text-sm"
        onChange={(event) => {
          setManagerName(event.target.value);
          setError(null);
        }}
      />

      <div className="rounded-lg border border-border bg-card px-3 py-1">
        <SettingsRowList>
          <ConfigRow label="Project">
            {projectOptions.length > 0 ? (
              <OptionPicker
                label="Project"
                value={effectiveProjectId}
                options={projectOptions}
                onChange={handleProjectChange}
                align="end"
              />
            ) : (
              <LoadingOrEmptyText
                isLoading={!projectsAreLoaded}
                message={unavailableProjectMessage}
              />
            )}
          </ConfigRow>
          <ConfigRow label="Model">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              {hasSelectedProvider ? (
                modelOptions.length > 0 ? (
                  <>
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
                        align="end"
                      />
                    ) : null}
                  </>
                ) : (
                  <LoadingOrEmptyText isLoading message="Loading models…" />
                )
              ) : (
                <LoadingOrEmptyText
                  isLoading={!providersAreLoaded}
                  message={unavailableProviderMessage}
                />
              )}
            </div>
          </ConfigRow>
          <ConfigRow label="Host">
            <HostPicker
              hosts={hosts}
              eligibleHosts={eligibleHosts}
              selectedHostId={selectedHostId}
              onChange={setSelectedHostId}
              isLocalHost={isLocalHost}
            />
          </ConfigRow>
        </SettingsRowList>
      </div>

      <FormError message={error} />

      <div className="flex flex-col gap-2">
        <Button
          type="submit"
          disabled={isSubmitInProgress}
          className="h-10 w-full"
        >
          {isSubmitInProgress ? (
            <>
              <Icon name="Spinner" className="animate-spin" aria-hidden />
              Hiring…
            </>
          ) : (
            <>
              <Icon name="UserRoundPlus" aria-hidden />
              Hire Manager
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={isSubmitInProgress}
          className="w-full"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <SettingsRow>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="ml-auto flex min-w-0 items-center justify-end">
        {children}
      </div>
    </SettingsRow>
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
