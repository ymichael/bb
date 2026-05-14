import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { AvailableModel, Host, ProviderInfo, ReasoningLevel, Thread } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { HireProjectManagerRequest } from "@/hooks/mutations/project-mutations";
import { DetailCard, DetailRow } from "@/components/ui/detail-card.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { FormError } from "@/components/ui/form-error.js";
import { Input } from "@/components/ui/input.js";
import { useHireProjectManager } from "@/hooks/mutations/project-mutations";
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
};
const EMPTY_PROVIDERS: ProviderInfo[] = [];
const EMPTY_MODELS: AvailableModel[] = [];
const EMPTY_PROJECTS: ProjectResponse[] = [];
const EMPTY_PROJECT_SOURCES: ProjectResponse["sources"] = [];
type ReasoningSelectionSource = "default" | "user";

type IsLocalHostFn = (id: string | null | undefined) => boolean;

interface HireManagerDialogProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onHired: (thread: Thread) => void;
}

export function HireManagerDialog({
  projectId,
  open,
  onClose,
  onHired,
}: HireManagerDialogProps) {
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
      onHired(thread);
      onClose();
    },
    [hireManager, onClose, onHired],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        <HireManagerDialogContent
          key={projectId}
          initialProjectId={projectId}
          projects={projects}
          projectsAreLoaded={projectsAreLoaded}
          providers={providers}
          providersAreLoaded={providersAreLoaded}
          hosts={hosts}
          isLocalHost={isLocalHost}
          models={models}
          selectedProviderId={selectedProviderId}
          onSelectedProviderIdChange={setSelectedProviderId}
          onHire={handleHire}
        />
      </DialogContent>
    </Dialog>
  );
}

export interface HireManagerDialogContentProps {
  initialProjectId: string;
  projects: readonly ProjectResponse[];
  projectsAreLoaded: boolean;
  providers: readonly ProviderInfo[];
  providersAreLoaded: boolean;
  hosts: Host[];
  isLocalHost: IsLocalHostFn;
  models: readonly AvailableModel[];
  selectedProviderId: string;
  onSelectedProviderIdChange: (providerId: string) => void;
  onHire: (params: HireProjectManagerRequest) => Promise<void>;
}

export function HireManagerDialogContent({
  initialProjectId,
  projects,
  projectsAreLoaded,
  providers,
  providersAreLoaded,
  hosts,
  isLocalHost,
  models,
  selectedProviderId,
  onSelectedProviderIdChange,
  onHire,
}: HireManagerDialogContentProps) {
  const nameInputId = useId();

  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
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
    if (projects.some((project) => project.id === selectedProjectId)) {
      return selectedProjectId;
    }
    if (projects.some((project) => project.id === initialProjectId)) {
      return initialProjectId;
    }
    return projects[0]?.id ?? initialProjectId;
  }, [initialProjectId, projects, selectedProjectId]);

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

  const handleProjectChange = useCallback((value: string) => {
    setSelectedProjectId(value);
    setError(null);
  }, []);

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
      if (!effectiveProjectId || isPending) return;
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
      isPending,
      managerName,
      onHire,
      selectedHostId,
      selectedModel,
      selectedProvider,
    ],
  );

  return (
    <>
      <DialogHeader className="px-6 pt-5 pb-3">
        <DialogTitle>Hire Manager</DialogTitle>
        <DialogDescription>
          Managers are special threads that have persistent memory and can help
          you coordinate work by delegating tasks to managed child threads.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-5 px-6 pb-5" onSubmit={handleHire}>
        <DetailCard className="border-border/70 bg-muted/20" labelWidth="60px">
          <DetailRow label="Project" valueClassName="min-w-0">
            {projectOptions.length > 0 ? (
              <OptionPicker
                label="Project"
                value={effectiveProjectId}
                options={projectOptions}
                onChange={handleProjectChange}
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                {unavailableProjectMessage}
              </span>
            )}
          </DetailRow>
          <DetailRow label="Name" valueClassName="min-w-0">
            <Input
              id={nameInputId}
              value={managerName}
              placeholder="Eg. Manager (optional)"
              autoFocus
              disabled={isPending}
              className="text-sm border-border"
              onChange={(event) => {
                setManagerName(event.target.value);
                setError(null);
              }}
            />
          </DetailRow>
          <DetailRow label="Model" valueClassName="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                      />
                    ) : null}
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Loading models…
                  </span>
                )
              ) : (
                <span className="text-sm text-muted-foreground">
                  {unavailableProviderMessage}
                </span>
              )}
            </div>
          </DetailRow>
          <DetailRow label="Host" valueClassName="min-w-0">
            <HostPicker
              hosts={hosts}
              eligibleHosts={eligibleHosts}
              selectedHostId={selectedHostId}
              onChange={setSelectedHostId}
              isLocalHost={isLocalHost}
            />
          </DetailRow>
        </DetailCard>
        <FormError message={error} />
        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Hiring..." : "Hire Manager"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
