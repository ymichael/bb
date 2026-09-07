export type VoiceUnsupportedReason = "insecure-origin" | "unsupported-browser";

export interface VoiceSupportEnvironment {
  hasMediaDevices: boolean;
  hasMediaRecorder: boolean;
  isSecureContext: boolean;
}

export interface VoiceSupport {
  isSupported: boolean;
  reason: VoiceUnsupportedReason | null;
}

export function resolveVoiceSupport(
  environment: VoiceSupportEnvironment,
): VoiceSupport {
  if (environment.hasMediaDevices && environment.hasMediaRecorder) {
    return { isSupported: true, reason: null };
  }
  return {
    isSupported: false,
    reason: environment.isSecureContext
      ? "unsupported-browser"
      : "insecure-origin",
  };
}

export function voiceUnsupportedMessage(
  reason: VoiceUnsupportedReason | null,
): string {
  return reason === "insecure-origin"
    ? "Voice input needs an HTTPS connection to this server"
    : "Voice input is not supported in this browser";
}

export function readVoiceSupportEnvironment(): VoiceSupportEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      hasMediaDevices: false,
      hasMediaRecorder: false,
      isSecureContext: true,
    };
  }
  return {
    hasMediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: typeof window.MediaRecorder !== "undefined",
    isSecureContext: window.isSecureContext !== false,
  };
}
