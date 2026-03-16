import { assertNever } from "@bb/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

interface UseVoiceInputOptions {
  onTranscript: (transcript: string) => void;
  onTranscribe: (args: {
    file: File;
    promptContext?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  getPromptContext?: () => string | undefined;
}

const MIN_RECORDING_DURATION_MS = 1_000;
const CHUNK_TIMESLICE_MS = 250;
const MAX_ERROR_MESSAGE_LENGTH = 180;

const HTML_DOCUMENT_PATTERN = /<!doctype html|<html[\s>]/i;

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

function sanitizeErrorMessage(raw: string): string | null {
  let normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const htmlDocumentMatch = normalized.search(HTML_DOCUMENT_PATTERN);
  if (htmlDocumentMatch >= 0) {
    normalized = normalized.slice(0, htmlDocumentMatch).trim();
  }
  if (normalized.length === 0) {
    return null;
  }

  normalized = normalized.replace(/^HTTP\s+\d{3}:\s*/i, "").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > MAX_ERROR_MESSAGE_LENGTH) {
    return `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}...`;
  }
  return normalized;
}

function resolveRecordingErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No microphone was found";
      case "NotReadableError":
      case "TrackStartError":
        return "Microphone is already in use";
      case "AbortError":
        return "Voice capture was aborted";
      default:
        return "Failed to start voice recording";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    const message = sanitizeErrorMessage(error.message);
    if (message) {
      return message;
    }
  }
  return "Voice input failed";
}

function resolvePreferredAudioMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg"];
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createRecordingFile(audioBlob: Blob, mimeType: string): File {
  const extension = mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("mp4")
      ? "mp4"
      : "webm";
  return new File([audioBlob], `recording.${extension}`, {
    type: mimeType,
  });
}

export function useVoiceInput(options: UseVoiceInputOptions) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtMsRef = useRef<number | null>(null);
  const promptContextRef = useRef<string | undefined>(undefined);
  const shouldTranscribeRef = useRef(true);
  const transcriptionAbortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isSupported, setIsSupported] = useState(false);

  const stopMediaStream = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      setIsSupported(false);
      return;
    }
    const hasMediaDevices = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
    const hasMediaRecorder = typeof window.MediaRecorder !== "undefined";
    setIsSupported(hasMediaDevices && hasMediaRecorder);
  }, []);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        try {
          recorder.stop();
        } catch {
          // noop
        }
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      shouldTranscribeRef.current = true;
      if (transcriptionAbortRef.current) {
        transcriptionAbortRef.current.abort();
        transcriptionAbortRef.current = null;
      }
      stopMediaStream();
    };
  }, [stopMediaStream]);

  const start = useCallback(async () => {
    if (!isSupported) {
      setState("error");
      setErrorMessage("Voice input is not supported in this browser");
      return;
    }
    if (state === "recording" || state === "transcribing") {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      startedAtMsRef.current = Date.now();
      promptContextRef.current = options.getPromptContext?.();
      shouldTranscribeRef.current = true;

      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.onstart = () => {
        setErrorMessage(undefined);
        setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setState("error");
        setErrorMessage("Voice recording failed");
      };

      recorder.onstop = async () => {
        stopMediaStream();

        if (!shouldTranscribeRef.current) {
          shouldTranscribeRef.current = true;
          chunksRef.current = [];
          promptContextRef.current = undefined;
          setErrorMessage(undefined);
          setState("idle");
          return;
        }

        const startedAtMs = startedAtMsRef.current ?? Date.now();
        startedAtMsRef.current = null;
        const durationMs = Date.now() - startedAtMs;

        if (durationMs < MIN_RECORDING_DURATION_MS) {
          setState("error");
          setErrorMessage("Recording too short (minimum 1 second)");
          chunksRef.current = [];
          promptContextRef.current = undefined;
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) {
          setState("error");
          setErrorMessage("No audio was captured");
          promptContextRef.current = undefined;
          return;
        }

        const recordedMimeType = recorder.mimeType || preferredMimeType || "audio/webm";
        const audioBlob = new Blob(chunks, { type: recordedMimeType });
        const audioFile = createRecordingFile(audioBlob, recordedMimeType);
        const promptContext = promptContextRef.current;
        promptContextRef.current = undefined;

        setState("transcribing");
        const abortController = new AbortController();
        transcriptionAbortRef.current = abortController;
        try {
          const transcript = await options.onTranscribe({
            file: audioFile,
            promptContext,
            signal: abortController.signal,
          });
          const normalized = normalizeTranscript(transcript);
          if (normalized.length === 0) {
            throw new Error("Voice transcription returned an empty result.");
          }
          options.onTranscript(normalized);
          setErrorMessage(undefined);
          setState("idle");
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            setErrorMessage(undefined);
            setState("idle");
            return;
          }
          setState("error");
          setErrorMessage(resolveRecordingErrorMessage(error));
        } finally {
          if (transcriptionAbortRef.current === abortController) {
            transcriptionAbortRef.current = null;
          }
        }
      };

      recorder.start(CHUNK_TIMESLICE_MS);
    } catch (error) {
      stopMediaStream();
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      shouldTranscribeRef.current = true;
      transcriptionAbortRef.current = null;
      setState("error");
      setErrorMessage(resolveRecordingErrorMessage(error));
    }
  }, [isSupported, options, state, stopMediaStream]);

  const stop = useCallback(() => {
    if (state !== "recording") {
      return;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }
    shouldTranscribeRef.current = true;
    try {
      recorder.stop();
    } catch (error) {
      setState("error");
      setErrorMessage(resolveRecordingErrorMessage(error));
    }
  }, [state]);

  const cancel = useCallback(() => {
    if (state === "recording") {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        shouldTranscribeRef.current = false;
        try {
          recorder.stop();
        } catch (error) {
          setState("error");
          setErrorMessage(resolveRecordingErrorMessage(error));
        }
      }
      return;
    }

    if (state === "transcribing") {
      const abortController = transcriptionAbortRef.current;
      if (abortController) {
        abortController.abort();
        transcriptionAbortRef.current = null;
      }
      setErrorMessage(undefined);
      setState("idle");
    }
  }, [state]);

  const statusLabel = useMemo(() => {
    switch (state) {
      case "recording":
        return "Recording...";
      case "transcribing":
        return "Transcribing...";
      case "error":
        return errorMessage ?? "Voice input failed";
      case "idle":
        return null;
    }
    return assertNever(state);
  }, [errorMessage, state]);

  return {
    state,
    statusLabel,
    errorMessage,
    isSupported,
    isRecording: state === "recording",
    isProcessing: state === "transcribing",
    isListening: state === "recording" || state === "transcribing",
    start,
    stop,
    cancel,
  };
}
