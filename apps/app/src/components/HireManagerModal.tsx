import { useCallback, useEffect, useMemo, useState } from "react";
import type { Thread } from "@bb/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAvailableModels, useSystemProviders, useHireProjectManager } from "@/hooks/useApi";
import { formatModelLabel } from "@/hooks/usePromptModelReasoning";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { PromptProviderModelPicker } from "@/components/promptbox/PromptProviderModelPicker";
import type { PromptOption } from "@/components/promptbox/PromptOptionPicker";

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
  const providersQuery = useSystemProviders();
  const providers = providersQuery.data ?? [];

  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to first provider when list loads.
  useEffect(() => {
    if (providers.length > 0 && !selectedProviderId) {
      setSelectedProviderId(providers[0].id);
    }
  }, [providers, selectedProviderId]);

  const hasMultipleProviders = providers.length >= 2;

  const modelsQuery = useAvailableModels(
    hasMultipleProviders ? selectedProviderId || undefined : undefined,
  );
  const models = useMemo(
    () => modelsQuery.data ?? [],
    [modelsQuery.data],
  );

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

  // Reset model when provider changes.
  useEffect(() => {
    setSelectedModel("");
  }, [selectedProviderId]);

  // Default to the default model or first model.
  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.model === selectedModel)) {
      const defaultModel = models.find((m) => m.isDefault) ?? models[0];
      setSelectedModel(defaultModel.model);
    }
  }, [models, selectedModel]);

  const handleProviderChange = useCallback((id: string) => {
    setSelectedProviderId(id);
    setError(null);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setError(null);
  }, []);

  const hireManager = useHireProjectManager();

  const handleHire = useCallback(async () => {
    if (!projectId || isPending) return;
    setIsPending(true);
    setError(null);
    try {
      const thread = await hireManager.mutateAsync({
        projectId,
        ...(hasMultipleProviders && selectedProviderId
          ? { providerId: selectedProviderId }
          : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
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
    onClose,
    onHired,
    projectId,
    selectedModel,
    selectedProviderId,
  ]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hire Manager</DialogTitle>
          <DialogDescription>
            Select a provider and model for the project manager.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {modelOptions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Provider & Model</span>
              <PromptProviderModelPicker
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
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleHire} disabled={isPending}>
            {isPending ? "Hiring..." : "Hire Manager"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
