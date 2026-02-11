import {
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AvailableModel, ReasoningLevel } from "@beanbag/core";
import { useLocation, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { useAvailableModels, useSpawnThread } from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";

const MODEL_STORAGE_KEY = "beanbag.promptbox.model";
const REASONING_STORAGE_KEY = "beanbag.promptbox.reasoning";

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

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function getStoredModel(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
}

function getStoredReasoningLevel(): ReasoningLevel {
  if (typeof window === "undefined") return "medium";
  const raw = window.localStorage.getItem(REASONING_STORAGE_KEY);
  return isReasoningLevel(raw) ? raw : "medium";
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

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const spawnThread = useSpawnThread();
  const availableModelsQuery = useAvailableModels();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const fileMentions = usePromptFileMentions(projectId);
  const prompt = promptDraft.value;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    getStoredModel(),
  );
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() =>
    getStoredReasoningLevel(),
  );

  const availableModels = useMemo(
    () =>
      availableModelsQuery.data && availableModelsQuery.data.length > 0
        ? availableModelsQuery.data
        : FALLBACK_MODELS,
    [availableModelsQuery.data],
  );

  const modelOptions = useMemo(
    () =>
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

  const reasoningOptions = useMemo(() => {
    const options: { value: ReasoningLevel; label: string }[] = [];
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
  }, [activeModel]);

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
    if (!reasoningOptions.some((option) => option.value === reasoningLevel)) {
      setReasoningLevel(
        activeModel?.defaultReasoningEffort ?? reasoningOptions[0].value,
      );
    }
  }, [activeModel, reasoningLevel, reasoningOptions]);

  useEffect(() => {
    if (typeof window === "undefined" || !selectedModel) return;
    window.localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REASONING_STORAGE_KEY, reasoningLevel);
  }, [reasoningLevel]);

  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;

  useEffect(() => {
    if (!shouldFocusPrompt) return;
    const handle = window.requestAnimationFrame(() => {
      const promptElement = document.getElementById("project-main-prompt");
      if (!(promptElement instanceof HTMLTextAreaElement)) return;
      promptElement.focus();
      const caretIndex = promptElement.value.length;
      promptElement.setSelectionRange(caretIndex, caretIndex);
    });

    return () => window.cancelAnimationFrame(handle);
  }, [location.key, shouldFocusPrompt]);

  if (!projectId) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Select a project.
      </p>
    );
  }

  const submitPrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || spawnThread.isPending) return;

    setErrorMessage(null);
    try {
      await spawnThread.mutateAsync({
        input: [{ type: "text", text: trimmed }],
        projectId,
        model: activeModel?.model,
        reasoningLevel,
      });
      promptDraft.clear();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to send prompt.",
      );
    }
  };

  const isSubmitDisabled = spawnThread.isPending || prompt.trim().length === 0;

  return (
    <div className="mx-auto w-full max-w-[750px]">
      <PromptBox
        id="project-main-prompt"
        value={prompt}
        onChange={(value) => {
          promptDraft.setValue(value);
          if (errorMessage) setErrorMessage(null);
        }}
        onSubmit={submitPrompt}
        isSubmitting={spawnThread.isPending}
        submitDisabled={isSubmitDisabled}
        submitTitle={spawnThread.isPending ? "Submitting..." : "Submit (Enter)"}
        mentionSuggestions={fileMentions.suggestions}
        mentionLoading={fileMentions.isLoading}
        mentionError={fileMentions.isError}
        onMentionQueryChange={fileMentions.setQuery}
        footerStart={
          <>
            <PromptOptionPicker
              label="Model"
              value={activeModel?.model ?? selectedModel}
              options={modelOptions}
              onChange={setSelectedModel}
            />
            <PromptOptionPicker
              label="Reasoning"
              value={reasoningLevel}
              options={reasoningOptions}
              onChange={setReasoningLevel}
            />
          </>
        }
      />
      {errorMessage ? (
        <p className="pt-2 text-sm text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}
