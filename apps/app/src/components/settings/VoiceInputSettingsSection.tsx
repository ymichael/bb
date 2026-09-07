import { Button } from "@bb/shared-ui/button";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@bb/shared-ui/tooltip";
import {
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useAudioInputDevices,
  type AudioInputDeviceOption,
} from "@/hooks/useAudioInputDevices";
import {
  useAudioInputDevicePreference,
  type PreferredAudioInputDeviceId,
} from "@/lib/audio-input-device-preference";

interface VoiceInputSettingsSectionContentProps {
  devices: readonly AudioInputDeviceOption[];
  errorMessage: string | null;
  isLoading: boolean;
  isSupported: boolean;
  onDeviceChange: (deviceId: PreferredAudioInputDeviceId) => void;
  onRefresh: (requestPermission: boolean) => void;
  preferredDeviceId: PreferredAudioInputDeviceId;
}

const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "h-7 w-full justify-between border-border/60 bg-card px-2 text-xs sm:w-44";
const SETTINGS_DROPDOWN_CONTENT_CLASS =
  "min-w-[var(--radix-dropdown-menu-trigger-width)]";
const SYSTEM_DEFAULT_MICROPHONE_LABEL = "System default";
const MICROPHONE_SETTING_LABEL = "Microphone";

function selectedMicrophoneLabel({
  devices,
  isSupported,
  preferredDeviceId,
}: {
  devices: readonly AudioInputDeviceOption[];
  isSupported: boolean;
  preferredDeviceId: PreferredAudioInputDeviceId;
}): string {
  if (!isSupported) {
    return "Unsupported";
  }
  if (preferredDeviceId === null) {
    return SYSTEM_DEFAULT_MICROPHONE_LABEL;
  }
  return (
    devices.find((device) => device.deviceId === preferredDeviceId)?.label ??
    "Unavailable microphone"
  );
}

function microphoneSettingDescription({
  devices,
  errorMessage,
  isLoading,
  isSupported,
  preferredDeviceId,
}: {
  devices: readonly AudioInputDeviceOption[];
  errorMessage: string | null;
  isLoading: boolean;
  isSupported: boolean;
  preferredDeviceId: PreferredAudioInputDeviceId;
}): string {
  if (!isSupported) {
    return "This browser does not expose microphone devices.";
  }
  if (isLoading) {
    return "Loading microphones.";
  }
  if (errorMessage !== null) {
    return errorMessage;
  }
  if (
    preferredDeviceId !== null &&
    devices.every((device) => device.deviceId !== preferredDeviceId)
  ) {
    return "Selected microphone is unavailable.";
  }
  if (devices.length === 0) {
    return "No microphones found.";
  }
  return "Used for prompt voice input.";
}

export function VoiceInputSettingsSectionContent({
  devices,
  errorMessage,
  isLoading,
  isSupported,
  onDeviceChange,
  onRefresh,
  preferredDeviceId,
}: VoiceInputSettingsSectionContentProps) {
  const triggerLabel = selectedMicrophoneLabel({
    devices,
    isSupported,
    preferredDeviceId,
  });

  return (
    <SettingsSection
      title="Voice Input"
      actionPlacement="inline"
      action={
        <Tooltip delayDuration={300} disableHoverableContent>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              disabled={!isSupported || isLoading}
              onClick={() => onRefresh(true)}
              aria-label={
                isLoading ? "Loading microphones" : "Load microphones"
              }
            >
              <Icon
                name="RotateCcw"
                className={cn("size-3.5", isLoading && "animate-spin")}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Load microphones</TooltipContent>
        </Tooltip>
      }
    >
      <SettingsWithControl
        label={MICROPHONE_SETTING_LABEL}
        description={microphoneSettingDescription({
          devices,
          errorMessage,
          isLoading,
          isSupported,
          preferredDeviceId,
        })}
      >
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              onRefresh(false);
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
              aria-label={MICROPHONE_SETTING_LABEL}
              disabled={!isSupported}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="Mic" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{triggerLabel}</span>
              </span>
              <Icon
                name="ChevronDown"
                className="size-3.5 text-muted-foreground"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className={SETTINGS_DROPDOWN_CONTENT_CLASS}
            mobileTitle="Microphone"
          >
            <DropdownMenuItem onSelect={() => onDeviceChange(null)}>
              {SYSTEM_DEFAULT_MICROPHONE_LABEL}
              <Icon
                name="Check"
                className={cn(
                  "ml-auto",
                  preferredDeviceId !== null && "opacity-0",
                  COARSE_POINTER_ICON_SIZE_CLASS,
                )}
              />
            </DropdownMenuItem>
            {devices.length > 0 ? <DropdownMenuSeparator /> : null}
            {devices.map((device) => (
              <DropdownMenuItem
                key={device.deviceId}
                onSelect={() => onDeviceChange(device.deviceId)}
              >
                <span className="min-w-0 truncate">{device.label}</span>
                <Icon
                  name="Check"
                  className={cn(
                    "ml-auto",
                    preferredDeviceId !== device.deviceId && "opacity-0",
                    COARSE_POINTER_ICON_SIZE_CLASS,
                  )}
                />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SettingsWithControl>
    </SettingsSection>
  );
}

export function VoiceInputSettingsSection() {
  const [preferredDeviceId, setPreferredDeviceId] =
    useAudioInputDevicePreference();
  const { devices, errorMessage, isLoading, isSupported, refresh } =
    useAudioInputDevices();

  return (
    <VoiceInputSettingsSectionContent
      devices={devices}
      errorMessage={errorMessage}
      isLoading={isLoading}
      isSupported={isSupported}
      onDeviceChange={setPreferredDeviceId}
      onRefresh={(requestPermission) => {
        void refresh({ requestPermission });
      }}
      preferredDeviceId={preferredDeviceId}
    />
  );
}
