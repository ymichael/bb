import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { ReasoningLevel, Thread } from "@bb/domain";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { DetailCard, DetailRow } from "@bb/ui-core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/shared/FormError";
import { Input } from "@/components/ui/input";
import { useHireProjectManager } from "@/hooks/mutations/project-mutations";
import { useAvailableModels, useHosts, useSystemProviders } from "@/hooks/queries/system-queries";
import { useProjects } from "@/hooks/queries/project-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { PromptProviderModelPicker } from "@/components/promptbox/PromptProviderModelPicker";
import { PromptOptionPicker, type PromptOption } from "@/components/promptbox/PromptOptionPicker";
import { HostPicker } from "@/components/promptbox/HostPicker";
import {
  resolvePreferredManagerModel,
  resolvePreferredManagerProviderId,
} from "@/lib/manager-hire-defaults";

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

interface HireManagerModalProps {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onHired: (thread: Thread) => void;
}

export function HireManagerModal({
  projectId,
  open,
  onClose,
  onHired,
}: HireManagerModalProps) {
  const nameInputId = useId();
  const providersQuery = useSystemProviders();
  const providers = providersQuery.data ?? [];
  const { data: projects } = useProjects();
  const { data: hosts = [] } = useHosts();
  const { isLocalHost } = useHostDaemon();

  const projectSources = useMemo(() => {
    const project = projects?.find((p) => p.id === projectId);
    return project?.sources ?? [];
  }, [projects, projectId]);

  const [managerName, setManagerName] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<ReasoningLevel | "">("");
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveProviderId = providers.some((provider) => provider.id === selectedProviderId)
    ? selectedProviderId
    : resolvePreferredManagerProviderId(providers);

  const hasMultipleProviders = providers.length >= 2;

  const modelsQuery = useAvailableModels(effectiveProviderId || undefined);
  const models = useMemo(
    () => modelsQuery.data ?? [],
    [modelsQuery.data],
  );

  const selectedModelData = useMemo(
    () => models.find((m) => m.model === selectedModel),
    [models, selectedModel],
  );

  const reasoningOptions = useMemo((): readonly PromptOption<ReasoningLevel>[] => {
    if (!selectedModelData?.supportedReasoningEfforts?.length) return [];
    return selectedModelData.supportedReasoningEfforts.map((effort) => ({
      value: effort.reasoningEffort,
      label: REASONING_LABELS[effort.reasoningEffort] ?? effort.reasoningEffort,
    }));
  }, [selectedModelData]);

  const providerOptions = useMemo(
    (): readonly PromptOption<string>[] =>
      providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo(p.id)?.icon,
      })),
    [providers],
  );

  const modelOptions = useMemo(
    (): readonly PromptOption<string>[] =>
      models.map((model) => ({
        value: model.model,
        label: formatModelLabel(model.displayName || model.model, effectiveProviderId),
      })),
    [effectiveProviderId, models],
  );

  // Reset model and reasoning when provider changes.
  useEffect(() => {
    setSelectedModel("");
    setSelectedReasoningLevel("");
  }, [effectiveProviderId]);

  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.model === selectedModel)) {
      setSelectedModel(resolvePreferredManagerModel(models));
    }
  }, [models, selectedModel]);

  // Reset reasoning level when model changes.
  useEffect(() => {
    if (selectedModelData?.defaultReasoningEffort) {
      setSelectedReasoningLevel(selectedModelData.defaultReasoningEffort);
    } else {
      setSelectedReasoningLevel("");
    }
  }, [selectedModelData]);
  const effectiveReasoningLevel = reasoningOptions.some(
    (option) => option.value === selectedReasoningLevel,
  )
    ? selectedReasoningLevel
    : reasoningOptions[0]?.value ?? "";

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
    if (eligibleHosts.length > 0 && !eligibleHosts.some((h) => h.id === selectedHostId)) {
      const local = eligibleHosts.find((h) => isLocalHost(h.id));
      setSelectedHostId(local?.id ?? eligibleHosts[0]!.id);
    }
  }, [eligibleHosts, selectedHostId, isLocalHost]);

  const handleProviderChange = useCallback((id: string) => {
    setSelectedProviderId(id);
    setError(null);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setError(null);
  }, []);

  const hireManager = useHireProjectManager();

  const handleHire = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || isPending) return;
    if (!effectiveProviderId || !selectedModel || !effectiveReasoningLevel) {
      setError("Manager provider, model, and reasoning level are required");
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
      const thread = await hireManager.mutateAsync({
        projectId,
        ...(trimmedManagerName ? { name: trimmedManagerName } : {}),
        providerId: effectiveProviderId,
        model: selectedModel,
        reasoningLevel: effectiveReasoningLevel,
        environment: { type: "host", hostId: selectedHostId },
      });
      onHired(thread);
      onClose();
    } catch (err) {
      setError(getMutationErrorMessage({
        error: err,
        fallbackMessage: "Failed to hire manager.",
      }));
    } finally {
      setIsPending(false);
    }
  }, [
    hasMultipleProviders,
    hireManager,
    isPending,
    managerName,
    onClose,
    onHired,
    projectId,
    selectedModel,
    selectedHostId,
    effectiveProviderId,
    effectiveReasoningLevel,
  ]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>Hire Manager</DialogTitle>
          <DialogDescription className="sr-only">
            Configure and hire a manager agent.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5 px-6 pb-5" onSubmit={handleHire}>
          <DetailCard className="border-border/70 bg-muted/20 py-1 [&_>div]:grid-cols-[60px_minmax(0,1fr)] [&_>div]:sm:grid-cols-[72px_minmax(0,1fr)]">
            <DetailRow label="Name" valueClassName="min-w-0" className="py-1">
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
            <DetailRow label="Model" valueClassName="min-w-0" className="py-1">
              {modelOptions.length > 0 ? (
                <div className="flex min-w-0 flex-wrap items-center">
                  <PromptProviderModelPicker
                    className="text-foreground"
                    providerOptions={providerOptions}
                    selectedProviderId={effectiveProviderId}
                    onSelectedProviderChange={handleProviderChange}
                    hasMultipleProviders={hasMultipleProviders}
                    modelValue={selectedModel}
                    modelOptions={modelOptions}
                    onModelChange={handleModelChange}
                    formatModelLabel={formatModelLabel}
                    fastModeEnabled={false}
                    onFastModeChange={() => {}}
                    showFastModeToggle={false}
                  />
                  {reasoningOptions.length > 0 ? (
                    <PromptOptionPicker
                      label="Reasoning"
                      value={effectiveReasoningLevel}
                      options={reasoningOptions}
                      onChange={setSelectedReasoningLevel}
                      className="text-foreground"
                    />
                  ) : null}
                </div>
              ) : (
                <span className="text-muted-foreground text-sm">Loading models…</span>
              )}
            </DetailRow>
            <DetailRow label="Host" valueClassName="min-w-0" className="py-1">
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
      </DialogContent>
    </Dialog>
  );
}
