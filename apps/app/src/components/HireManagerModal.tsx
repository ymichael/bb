import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { useAvailableModels, useSystemProviders, useHireProjectManager } from "@/hooks/useApi";
import { formatModelLabel } from "@/hooks/usePromptModelReasoning";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { PromptProviderModelPicker } from "@/components/promptbox/PromptProviderModelPicker";
import type { PromptOption } from "@/components/promptbox/PromptOptionPicker";
import {
  resolvePreferredManagerModel,
  resolvePreferredManagerProviderId,
} from "@/lib/manager-hire-defaults";

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

  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.model === selectedModel)) {
      setSelectedModel(resolvePreferredManagerModel(models));
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
  ]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>Hire Manager</DialogTitle>
          <DialogDescription>
            Name this manager and choose the provider and model it should use.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5 px-6 pt-3 pb-5" onSubmit={handleHire}>
          <div className="space-y-1.5">
            <label htmlFor={nameInputId} className="text-sm font-medium">
              Name
            </label>
            <Input
              id={nameInputId}
              value={managerName}
              placeholder="Manager"
              autoFocus
              disabled={isPending}
              onChange={(event) => {
                setManagerName(event.target.value);
                setError(null);
              }}
            />
          </div>
          {modelOptions.length > 0 ? (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Provider &amp; Model</span>
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
            <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Hiring..." : "Hire Manager"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
