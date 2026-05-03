import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { ReasoningLevel, Thread } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import { DetailCard, DetailRow } from "@bb/ui-core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/ui-core";
import { Button } from "@bb/ui-core";
import { FormError } from "@bb/ui-core";
import { Input } from "@bb/ui-core";
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
  PromptOptionPicker,
  type PromptOption,
} from "@/components/promptbox/PromptOptionPicker";
import { HostPicker } from "@/components/promptbox/HostPicker";

const REASONING_LABELS: Record<ReasoningLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};
const EMPTY_SYSTEM_PROVIDERS: SystemProviderInfo[] = [];
const SERVER_DEFAULT_PROVIDER_VALUE = "";
type ReasoningSelectionSource = "default" | "user";

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
  const providers = useSystemProviders().data ?? EMPTY_SYSTEM_PROVIDERS;
  const { data: projects } = useProjects();
  const { data: hosts = [] } = useEffectiveHosts();
  const { isLocalHost } = useHostDaemon();

  const projectSources = useMemo(() => {
    const project = projects?.find((p) => p.id === projectId);
    return project?.sources ?? [];
  }, [projects, projectId]);

  const [managerName, setManagerName] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<
    ReasoningLevel | ""
  >("");
  const [reasoningSelectionSource, setReasoningSelectionSource] =
    useState<ReasoningSelectionSource>("default");
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = useMemo(
    () =>
      selectedProviderId
        ? providers.find((provider) => provider.id === selectedProviderId) ?? null
        : null,
    [providers, selectedProviderId],
  );
  const selectedProviderValue =
    selectedProviderId ?? SERVER_DEFAULT_PROVIDER_VALUE;
  const hasProviderOverride = selectedProvider !== null;
  const modelsQuery = useAvailableModels({
    providerId: selectedProvider?.id,
    enabled: hasProviderOverride,
  });
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  const selectedModelData = useMemo(
    () => models.find((m) => m.model === selectedModel),
    [models, selectedModel],
  );

  const reasoningOptions =
    useMemo((): readonly PromptOption<ReasoningLevel>[] => {
      if (!selectedModelData?.supportedReasoningEfforts?.length) return [];
      return selectedModelData.supportedReasoningEfforts.map((effort) => ({
        value: effort.reasoningEffort,
        label:
          REASONING_LABELS[effort.reasoningEffort] ?? effort.reasoningEffort,
      }));
    }, [selectedModelData]);

  const providerOptions = useMemo(
    (): readonly PromptOption<string>[] => [
      {
        value: SERVER_DEFAULT_PROVIDER_VALUE,
        label: "Server Default",
        description:
          "Use remembered manager defaults for this project, otherwise the server manager default.",
      },
      ...providers.map((p) => ({
        value: p.id,
        label: p.displayName,
        icon: getProviderIconInfo(p.id)?.icon,
      })),
    ],
    [providers],
  );

  const modelOptions = useMemo(
    (): readonly PromptOption<string>[] =>
      models.map((model) => ({
        value: model.model,
        label: formatModelLabel(
          model.displayName || model.model,
          selectedProvider?.id ?? SERVER_DEFAULT_PROVIDER_VALUE,
        ),
      })),
    [models, selectedProvider],
  );

  // Reset model and reasoning when provider changes.
  useEffect(() => {
    setSelectedModel("");
    setSelectedReasoningLevel("");
    setReasoningSelectionSource("default");
  }, [selectedProviderId]);

  useEffect(() => {
    if (
      hasProviderOverride &&
      models.length > 0 &&
      !models.some((m) => m.model === selectedModel)
    ) {
      setSelectedModel(
        models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? "",
      );
    }
  }, [hasProviderOverride, models, selectedModel]);

  useEffect(() => {
    if (!selectedModelData) {
      setSelectedReasoningLevel("");
      return;
    }

    const currentReasoningStillSupported = reasoningOptions.some(
      (option) => option.value === selectedReasoningLevel,
    );
    if (
      reasoningSelectionSource === "user" &&
      currentReasoningStillSupported
    ) {
      return;
    }

    setSelectedReasoningLevel(
      selectedModelData.defaultReasoningEffort ?? reasoningOptions[0]?.value ?? "",
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
    if (
      eligibleHosts.length > 0 &&
      !eligibleHosts.some((h) => h.id === selectedHostId)
    ) {
      const local = eligibleHosts.find((h) => isLocalHost(h.id));
      setSelectedHostId(local?.id ?? eligibleHosts[0]!.id);
    }
  }, [eligibleHosts, selectedHostId, isLocalHost]);

  const handleProviderChange = useCallback((value: string) => {
    setSelectedProviderId(
      value === SERVER_DEFAULT_PROVIDER_VALUE ? null : value,
    );
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

  const hireManager = useHireProjectManager();

  const handleHire = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!projectId || isPending) return;
      if (selectedProvider && !selectedModel) {
        setError("A model is required when overriding the server default");
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
          ...(selectedProvider
            ? {
                providerId: selectedProvider.id,
                model: selectedModel,
                ...(effectiveReasoningLevel
                  ? { reasoningLevel: effectiveReasoningLevel }
                  : {}),
              }
            : {}),
          environment: { type: "host", hostId: selectedHostId },
        });
        onHired(thread);
        onClose();
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
      hireManager,
      isPending,
      managerName,
      onClose,
      onHired,
      projectId,
      selectedModel,
      selectedHostId,
      selectedProvider,
      effectiveReasoningLevel,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent className="max-w-[34rem] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-xl">
        <DialogHeader className="px-6 pt-5 pb-3">
          <DialogTitle>Hire Manager</DialogTitle>
          <DialogDescription className="sr-only">
            Configure and hire a manager agent.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5 px-6 pb-5" onSubmit={handleHire}>
          <DetailCard
            className="border-border/70 bg-muted/20"
            labelWidth="60px"
          >
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
                <PromptOptionPicker
                  label="Provider"
                  value={selectedProviderValue}
                  options={providerOptions}
                  onChange={handleProviderChange}
                  className="text-foreground"
                  contentClassName="min-w-64"
                />
                {hasProviderOverride ? (
                  modelOptions.length > 0 ? (
                    <>
                      <PromptOptionPicker
                        label="Model"
                        value={selectedModel}
                        options={modelOptions}
                        onChange={handleModelChange}
                        className="text-foreground"
                        contentClassName="min-w-64"
                      />
                      {reasoningOptions.length > 0 ? (
                        <PromptOptionPicker
                          label="Reasoning"
                          value={effectiveReasoningLevel ?? reasoningOptions[0]!.value}
                          options={reasoningOptions}
                          onChange={handleReasoningLevelChange}
                          className="text-foreground"
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
                    Using server-owned manager defaults unless you choose an override.
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
      </DialogContent>
    </Dialog>
  );
}
