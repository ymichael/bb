import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";

interface ProviderCliVersionBannerProps {
  displayName: string;
  currentVersion: string | null;
  minimumSupportedVersion: string | null;
  canUpdate: boolean;
  updating: boolean;
  onUpdate: () => void;
}

function versionRequirementCopy(
  currentVersion: string | null,
  minimumSupportedVersion: string | null,
): string {
  if (currentVersion !== null && minimumSupportedVersion !== null) {
    return `Installed ${currentVersion}; version ${minimumSupportedVersion} or newer is required.`;
  }
  if (currentVersion !== null) {
    return `Installed ${currentVersion}; a newer version is required.`;
  }
  if (minimumSupportedVersion !== null) {
    return `Version ${minimumSupportedVersion} or newer is required.`;
  }
  return "A newer version is required.";
}

export function ProviderCliVersionBanner({
  displayName,
  currentVersion,
  minimumSupportedVersion,
  canUpdate,
  updating,
  onUpdate,
}: ProviderCliVersionBannerProps) {
  return (
    <PromptStackCard
      ariaLabel={`${displayName} update required`}
      className="overflow-hidden border-attention/50 bg-surface-attention shadow-sm"
    >
      <div
        role="alert"
        className="flex min-h-14 max-w-full items-center gap-3 px-3 py-2.5"
      >
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-attention/15 text-warning-text ring-1 ring-attention/25"
          aria-hidden
        >
          <Icon name="AlertTriangle" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            {displayName} update required
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Update {displayName} before starting a thread.{" "}
            {versionRequirementCopy(currentVersion, minimumSupportedVersion)}
          </p>
        </div>
        {canUpdate ? (
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 px-3"
            disabled={updating}
            onClick={onUpdate}
          >
            {updating ? (
              <>
                <Icon name="Spinner" className="animate-spin" />
                Updating…
              </>
            ) : (
              `Update ${displayName}`
            )}
          </Button>
        ) : null}
      </div>
    </PromptStackCard>
  );
}
