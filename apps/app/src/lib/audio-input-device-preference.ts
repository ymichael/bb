import { useAtom, useAtomValue } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createLocalStorageSyncStorage } from "./browser-storage";

const AUDIO_INPUT_DEVICE_STORAGE_KEY = "bb.voiceInput.audioInputDeviceId";

export type PreferredAudioInputDeviceId = string | null;

const MAX_AUDIO_INPUT_DEVICE_ID_LENGTH = 1024;

function isStoredAudioInputDeviceId(
  value: string,
): value is NonNullable<PreferredAudioInputDeviceId> {
  return (
    value.trim().length > 0 && value.length <= MAX_AUDIO_INPUT_DEVICE_ID_LENGTH
  );
}

export function parsePreferredAudioInputDeviceId(
  storedValue: string | null,
  initialValue: PreferredAudioInputDeviceId,
): PreferredAudioInputDeviceId {
  if (storedValue === null) {
    return initialValue;
  }
  return isStoredAudioInputDeviceId(storedValue) ? storedValue : initialValue;
}

const audioInputDeviceStorage =
  createLocalStorageSyncStorage<PreferredAudioInputDeviceId>({
    parse: parsePreferredAudioInputDeviceId,
    serialize: (value) => value ?? "",
  });

const audioInputDevicePreferenceAtom =
  atomWithStorage<PreferredAudioInputDeviceId>(
    AUDIO_INPUT_DEVICE_STORAGE_KEY,
    null,
    audioInputDeviceStorage,
    { getOnInit: true },
  );

export function buildAudioInputConstraints(
  preferredDeviceId: PreferredAudioInputDeviceId,
): MediaStreamConstraints {
  if (preferredDeviceId === null) {
    return { audio: true };
  }

  return {
    audio: {
      deviceId: { exact: preferredDeviceId },
    },
  };
}

export function useAudioInputDevicePreference() {
  return useAtom(audioInputDevicePreferenceAtom);
}

export function useAudioInputDevicePreferenceValue() {
  return useAtomValue(audioInputDevicePreferenceAtom);
}
