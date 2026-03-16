import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAvailableModels, useSystemProviders, useHireProjectManager } from "@/hooks/useApi";
import { getProviderIconInfo } from "@/lib/provider-icon";

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

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );

  const hasMultipleProviders = providers.length >= 2;
  const supportsModelList = selectedProvider?.capabilities.supportsModelList ?? false;
  const SelectedProviderIcon = selectedProvider
    ? getProviderIconInfo(selectedProvider.id)?.icon
    : undefined;

  const modelsQuery = useAvailableModels(
    hasMultipleProviders ? selectedProviderId || undefined : undefined,
  );
  const models = useMemo(
    () => (supportsModelList && modelsQuery.data ? modelsQuery.data : []),
    [modelsQuery.data, supportsModelList],
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
          {hasMultipleProviders ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Provider</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-between"
                  >
                    <span className="flex min-w-0 items-center gap-2 truncate">
                      {SelectedProviderIcon ? <SelectedProviderIcon className="size-4 shrink-0" /> : null}
                      <span className="truncate">
                        {selectedProvider?.displayName ?? "Select provider..."}
                      </span>
                    </span>
                    <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                  {providers.map((provider) => {
                    const iconInfo = getProviderIconInfo(provider.id);
                    const Icon = iconInfo?.icon;
                    return (
                      <DropdownMenuItem
                        key={provider.id}
                        onSelect={() => handleProviderChange(provider.id)}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {Icon ? <Icon className="size-4 shrink-0" /> : null}
                          <span className="truncate">{provider.displayName}</span>
                        </span>
                        {provider.id === selectedProviderId ? (
                          <Check className="size-4 shrink-0" />
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
          {supportsModelList && models.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Model</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-between"
                  >
                    <span className="truncate">
                      {models.find((m) => m.model === selectedModel)?.displayName ??
                        (selectedModel || "Select model...")}
                    </span>
                    <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="max-h-60 w-[--radix-dropdown-menu-trigger-width] overflow-y-auto"
                >
                  {models.map((model) => (
                    <DropdownMenuItem
                      key={model.model}
                      onSelect={() => handleModelChange(model.model)}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="truncate">
                        {model.displayName || model.model}
                      </span>
                      {model.model === selectedModel ? (
                        <Check className="size-4 shrink-0" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
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
