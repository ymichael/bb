import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import {
  Button,
  Input,
  SettingsCard,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
  StatusPill,
} from "../../src/index.js";

export default {
  title: "Primitives/Settings",
};

const noop = () => undefined;

export function SectionWithControlRows() {
  return (
    <div className="max-w-3xl bg-background p-6 text-foreground">
      <SettingsSection title="Appearance">
        <SettingsWithControl
          label="Theme"
          description="Controls the app chrome and thread surfaces."
        >
          <div className="flex w-full gap-2 sm:w-auto">
            <Button size="sm" variant="outline" onClick={noop}>
              <Check className="size-3.5" />
              Light
            </Button>
            <Button size="sm" variant="ghost" onClick={noop}>
              Dark
            </Button>
          </div>
        </SettingsWithControl>
      </SettingsSection>
    </div>
  );
}

export function ControlWithoutDescription() {
  return (
    <div className="max-w-3xl bg-background p-6 text-foreground">
      <SettingsSection title="Appearance">
        <SettingsWithControl label="Theme">
          <Button
            aria-label="Theme"
            className="w-full justify-between sm:w-48"
            size="sm"
            variant="outline"
            onClick={noop}
          >
            Dark
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </SettingsWithControl>
      </SettingsSection>
    </div>
  );
}

export function CardWithRowList() {
  return (
    <div className="max-w-3xl bg-background p-6 text-foreground">
      <SettingsCard
        title="Hosts"
        description="Registered machines available for local workspace tasks."
      >
        <SettingsRowList>
          <SettingsRow>
            <span className="min-w-0 flex-1 truncate">
              Michael's MacBook Pro
              <span className="ml-1.5 text-xs text-muted-foreground">
                host_local
              </span>
            </span>
            <StatusPill variant="emphasis">Connected</StatusPill>
            <Button
              aria-label="Host actions"
              className="h-7 w-7 shrink-0"
              size="icon"
              variant="ghost"
              onClick={noop}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </SettingsRow>
          <SettingsRow>
            <span className="min-w-0 flex-1 truncate">
              Build runner
              <span className="ml-1.5 text-xs text-muted-foreground">
                host_remote
              </span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              Offline - 4h ago
            </span>
            <Button
              aria-label="Host actions"
              className="h-7 w-7 shrink-0"
              size="icon"
              variant="ghost"
              onClick={noop}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </SettingsRow>
        </SettingsRowList>
      </SettingsCard>
    </div>
  );
}

export function CardLoadingAndEmptyStates() {
  return (
    <div className="grid max-w-3xl gap-4 bg-background p-6 text-foreground md:grid-cols-2">
      <SettingsCard title="Agent Credentials">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </SettingsCard>
      <SettingsCard
        title="Environment Variables"
        description="Encrypted values provided to sandboxed agents."
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No variables configured.
          </p>
          <Button size="sm" variant="outline" onClick={noop}>
            Add environment variable
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

export function ControlWithFormInput() {
  return (
    <div className="max-w-3xl bg-background p-6 text-foreground">
      <SettingsCard
        title="Project Sources"
        description="Connect local paths and repositories to this project."
      >
        <SettingsWithControl
          label="Default branch"
          description="Used when creating new workspaces."
        >
          <Input
            aria-label="Default branch"
            className="w-full sm:w-48"
            defaultValue="main"
          />
        </SettingsWithControl>
      </SettingsCard>
    </div>
  );
}
