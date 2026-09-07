import { useCallback, useEffect, useRef, useState } from "react";
import { appToast } from "@/components/ui/app-toast";
import {
  buildAudioInputConstraints,
  useAudioInputDevicePreferenceValue,
} from "@/lib/audio-input-device-preference";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
  voiceUnsupportedMessage,
  type VoiceUnsupportedReason,
} from "./voice-input-support";

type VoiceInputState = "idle" | "recording" | "transcribing" | "error";

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

  return normalized;
}

function resolveRecordingErrorMessage(
  error: unknown,
  hasPreferredAudioInput = false,
): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone permission denied";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return hasPreferredAudioInput
          ? "Selected microphone was not found"
          : "No microphone was found";
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
  const preferredAudioInputDeviceId = useAudioInputDevicePreferenceValue();
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtMsRef = useRef<number | null>(null);
  const promptContextRef = useRef<string | undefined>(undefined);
  const shouldTranscribeRef = useRef(true);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const wakeLockRequestRef = useRef<Promise<void> | null>(null);
  const shouldHoldWakeLockRef = useRef(false);

  const [state, setState] = useState<VoiceInputState>("idle");
  const [isSupported, setIsSupported] = useState(false);
  const [unsupportedReason, setUnsupportedReason] =
    useState<VoiceUnsupportedReason | null>("unsupported-browser");
  const [stream, setStream] = useState<MediaStream | null>(null);

  const showError = useCallback((message: string) => {
    setState("error");
    appToast.error("Voice input failed", { description: message });
  }, []);

  const stopMediaStream = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const requestRecordingWakeLock = useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      typeof document === "undefined" ||
      !("wakeLock" in navigator) ||
      window.isSecureContext === false ||
      document.visibilityState !== "visible"
    ) {
      return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock) {
      return;
    }

    const currentSentinel = wakeLockSentinelRef.current;
    if (currentSentinel && !currentSentinel.released) {
      return;
    }
    if (wakeLockRequestRef.current) {
      return;
    }

    wakeLockRequestRef.current = wakeLock
      .request("screen")
      .then((sentinel) => {
        if (!shouldHoldWakeLockRef.current) {
          if (!sentinel.released) {
            void sentinel.release().catch(() => {});
          }
          return;
        }

        wakeLockSentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (wakeLockSentinelRef.current === sentinel) {
            wakeLockSentinelRef.current = null;
          }
        });
      })
      .catch(() => {})
      .finally(() => {
        wakeLockRequestRef.current = null;
      });
  }, []);

  const releaseRecordingWakeLock = useCallback(() => {
    shouldHoldWakeLockRef.current = false;

    const sentinel = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;
    if (!sentinel || sentinel.released) {
      return;
    }

    void sentinel.release().catch(() => {});
  }, []);

  useEffect(() => {
    const support = resolveVoiceSupport(readVoiceSupportEnvironment());
    setIsSupported(support.isSupported);
    setUnsupportedReason(support.reason);
  }, []);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        try {
          recorder.stop();
        } catch {}
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
      startedAtMsRef.current = null;
      promptContextRef.current = undefined;
      shouldTranscribeRef.current = true;
      releaseRecordingWakeLock();
      if (transcriptionAbortRef.current) {
        transcriptionAbortRef.current.abort();
        transcriptionAbortRef.current = null;
      }
      stopMediaStream();
    };
  }, [releaseRecordingWakeLock, stopMediaStream]);

  useEffect(() => {
    return subscribeToDocumentVisibility(() => {
      if (isDocumentVisible() && shouldHoldWakeLockRef.current) {
        requestRecordingWakeLock();
      }
    });
  }, [requestRecordingWakeLock]);

  const start = useCallback(async () => {
    if (!isSupported) {
      showError(voiceUnsupportedMessage(unsupportedReason));
      return;
    }
    if (state === "recording" || state === "transcribing") {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        buildAudioInputConstraints(preferredAudioInputDeviceId),
      );
      streamRef.current = stream;
      setStream(stream);
      chunksRef.current = [];
      startedAtMsRef.current = Date.now();
      promptContextRef.current = options.getPromptContext?.();
      shouldTranscribeRef.current = true;
      shouldHoldWakeLockRef.current = true;
      requestRecordingWakeLock();

      const preferredMimeType = resolvePreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.onstart = () => {
        setState("recording");
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        showError("Voice recording failed");
      };

      recorder.onstop = async () => {
        releaseRecordingWakeLock();
        stopMediaStream();

        if (!shouldTranscribeRef.current) {
          shouldTranscribeRef.current = true;
          chunksRef.current = [];
          promptContextRef.current = undefined;
          setState("idle");
          return;
        }

        const startedAtMs = startedAtMsRef.current ?? Date.now();
        startedAtMsRef.current = null;
        const durationMs = Date.now() - startedAtMs;

        if (durationMs < MIN_RECORDING_DURATION_MS) {
          showError("Recording too short (minimum 1 second)");
          chunksRef.current = [];
          promptContextRef.current = undefined;
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length === 0) {
          showError("No audio was captured");
          promptContextRef.current = undefined;
          return;
        }

        const recordedMimeType =
          recorder.mimeType || preferredMimeType || "audio/webm";
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
          setState("idle");
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            setState("idle");
            return;
          }
          showError(resolveRecordingErrorMessage(error));
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
      releaseRecordingWakeLock();
      showError(
        resolveRecordingErrorMessage(
          error,
          preferredAudioInputDeviceId !== null,
        ),
      );
    }
  }, [
    isSupported,
    options,
    unsupportedReason,
    preferredAudioInputDeviceId,
    releaseRecordingWakeLock,
    requestRecordingWakeLock,
    showError,
    state,
    stopMediaStream,
  ]);

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
      showError(resolveRecordingErrorMessage(error));
    }
  }, [showError, state]);

  const cancel = useCallback(() => {
    if (state === "recording") {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === "recording") {
        shouldTranscribeRef.current = false;
        try {
          recorder.stop();
        } catch (error) {
          showError(resolveRecordingErrorMessage(error));
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
      setState("idle");
    }
  }, [showError, state]);

  return {
    state,
    isSupported,
    unsupportedReason,
    stream,
    isRecording: state === "recording",
    isProcessing: state === "transcribing",
    isListening: state === "recording" || state === "transcribing",
    start,
    stop,
    cancel,
  };
}
