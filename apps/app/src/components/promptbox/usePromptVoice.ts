import { useCallback, useMemo, type RefObject } from "react";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { transcribeVoiceInput } from "@/lib/api";
import type { PromptBoxHandle, PromptVoiceConfig } from "./PromptBoxInternal";

async function requestVoiceTranscription({
  file,
  promptContext,
  signal,
}: {
  file: File;
  promptContext?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const transcription = await transcribeVoiceInput(file, promptContext, signal);
  return transcription.text;
}

export function usePromptVoice(
  promptBoxRef: RefObject<PromptBoxHandle | null>,
): PromptVoiceConfig {
  const onTranscript = useCallback(
    (text: string) => {
      promptBoxRef.current?.insertTextAtCursor(text);
    },
    [promptBoxRef],
  );

  const getPromptContext = useCallback(
    () => promptBoxRef.current?.getTextBeforeCursor(),
    [promptBoxRef],
  );

  const voiceInput = useVoiceInput({
    onTranscript,
    onTranscribe: requestVoiceTranscription,
    getPromptContext,
  });

  return useMemo<PromptVoiceConfig>(
    () => ({
      state: voiceInput.state,
      errorMessage:
        voiceInput.state === "error" ? voiceInput.errorMessage : undefined,
      isSupported: voiceInput.isSupported,
      start: voiceInput.start,
      stop: voiceInput.stop,
      cancel: voiceInput.cancel,
    }),
    [
      voiceInput.state,
      voiceInput.errorMessage,
      voiceInput.isSupported,
      voiceInput.start,
      voiceInput.stop,
      voiceInput.cancel,
    ],
  );
}
