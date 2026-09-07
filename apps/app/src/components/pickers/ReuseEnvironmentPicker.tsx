import { useMemo } from "react";
import { Button } from "@bb/shared-ui/button";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { LIST_HOVER_TRANSITION } from "@bb/shared-ui/motion";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentLabelIconName,
  REUSE_ENVIRONMENT_ICON_NAME,
  UNNAMED_ENVIRONMENT_LABEL,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { resolveEnvironmentDisplayName } from "@bb/core-ui";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  OPTION_BASE_CLASS_NAME,
  OPTION_INTERACTIVE_CLASS_NAME,
  OPTION_MENU_CONTENT_CLASS_NAME,
  OPTION_MUTED_CLASS_NAME,
  OPTION_TRIGGER_CONTENT_CLASS_NAME,
} from "@bb/shared-ui/option-display";

const REUSE_THREAD_PREVIEW_LIMIT = 2;

export interface ReuseThreadOption {
  environmentId: string;
  branchName: string | null;
  name: string | null;
  path: string | null;
  environmentProviderId: string | null;
  hostName?: string | null;
  threads: ReadonlyArray<{ id: string; title: string }>;
}

export function reuseThreadOptionDisplay(
  option: ReuseThreadOption,
  providers: readonly SystemEnvironmentProvider[] | undefined,
): { label: string; icon: IconName; secondaryText: string | null } {
  const providerLookup = findEnvironmentDisplayProvider(
    providers,
    option.environmentProviderId,
  );
  return {
    label:
      resolveEnvironmentDisplayName(
        {
          name: option.name,
          branchName: option.branchName,
          path: option.path,
          environmentProviderId: option.environmentProviderId,
        },
        providerLookup,
      ) ?? UNNAMED_ENVIRONMENT_LABEL,
    icon: getEnvironmentLabelIconName(providerLookup),
    secondaryText: option.hostName ?? null,
  };
}

interface ReuseEnvironmentPickerProps {
  options: readonly ReuseThreadOption[];
  value: string | null;
  onChange: (environmentId: string) => void;
  muted?: boolean;
  disabled?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
}

export function ReuseEnvironmentPicker({
  options,
  value,
  onChange,
  muted,
  disabled = false,
  defaultOpen,
  modal,
}: ReuseEnvironmentPickerProps) {
  const { providers } = useSystemEnvironmentProviders();
  const activeOption = useMemo(
    () => options.find((option) => option.environmentId === value) ?? null,
    [options, value],
  );
  const trigger =
    activeOption === null
      ? { label: "Pick an environment", icon: REUSE_ENVIRONMENT_ICON_NAME }
      : reuseThreadOptionDisplay(activeOption, providers);
  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={modal}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Environment"
          disabled={disabled}
          data-promptbox-icon-only-control=""
          className={cn(
            OPTION_BASE_CLASS_NAME,
            !disabled && OPTION_INTERACTIVE_CLASS_NAME,
            !disabled && LIST_HOVER_TRANSITION,
            muted && OPTION_MUTED_CLASS_NAME,
            disabled && "cursor-default disabled:opacity-100",
          )}
        >
          <span className={OPTION_TRIGGER_CONTENT_CLASS_NAME}>
            <Icon
              name={trigger.icon}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
            <span className="min-w-0 truncate" data-promptbox-full-label="">
              {trigger.label}
            </span>
          </span>
          {disabled ? null : (
            <Icon
              name="ChevronDown"
              className={cn(
                "shrink-0 text-muted-foreground",
                COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
              )}
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={cn(OPTION_MENU_CONTENT_CLASS_NAME, "max-w-80")}
        mobileTitle="Environment"
      >
        <DropdownMenuLabel>Reuse an existing environment</DropdownMenuLabel>
        {options.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">
            Nothing to reuse yet.
          </div>
        ) : (
          options.map((option) => (
            <ReuseEnvironmentMenuItem
              key={option.environmentId}
              option={option}
              providers={providers}
              isSelected={option.environmentId === value}
              onSelect={onChange}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ReuseEnvironmentMenuItemProps {
  option: ReuseThreadOption;
  providers: readonly SystemEnvironmentProvider[] | undefined;
  isSelected: boolean;
  onSelect: (environmentId: string) => void;
}

function ReuseEnvironmentMenuItem({
  option,
  providers,
  isSelected,
  onSelect,
}: ReuseEnvironmentMenuItemProps) {
  const previewThreads = option.threads.slice(0, REUSE_THREAD_PREVIEW_LIMIT);
  const additionalCount = option.threads.length - previewThreads.length;
  const { label, icon, secondaryText } = reuseThreadOptionDisplay(
    option,
    providers,
  );
  const branchDetail = option.name ? option.branchName : null;
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(option.environmentId)}
      className={cn(
        "flex flex-col items-stretch gap-1 py-2",
        LIST_HOVER_TRANSITION,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon
          name={icon}
          className={cn(
            "shrink-0 text-muted-foreground",
            COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
          )}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate text-xs">
          <span className="min-w-0 truncate font-medium">{label}</span>
          {branchDetail ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {branchDetail}
            </span>
          ) : null}
        </span>
        <Icon
          name="Check"
          className={cn(
            COARSE_POINTER_ICON_SIZE_CLASS,
            isSelected ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
      {secondaryText ? (
        <span className="truncate pl-6 text-xs text-muted-foreground">
          {secondaryText}
        </span>
      ) : null}
      {previewThreads.length > 0 ? (
        <span className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
          {previewThreads.map((thread) => (
            <span key={thread.id} className="truncate">
              {thread.title}
            </span>
          ))}
          {additionalCount > 0 ? (
            <span className="text-muted-foreground">
              +{additionalCount} more
            </span>
          ) : null}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}
