import { ApiError } from "../errors.js";

interface OpenAiTranscriptionResponse {
  text?: unknown;
}

export async function transcribeVoiceInput(args: {
  file: File;
  openAiApiKey: string;
  prompt?: string;
}): Promise<string> {
  if (args.file.size > 25 * 1024 * 1024) {
    throw new ApiError(400, "invalid_request", "Audio file exceeds 25MB limit");
  }

  const formData = new FormData();
  formData.set("model", "gpt-4o-transcribe");
  formData.set("file", args.file, args.file.name);
  if (args.prompt && args.prompt.trim().length > 0) {
    formData.set("prompt", args.prompt.trim());
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.openAiApiKey}`,
    },
    body: formData,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : "Voice transcription failed";
    throw new ApiError(502, "provider_rpc_error", message);
  }

  const parsed = payload as OpenAiTranscriptionResponse | null;
  if (!parsed || typeof parsed.text !== "string") {
    throw new ApiError(502, "provider_rpc_error", "Voice transcription failed");
  }

  return parsed.text;
}
