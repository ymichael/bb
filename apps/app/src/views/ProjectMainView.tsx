import { useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import { PromptBox } from "@/components/promptbox/PromptBox";
import { PromptOptionPicker } from "@/components/promptbox/PromptOptionPicker";
import { PageShell } from "@/components/layout/PageShell";
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
  } = usePromptModelReasoning({ scope: "new-thread" });

  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;

  useEffect(() => {
    if (!shouldFocusPrompt) return;
    const handle = window.requestAnimationFrame(() => {
      const promptEl = document.getElementById("project-main-prompt");
      if (!(promptEl instanceof HTMLTextAreaElement)) return;
      promptEl.focus();
      const caretIndex = promptEl.value.length;
      promptEl.setSelectionRange(caretIndex, caretIndex);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [location.key, shouldFocusPrompt]);

  if (!projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Select a project.
        </p>
      </PageShell>
    );
  }

  const submitPrompt = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || spawnThread.isPending) return;

    try {
      await spawnThread.mutateAsync({
        input: [{ type: "text", text: trimmed }],
        projectId,
        model: activeModel?.model,
        reasoningLevel,
        sandboxMode,
      });
      promptDraft.clear();
    } catch {
      // Error state is surfaced in mutation status and can be shown by callers if needed.
    }
  };

  const isSubmitDisabled = spawnThread.isPending || prompt.trim().length === 0;

  return (
    <PageShell contentClassName="pt-8 md:pt-10">
      <PromptBox
        id="project-main-prompt"
        value={prompt}
        onChange={promptDraft.setValue}
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
    </PageShell>
  );
}
