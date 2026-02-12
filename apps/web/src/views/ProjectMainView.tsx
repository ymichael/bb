import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { useSpawnThread } from "@/hooks/useApi";
import { usePromptDraftStorage } from "@/hooks/usePromptDraftStorage";
import { usePromptFileMentions } from "@/hooks/usePromptFileMentions";
import { usePromptModelReasoning } from "@/hooks/usePromptModelReasoning";

export function ProjectMainView() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const spawnThread = useSpawnThread();
  const promptDraft = usePromptDraftStorage({ projectId, threadId: null });
  const fileMentions = usePromptFileMentions(projectId);
  const prompt = promptDraft.value;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const {
    selectedModel,
    setSelectedModel,
    reasoningLevel,
    setReasoningLevel,
    sandboxMode,
    setSandboxMode,
    activeModel,
    modelOptions,
    reasoningOptions,
    sandboxOptions,
  } = usePromptModelReasoning();

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
        sandboxMode,
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
            <PromptOptionPicker
              label="Sandbox"
              value={sandboxMode}
              options={sandboxOptions}
              onChange={setSandboxMode}
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
