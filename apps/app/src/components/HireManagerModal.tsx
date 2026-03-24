import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { ReasoningLevel, Thread } from "@bb/domain";
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
import { Input } from "@/components/ui/input";
import { useAvailableModels, useSystemProviders, useHireProjectManager } from "@/hooks/useApi";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { PromptProviderModelPicker } from "@/components/promptbox/PromptProviderModelPicker";
import { PromptOptionPicker, type PromptOption } from "@/components/promptbox/PromptOptionPicker";
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

  const [managerName, setManagerName] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<ReasoningLevel | "">("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      providers.length > 0 &&
      !providers.some((provider) => provider.id === selectedProviderId)
    ) {
      setSelectedProviderId(resolvePreferredManagerProviderId(providers));
    }
  }, [providers, selectedProviderId]);

  const hasMultipleProviders = providers.length >= 2;

  const modelsQuery = useAvailableModels(selectedProviderId || undefined);
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
        label: formatModelLabel(model.displayName || model.model, selectedProviderId),
      })),
    [models, selectedProviderId],
  );

  // Reset model and reasoning when provider changes.
  useEffect(() => {
    setSelectedModel("");
    setSelectedReasoningLevel("");
  }, [selectedProviderId]);

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
    setIsPending(true);
    setError(null);
    try {
      const trimmedManagerName = managerName.trim();
      const thread = await hireManager.mutateAsync({
        projectId,
        ...(trimmedManagerName ? { title: trimmedManagerName } : {}),
        ...(hasMultipleProviders && selectedProviderId
          ? { providerId: selectedProviderId }
          : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedReasoningLevel ? { reasoningLevel: selectedReasoningLevel } : {}),
      });
      onHired(thread);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hire manager");
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
    selectedProviderId,
    selectedReasoningLevel,
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
          <DetailCard className="border-border/70 bg-muted/20 py-1">
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
            {modelOptions.length > 0 ? (
              <DetailRow label="Model" valueClassName="min-w-0" className="py-1">
                <PromptProviderModelPicker
                  className="text-foreground"
                  providerOptions={providerOptions}
                  selectedProviderId={selectedProviderId}
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
              </DetailRow>
            ) : null}
            {reasoningOptions.length > 0 ? (
              <DetailRow label="Reasoning" valueClassName="min-w-0" className="py-1">
                <PromptOptionPicker
                  label="Reasoning"
                  value={selectedReasoningLevel as ReasoningLevel}
                  options={reasoningOptions}
                  onChange={setSelectedReasoningLevel}
                  className="text-foreground"
                />
              </DetailRow>
            ) : null}
          </DetailCard>
          {error ? (
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
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
