import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type VoiceInputState =
  | "idle"
  | "checking-capability"
  | "listening"
  | "transcribing"
  | "error";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

type SpeechRecognitionErrorCode =
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "no-speech"
  | "language-not-supported"
  | "bad-grammar";

interface SpeechRecognitionErrorEventLike extends Event {
  error: SpeechRecognitionErrorCode;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

function resolveSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function mapSpeechErrorToMessage(code: SpeechRecognitionErrorCode): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission denied";
    case "audio-capture":
      return "No microphone was found";
    case "network":
      return "Voice transcription network error";
    case "no-speech":
      return "No speech detected";
    case "language-not-supported":
      return "Language is not supported";
    case "aborted":
      return "Voice capture was aborted";
    case "bad-grammar":
      return "Speech grammar error";
    default:
      return "Voice input failed";
  }
}

function normalizeTranscript(rawText: string): string {
  return rawText.replace(/\s+/g, " ").trim();
}

export function useVoiceInput({
  onTranscript,
}: {
  onTranscript: (transcript: string) => void;
}) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isStoppingRef = useRef(false);
  const [state, setState] = useState<VoiceInputState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    const SpeechRecognition = resolveSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setIsSupported(false);
      setState("idle");
      setErrorMessage(undefined);
      recognitionRef.current = null;
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      isStoppingRef.current = false;
      setErrorMessage(undefined);
      setState("listening");
    };
    recognition.onerror = (event) => {
      setErrorMessage(mapSpeechErrorToMessage(event.error));
      setState("error");
    };
    recognition.onresult = (event) => {
      const finalParts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        const transcript = normalizeTranscript(result[0]?.transcript ?? "");
        if (transcript.length > 0) {
          finalParts.push(transcript);
        }
      }
      if (finalParts.length === 0) return;

      setState("transcribing");
      onTranscript(finalParts.join(" "));
      setState("listening");
    };
    recognition.onend = () => {
      if (isStoppingRef.current) {
        isStoppingRef.current = false;
      }
      setState((prevState) => (prevState === "error" ? "error" : "idle"));
    };

    recognitionRef.current = recognition;
    setIsSupported(true);
    setState("idle");
    setErrorMessage(undefined);

    return () => {
      recognitionRef.current = null;
      recognition.onstart = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // noop
      }
    };
  }, [onTranscript]);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setState("error");
      setErrorMessage("Voice input is not supported in this browser");
      return;
    }

    if (state === "listening" || state === "transcribing") {
      return;
    }

    setState("checking-capability");
    setErrorMessage(undefined);
    try {
      recognition.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice input failed";
      setState("error");
      setErrorMessage(message);
    }
  }, [state]);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    isStoppingRef.current = true;
    try {
      recognition.stop();
    } catch {
      isStoppingRef.current = false;
    }
  }, []);

  const statusLabel = useMemo(() => {
    switch (state) {
      case "checking-capability":
        return "Checking mic...";
      case "listening":
        return "Listening...";
      case "transcribing":
        return "Transcribing...";
      case "error":
        return errorMessage ?? "Voice input failed";
      case "idle":
      default:
        return null;
    }
  }, [errorMessage, state]);

  return {
    state,
    statusLabel,
    errorMessage,
    isSupported,
    isListening: state === "listening" || state === "transcribing",
    start,
    stop,
  };
}
