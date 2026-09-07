import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BbDesktopInfo } from "@bb/desktop-contract";
import type { SystemVersionResponse } from "@bb/server-contract";
import {
  RETRY_ACTION_ICON,
  UPDATE_ACTION_ICON,
  UPDATE_STATE_PRESENTATION,
  type UpdateState,
} from "@bb/domain/update-state";
import { Button, type ButtonProps } from "@bb/shared-ui/button";
import { usePrefersReducedMotion } from "@bb/shared-ui/hooks/use-media-query";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import {
  ResourceActionButton,
  ResourceListState,
  ResourceRow,
} from "@bb/shared-ui/resource-list";
import {
  hasProviderCliAction,
  isProviderCliUpdateIssue,
  providerCliEntries,
  useProviderCliInstallRunner,
  type ProviderCliActionableIssue,
  type ProviderCliIssue,
  type ProviderCliStatusEntry,
} from "@/components/provider-cli/provider-cli-install";
import {
  openProviderCliInstallLog,
  providerCliJobKey,
  type ProviderCliInstallFailure,
} from "@/components/provider-cli/provider-cli-install-store";
import {
  checkErrorDescription,
  getAppUpdateCheckSnapshot,
  startAppUpdateCheck,
  subscribeAppUpdateCheck,
} from "@/components/settings/app-update-check-store";
import {
  fetchLatestChangelogEntry,
  LATEST_CHANGELOG_ENTRY,
  RELEASE_META,
  type ChangelogBlock,
} from "@/components/settings/changelog-preview";
import { appToast } from "@/components/ui/app-toast";
import { BbLogo } from "@/components/ui/bb-logo";
import { OverflowFade } from "@/components/ui/overflow-fade";
import {
  SettingsBadge,
  SettingsRowList,
  SettingsSection,
} from "@/components/ui/settings-section";
import { invalidateHostProviderCliStatus } from "@/hooks/cache-owners/provider-cli-status-cache-owner";
import { hydrateSystemVersionCache } from "@/hooks/cache-owners/system-version-cache-owner";
import { useRetryHostUpdate } from "@/hooks/mutations/host-mutations";
import {
  useUpdateInventory,
  type UpdateInventoryMachine,
} from "@/hooks/useUpdateInventory";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  hostCanRetryUpdate,
  hostNeedsUpdate,
  hostUpdateIsStalled,
} from "@/lib/host-update-status";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import {
  getSettingsMachineRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { sdk } from "@/lib/sdk";
import { rawStringLocalStorage } from "@/lib/browser-storage";

const EMPTY_PROVIDER_CLI_FAILURES: ReadonlyMap<
  string,
  ProviderCliInstallFailure
> = new Map();
const CHANGELOG_URL = "https://getbb.app/changelog";
const CHANGELOG_STALE_TIME_MS = 5 * 60_000;
const CHANGELOG_DISMISSED_VERSION_STORAGE_KEY =
  "bb.settings.updates.dismissed-changelog-version";
const CHANGELOG_DISMISS_CONFIRMATION_MS = 2_000;
const CHANGELOG_DISMISS_EXIT_MS = 180;

interface ChangelogDismissal {
  phase: "confirming" | "exiting";
  version: string;
}

function isNewerChangelogVersion(
  candidate: string,
  dismissed: string,
): boolean {
  const versionPattern = /^\d+(?:\.\d+)*$/;
  if (!versionPattern.test(candidate) || !versionPattern.test(dismissed)) {
    return candidate !== dismissed;
  }
  const candidateParts = candidate.split(".").map(Number);
  const dismissedParts = dismissed.split(".").map(Number);
  const partCount = Math.max(candidateParts.length, dismissedParts.length);
  for (let index = 0; index < partCount; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const dismissedPart = dismissedParts[index] ?? 0;
    if (candidatePart !== dismissedPart) {
      return candidatePart > dismissedPart;
    }
  }
  return false;
}

const BULK_RETRY_THRESHOLD = 1;

export function UpdateActionButton({
  label,
  tooltipLabel,
  icon,
  iconPosition = "start",
  visibleLabel,
  className,
  variant,
  loading = false,
  disabled = false,
  disabledReason,
  onClick,
}: {
  label: string;
  tooltipLabel?: string;
  icon: IconName;
  iconPosition?: "start" | "end";
  visibleLabel?: string;
  className?: string;
  variant?: ButtonProps["variant"];
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode;
  onClick?: () => void;
}) {
  if (visibleLabel === undefined) {
    return (
      <ResourceActionButton
        label={label}
        tooltipLabel={tooltipLabel}
        icon={icon}
        loading={loading}
        disabled={disabled}
        disabledReason={disabledReason}
        className={cn(
          "size-7",
          variant === "default" &&
            "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
          className,
        )}
        onClick={() => onClick?.()}
      />
    );
  }
  const isQuiet = variant === undefined || variant === "ghost";
  return (
    <Button
      type="button"
      variant={variant ?? "ghost"}
      size="sm"
      aria-label={label}
      aria-busy={loading}
      disabled={disabled}
      className={cn(
        "h-7 gap-1.5 px-2.5 font-normal",
        isQuiet && "text-subtle-foreground hover:text-foreground",
        className,
      )}
      onClick={onClick}
    >
      {iconPosition === "end" ? visibleLabel : null}
      <Icon
        aria-hidden
        name={loading ? "Spinner" : icon}
        className={cn("size-3.5", loading && "animate-spin")}
      />
      {iconPosition === "start" ? visibleLabel : null}
    </Button>
  );
}

const ROW_GRID =
  "grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3";

const ROW_SPACING = "py-2 first:pt-0 last:pb-0";

function UpdatesRow({
  leading,
  children,
  className,
}: {
  leading?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(ROW_GRID, ROW_SPACING, "text-sm", className)}>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {leading}
      </span>
      {children}
    </div>
  );
}

function RowVersions({
  current,
  latest,
}: {
  current: string | null;
  latest: string | null;
}) {
  if (current === null) {
    return null;
  }
  return (
    <span
      data-version-metadata
      className="min-w-0 shrink text-2xs text-muted-foreground"
    >
      {current}
      {latest !== null && latest !== current ? (
        <>
          <span className="px-1">→</span>
          {}
          <span className="font-semibold text-version-upgrade">{latest}</span>
        </>
      ) : null}
    </span>
  );
}

function RowName({
  name,
  detail,
  current,
  latest,
}: {
  name: string;
  detail?: ReactNode;
  current: string | null;
  latest: string | null;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="truncate text-sm font-medium text-foreground">
        {name}
      </span>
      {detail}
      <RowVersions current={current} latest={latest} />
    </span>
  );
}

function stateTextClass(state: UpdateState): string {
  return UPDATE_STATE_PRESENTATION[state].tone === "error"
    ? "font-semibold text-destructive"
    : "font-semibold text-subtle-foreground";
}

function RowStateCaption({
  state,
  children,
}: {
  state: UpdateState;
  children: ReactNode;
}) {
  return (
    <span className={cn("shrink-0 text-xs", stateTextClass(state))}>
      {children}
    </span>
  );
}

function RowStateControl({
  state,
  actionIcon,
  actionLabel,
  actionTooltip,
  buttonLeading,
  buttonLabel,
  loading = false,
  live = false,
  onClick,
}: {
  state: UpdateState;
  actionIcon?: IconName;
  actionLabel?: string;
  actionTooltip?: string;
  buttonLeading?: ReactNode;
  buttonLabel?: string;
  loading?: boolean;
  live?: boolean;
  onClick?: () => void;
}) {
  const presentation = UPDATE_STATE_PRESENTATION[state];
  const icon = actionIcon ?? (presentation.icon as IconName | null);
  const buttonIcon =
    state === "failed" ? (RETRY_ACTION_ICON as IconName) : null;
  const spin = loading || presentation.inFlight === true;
  const srLabel = presentation.label;
  const explainOnHover = presentation.inFlight !== true;

  if (onClick !== undefined && buttonLabel !== undefined) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={[srLabel, actionLabel].filter(Boolean).join(" · ")}
          aria-busy={loading}
          disabled={loading}
          className="h-6 shrink-0 gap-1.5 px-2 text-xs"
          onClick={onClick}
        >
          {loading ? (
            <Icon aria-hidden name="Loading" className="size-3 animate-spin" />
          ) : buttonLeading !== undefined ? (
            buttonLeading
          ) : buttonIcon === null ? null : (
            <Icon aria-hidden name={buttonIcon} className="size-3" />
          )}
          {buttonLabel}
        </Button>
      </span>
    );
  }

  if (onClick !== undefined && icon !== null) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <UpdateActionButton
          label={[srLabel, actionLabel].filter(Boolean).join(" · ")}
          tooltipLabel={actionTooltip ?? actionLabel ?? presentation.label}
          icon={icon}
          loading={loading}
          onClick={onClick}
        />
      </span>
    );
  }

  if (icon === null) {
    return <span className="flex h-7 shrink-0 items-center" />;
  }

  const mark = (
    <span
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      data-update-state={state}
      className="flex size-7 shrink-0 items-center justify-center"
    >
      <Icon
        aria-hidden
        name={icon}
        className={cn(
          "size-4",
          spin && "animate-spin",
          presentation.tone === "muted" &&
            (state === "up-to-date" ? "text-input" : "text-subtle-foreground"),
          presentation.tone === "error" && "text-destructive",
        )}
      />
      <span className="sr-only">{srLabel}</span>
    </span>
  );

  if (!explainOnHover) {
    return <span className="flex min-w-0 items-center gap-1.5">{mark}</span>;
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>{mark}</TooltipTrigger>
          {}
          <TooltipContent>{presentation.label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto flex shrink-0 items-center justify-end gap-1">
      {children}
    </span>
  );
}

const CHANGELOG_INLINE_COMPONENTS: Components = {
  p: ({ children }) => <>{children}</>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
      onClick={(event) => {
        event.preventDefault();
        if (href !== undefined) {
          openUrlInExternalBrowser(href);
        }
      }}
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
      {children}
    </code>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};

function ChangelogInline({ text }: { text: string }) {
  return (
    <ReactMarkdown components={CHANGELOG_INLINE_COMPONENTS} skipHtml>
      {text}
    </ReactMarkdown>
  );
}

function ChangelogBlocks({
  blocks,
  lede = false,
}: {
  blocks: ChangelogBlock[];
  lede?: boolean;
}) {
  return blocks.map((block, index) =>
    block.kind === "list" ? (
      <ul key={index} className="mt-2.5 space-y-1.5">
        {block.items.map((item) => (
          <li
            key={item}
            className="relative pl-4 text-sm leading-normal text-muted-foreground before:absolute before:left-0 before:top-2 before:size-1 before:rounded-sm before:bg-border"
          >
            <ChangelogInline text={item} />
          </li>
        ))}
      </ul>
    ) : (
      <p
        key={index}
        className={cn(
          "mt-2.5 text-sm leading-relaxed text-muted-foreground first:mt-0",
          lede && "text-foreground/80",
        )}
      >
        <ChangelogInline text={block.text} />
      </p>
    ),
  );
}

export function ChangelogPreviewCard() {
  const changelogQuery = useQuery({
    queryKey: ["updates", "changelog", "latest"],
    queryFn: ({ signal }) => fetchLatestChangelogEntry(fetch, signal),
    placeholderData: LATEST_CHANGELOG_ENTRY ?? undefined,
    retry: false,
    staleTime: CHANGELOG_STALE_TIME_MS,
  });
  const entry = changelogQuery.data ?? LATEST_CHANGELOG_ENTRY;
  const [dismissedVersion, setDismissedVersion] = useState(() =>
    rawStringLocalStorage.getItem(CHANGELOG_DISMISSED_VERSION_STORAGE_KEY, ""),
  );
  const [dismissal, setDismissal] = useState<ChangelogDismissal | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const releaseBodyRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const syncFade = (node: HTMLDivElement | null) => {
    if (node === null) {
      return;
    }
    setMoreBelow(node.scrollTop + node.clientHeight < node.scrollHeight - 1);
  };
  useEffect(() => {
    syncFade(releaseBodyRef.current);
  }, [entry]);
  useEffect(() => {
    if (dismissal?.phase !== "confirming") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setDismissal((current) =>
        current?.version === dismissal.version
          ? { ...current, phase: "exiting" }
          : current,
      );
    }, CHANGELOG_DISMISS_CONFIRMATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [dismissal]);
  useEffect(() => {
    if (dismissal?.phase !== "exiting") {
      return;
    }
    const dismissedEntryVersion = dismissal.version;
    const timeoutId = window.setTimeout(
      () => {
        setDismissedVersion(dismissedEntryVersion);
        setDismissal((current) =>
          current?.version === dismissedEntryVersion ? null : current,
        );
      },
      prefersReducedMotion ? 0 : CHANGELOG_DISMISS_EXIT_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [dismissal, prefersReducedMotion]);
  if (entry === null) {
    return null;
  }
  if (
    dismissedVersion.length > 0 &&
    (changelogQuery.dataUpdatedAt === 0 ||
      !isNewerChangelogVersion(entry.version, dismissedVersion))
  ) {
    return null;
  }
  const releaseMeta = RELEASE_META[entry.version];
  const dismissalPhase =
    dismissal?.version === entry.version ? dismissal.phase : "visible";
  const releaseVisible = dismissalPhase === "visible";
  return (
    <div
      data-updates-domain="changelog"
      data-changelog-dismiss-phase={dismissalPhase}
      className={cn(
        "grid transition-[grid-template-rows,margin,opacity,transform] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none [&>section]:min-h-0 [&>section]:overflow-hidden",
        dismissalPhase === "exiting"
          ? "-mb-6 grid-rows-[0fr] -translate-y-1 opacity-0"
          : "grid-rows-[1fr] translate-y-0 opacity-100",
      )}
    >
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <div
          data-changelog-release-panel
          aria-hidden={!releaseVisible}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            releaseVisible
              ? "grid-rows-[1fr] opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <article data-changelog-preview className="min-w-0 p-4 sm:p-5">
              <div
                data-changelog-header
                className="flex min-w-0 items-center justify-between gap-4"
              >
                <h2 className="min-w-0">
                  <span
                    data-changelog-label
                    className="inline-flex rounded-sm border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium leading-none text-muted-foreground"
                  >
                    What's new
                  </span>
                </h2>
                {releaseVisible ? (
                  <Tooltip delayDuration={300} disableHoverableContent>
                    <TooltipTrigger asChild>
                      <Button
                        data-changelog-dismiss
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        aria-label={`Dismiss bb ${entry.version} changelog preview`}
                        onClick={() => {
                          rawStringLocalStorage.setItem(
                            CHANGELOG_DISMISSED_VERSION_STORAGE_KEY,
                            entry.version,
                          );
                          setDismissal({
                            phase: "confirming",
                            version: entry.version,
                          });
                        }}
                      >
                        <Icon aria-hidden name="X" className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Dismiss</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              {releaseMeta === undefined ? null : (
                <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    data-changelog-version={entry.version}
                    className="inline-flex rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-xs font-semibold leading-none tracking-tight text-foreground"
                  >
                    {entry.version}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {releaseMeta.date}
                  </span>
                </div>
              )}

              <div
                className={cn(
                  "relative min-w-0",
                  releaseMeta === undefined ? "mt-4" : "mt-3",
                )}
              >
                <div
                  ref={releaseBodyRef}
                  data-changelog-release-scroll
                  onScroll={(event) => syncFade(event.currentTarget)}
                  className="max-h-56 overflow-y-auto pr-3"
                >
                  <h3 className="text-lg font-semibold leading-snug tracking-tight text-foreground">
                    {releaseMeta?.headline ?? entry.version}
                  </h3>
                  {entry.lede.length === 0 ? null : (
                    <div className="mt-2">
                      <ChangelogBlocks blocks={entry.lede} lede />
                    </div>
                  )}
                  {entry.sections.map((section) => (
                    <div key={section.title} className="mt-4">
                      <h4 className="text-sm font-semibold leading-snug text-foreground">
                        {section.title}
                      </h4>
                      <ChangelogBlocks blocks={section.blocks} />
                    </div>
                  ))}
                </div>
                {moreBelow ? <OverflowFade placement="below" inset /> : null}
              </div>
            </article>
            <div
              data-changelog-footer
              className="flex items-center justify-end border-t border-foreground bg-foreground px-4 py-2.5 text-background sm:px-5"
            >
              <button
                type="button"
                disabled={!releaseVisible}
                aria-label={`Open the full bb ${entry.version} changelog`}
                onClick={() =>
                  openUrlInExternalBrowser(
                    `${CHANGELOG_URL}#${entry.version.replaceAll(".", "-")}`,
                  )
                }
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-xs font-semibold text-background underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-background"
              >
                Full changelog
                <Icon aria-hidden name="ExternalLink" className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
        <div
          data-changelog-dismiss-confirmation
          role="status"
          aria-live="polite"
          aria-hidden={releaseVisible}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            releaseVisible
              ? "pointer-events-none grid-rows-[0fr] opacity-0"
              : "grid-rows-[1fr] opacity-100",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="p-4 text-center sm:p-5">
              <div className="mx-auto max-w-sm">
                <div className="flex items-center justify-center gap-2">
                  <Icon
                    aria-hidden
                    name="CircleCheck"
                    className="size-4 text-muted-foreground"
                  />
                  <span className="inline-flex rounded-full border border-border bg-muted/30 px-2.5 py-1 font-mono text-xs font-semibold leading-none tracking-tight text-foreground">
                    {entry.version}
                  </span>
                </div>
                <h3 className="mt-3 text-lg font-semibold leading-snug tracking-tight text-foreground">
                  You're all caught up
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  We'll show the next bb release here.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface BbAppUpdateRowsProps {
  systemVersion: SystemVersionResponse | undefined;
  desktopInfo: BbDesktopInfo | null;
  isDesktop: boolean;
  onRelaunchDesktop: (() => void) | null;
  onRetryDesktop: (() => void) | null;
  isChecking?: boolean;
}

export function BbAppUpdateRows({
  systemVersion,
  desktopInfo,
  isDesktop,
  onRelaunchDesktop,
  onRetryDesktop,
  isChecking = false,
}: BbAppUpdateRowsProps) {
  const settledStatus = isChecking ? (
    <RowStateControl live state="in-progress" />
  ) : (
    <RowStateControl state="up-to-date" />
  );
  const row = (name: ReactNode, indicator: ReactNode, caption?: ReactNode) => (
    <UpdatesRow
      leading={
        <span data-bb-update-role="app" aria-hidden>
          <BbLogo className="size-4" />
        </span>
      }
    >
      <span className="flex min-w-0 items-baseline gap-2">
        {name}
        {caption}
      </span>
      <RowActions>{indicator}</RowActions>
    </UpdatesRow>
  );
  if (isDesktop && desktopInfo === null) {
    return row(
      <RowName name="bb app" current={null} latest={null} />,
      <RowStateControl live state="in-progress" />,
    );
  }

  if (desktopInfo !== null) {
    const pendingVersion =
      desktopInfo.pendingVersion ?? desktopInfo.latestVersion;
    const latest = desktopInfo.updateAvailable ? pendingVersion : null;
    const name = (
      <RowName name="bb app" current={desktopInfo.version} latest={latest} />
    );

    if (desktopInfo.updateDownloaded) {
      return row(
        name,
        <RowStateControl
          state="restart-required"
          buttonLeading={<BbLogo className="size-3" />}
          buttonLabel="Relaunch"
          actionLabel="Relaunch bb to finish updating"
          onClick={() => onRelaunchDesktop?.()}
        />,
      );
    }
    if (desktopInfo.downloadState === "downloading") {
      return row(name, <RowStateControl live state="in-progress" />);
    }
    if (desktopInfo.downloadState === "failed") {
      return row(
        name,
        <RowStateControl
          state="failed"
          buttonLabel="Retry"
          actionLabel="Retry the download"
          onClick={() => onRetryDesktop?.()}
        />,
        <RowStateCaption state="failed">Download failed</RowStateCaption>,
      );
    }
    if (desktopInfo.updateAvailable) {
      return row(name, <RowStateControl state="update-available" />);
    }
    return row(name, settledStatus);
  }

  if (systemVersion === undefined) {
    return row(
      <RowName name="bb app" current={null} latest={null} />,
      <RowStateControl state="in-progress" />,
    );
  }

  const name = (
    <RowName
      name="bb app"
      detail={
        systemVersion.updateAvailable ? (
          <span className="hidden truncate font-mono text-2xs text-muted-foreground sm:inline">
            {systemVersion.upgradeCommand}
          </span>
        ) : undefined
      }
      current={systemVersion.currentVersion}
      latest={
        systemVersion.updateAvailable ? systemVersion.latestVersion : null
      }
    />
  );

  if (systemVersion.updateAvailable) {
    return row(
      name,
      <RowStateControl
        state="update-available"
        actionIcon="Copy"
        actionLabel="Copy the upgrade command"
        actionTooltip="Copy command"
        onClick={() => {
          void copyToClipboardWithToast(systemVersion.upgradeCommand, {
            successMessage: "Upgrade command copied",
            errorMessage: "Couldn't copy upgrade command",
          });
        }}
      />,
    );
  }

  return row(name, settledStatus);
}

interface MachineUpdatesRowsProps {
  machine: UpdateInventoryMachine;
  runningJobKey: string | null;
  queuedJobKeys: ReadonlySet<string>;
  failuresByJobKey?: ReadonlyMap<string, ProviderCliInstallFailure>;
  onStartInstall: (hostId: string, issue: ProviderCliActionableIssue) => void;
  onOpenProvider: (providerId: string) => void;
}

function machineHasRelevantHealthStatus(
  machine: UpdateInventoryMachine,
): boolean {
  return (
    machine.statusError ||
    machine.canRetryDaemonUpdate ||
    machine.host.status !== "connected"
  );
}

function visibleProviderUpdateIssues(
  machine: UpdateInventoryMachine,
): ProviderCliIssue[] {
  if (
    machine.canRetryDaemonUpdate ||
    machine.host.status !== "connected" ||
    machine.statusError ||
    machine.statusPending ||
    machine.providerStatus === null
  ) {
    return [];
  }
  return machine.issues.filter(isProviderCliUpdateIssue);
}

function visibleInstalledProviderEntries(
  machine: UpdateInventoryMachine,
): ProviderCliStatusEntry[] {
  if (
    machine.canRetryDaemonUpdate ||
    machine.host.status !== "connected" ||
    machine.statusError ||
    machine.statusPending ||
    machine.providerStatus === null
  ) {
    return [];
  }
  return providerCliEntries(machine.providerStatus).filter(
    (entry) => entry.status.installed,
  );
}

export function BbDaemonUpdateRow({
  machine,
  now,
  retryUpdatePending,
  onRetryDaemonUpdate,
  onOpenMachine,
}: {
  machine: UpdateInventoryMachine;
  now: number;
  retryUpdatePending: boolean;
  onRetryDaemonUpdate: (hostId: string) => void;
  onOpenMachine: (hostId: string) => void;
}) {
  const { host } = machine;
  const updateStalled =
    machine.canRetryDaemonUpdate && hostUpdateIsStalled(host, now);
  const updating = machine.canRetryDaemonUpdate && !updateStalled;
  const machineIsAhead = hostNeedsUpdate(host) && !hostCanRetryUpdate(host);
  const offline = host.status !== "connected";

  const daemonCaption = updateStalled ? (
    <RowStateCaption state="failed">Update didn&apos;t finish</RowStateCaption>
  ) : machineIsAhead ? (
    <RowStateCaption state="offline">
      Update this app to reconnect
    </RowStateCaption>
  ) : null;

  return (
    <ResourceRow
      className={ROW_SPACING}
      actionsVisibility="always"
      openLabel={`Open ${host.name} settings`}
      onOpen={() => onOpenMachine(host.id)}
      leading={
        <span data-bb-update-role="daemon" aria-hidden>
          <BbLogo className="size-4" />
        </span>
      }
      title="bb daemon"
      state={daemonCaption}
      trailingMeta={null}
      actions={
        updating ? (
          <RowStateControl live state="in-progress" />
        ) : updateStalled ? (
          <RowStateControl
            state="failed"
            buttonLabel="Retry"
            actionLabel={`Retry on ${host.name} now`}
            loading={retryUpdatePending}
            onClick={() => onRetryDaemonUpdate(host.id)}
          />
        ) : machineIsAhead ? (
          <RowStateControl state="offline" />
        ) : offline ? (
          <RowStateControl state="offline" />
        ) : null
      }
    />
  );
}

export function ProviderCliCheckRow({
  machine,
  onRecheckClis,
  onOpenMachine,
}: {
  machine: UpdateInventoryMachine;
  onRecheckClis: (hostId: string) => void;
  onOpenMachine: (hostId: string) => void;
}) {
  const { host } = machine;
  return (
    <ResourceRow
      className={ROW_SPACING}
      actionsVisibility="always"
      openLabel={`Open ${host.name} settings`}
      onOpen={() => onOpenMachine(host.id)}
      leading={
        <Icon
          aria-hidden
          name="Terminal"
          className="size-3.5 text-muted-foreground"
        />
      }
      title="Provider CLIs"
      state={
        <RowStateCaption state="failed">
          Couldn&apos;t check for updates
        </RowStateCaption>
      }
      trailingMeta={null}
      actions={
        <RowStateControl
          state="failed"
          buttonLabel="Retry"
          actionLabel={`Check ${host.name}'s CLIs again`}
          loading={machine.statusFetching}
          onClick={() => onRecheckClis(host.id)}
        />
      }
    />
  );
}

function providerRowState({
  issue,
}: {
  issue: ProviderCliIssue | null;
}): UpdateState | null {
  if (issue === null) {
    return "up-to-date";
  }
  if (issue.action === null) {
    return "update-manually";
  }
  return "update-available";
}

export function MachineUpdatesRows({
  machine,
  runningJobKey,
  queuedJobKeys,
  failuresByJobKey = EMPTY_PROVIDER_CLI_FAILURES,
  onStartInstall,
  onOpenProvider,
}: MachineUpdatesRowsProps) {
  const { host } = machine;
  const providerRoster = useSystemProviders().data;
  const providerEntries = visibleInstalledProviderEntries(machine);
  const issuesByProvider = new Map(
    visibleProviderUpdateIssues(machine).map((issue) => [
      issue.provider,
      issue,
    ]),
  );

  if (providerEntries.length === 0) {
    return null;
  }

  const rows = providerEntries.map(({ provider, status }) => {
    const issue = issuesByProvider.get(provider) ?? null;
    const state = providerRowState({ issue });
    const jobKey = providerCliJobKey(host.id, provider);
    const running = runningJobKey === jobKey;
    const queued = queuedJobKeys.has(jobKey);
    const storedFailure = failuresByJobKey.get(jobKey) ?? null;
    const failure =
      issue !== null && storedFailure?.issueFingerprint === issue.fingerprint
        ? storedFailure
        : null;
    const actionable =
      issue !== null && hasProviderCliAction(issue) && !running && !queued;
    const providerId = provider;
    const providerInfo = providerRoster?.find(
      (candidate) => candidate.id === providerId,
    );
    const ProviderIcon = getProviderIconInfo(
      providerId,
      providerInfo ?? null,
    )?.icon;
    return (
      <ResourceRow
        key={provider}
        className={ROW_SPACING}
        actionsVisibility="always"
        openLabel={`Open ${status.displayName} settings`}
        onOpen={() => onOpenProvider(providerId)}
        leading={
          ProviderIcon === undefined ? null : (
            <span
              data-provider-icon={providerId}
              aria-hidden
              className="flex size-3.5 shrink-0 items-center justify-center"
            >
              <ProviderIcon className="size-3.5 text-muted-foreground" />
            </span>
          )
        }
        title={status.displayName}
        titleMeta={
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <RowVersions
              current={status.currentVersion}
              latest={issue !== null ? status.latestVersion : null}
            />
            {failure === null ? null : (
              <>
                <RowStateCaption state="failed">Failed</RowStateCaption>
                <code
                  role="alert"
                  className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs text-destructive"
                >
                  {failure.logDialogState.message}
                </code>
              </>
            )}
          </span>
        }
        trailingMeta={null}
        actions={
          running ? (
            <RowStateControl live state="in-progress" />
          ) : queued ? (
            <RowStateControl live state="in-progress" />
          ) : failure !== null ? (
            <span className="flex items-center gap-1">
              <UpdateActionButton
                label={`View ${status.displayName} update log`}
                tooltipLabel="View log"
                icon="File"
                onClick={() =>
                  openProviderCliInstallLog(failure.logDialogState)
                }
              />
              {actionable ? (
                <RowStateControl
                  state="failed"
                  actionLabel={`Retry ${status.displayName} on ${host.name}`}
                  actionTooltip="Retry"
                  onClick={() => onStartInstall(host.id, issue)}
                />
              ) : null}
            </span>
          ) : state === null ? null : (
            <RowStateControl
              state={state}
              actionLabel={
                actionable
                  ? `${issue.action.label} ${status.displayName} on ${host.name}`
                  : undefined
              }
              actionTooltip={actionable ? issue.action.label : undefined}
              onClick={
                actionable ? () => onStartInstall(host.id, issue) : undefined
              }
            />
          )
        }
      />
    );
  });

  return <>{rows}</>;
}

export function MachineUpdatesSection({
  machine,
  isThisMachine,
  children,
}: {
  machine: UpdateInventoryMachine;
  isThisMachine: boolean;
  children: ReactNode;
}) {
  return (
    <div data-updates-machine={machine.host.id}>
      <div data-updates-domain="machine">
        <SettingsSection
          title={
            <span className="flex min-w-0 items-center gap-2">
              <Icon
                name="Laptop"
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{machine.host.name}</span>
              {isThisMachine ? (
                <SettingsBadge>This machine</SettingsBadge>
              ) : null}
            </span>
          }
        >
          <SettingsRowList>{children}</SettingsRowList>
        </SettingsSection>
      </div>
    </div>
  );
}

export function MachineUpdatesFleetSection({
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsSection
      action={action}
      bodyClassName="border-0 bg-transparent p-0"
      description="Manage bb and provider CLI updates across all machines."
      title="Machine updates"
    >
      <div className="space-y-6 pt-1.5">{children}</div>
    </SettingsSection>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface UpdatesSettingsSectionProps {
  showChangelogPreview?: boolean;
}

export function UpdatesSettingsSection({
  showChangelogPreview = false,
}: UpdatesSettingsSectionProps = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inventory = useUpdateInventory();
  const { localDaemonHostId } = useHostDaemon();
  const { desktopApi, desktopInfo, isDesktop } = useDesktopUpdateInfo();
  const retryHostUpdate = useRetryHostUpdate();
  const isChecking = useSyncExternalStore(
    subscribeAppUpdateCheck,
    getAppUpdateCheckSnapshot,
  );
  const now = useNow(30_000);
  const { failuresByJobKey, queuedJobKeys, runningJobKey, startInstall } =
    useProviderCliInstallRunner();

  const visibleProviderIssues: {
    hostId: string;
    issue: ProviderCliIssue;
  }[] = inventory.machines.flatMap((machine) =>
    visibleProviderUpdateIssues(machine).map((issue) => ({
      hostId: machine.host.id,
      issue,
    })),
  );
  const actionableIssues = visibleProviderIssues
    .filter(
      (
        entry,
      ): entry is {
        hostId: string;
        issue: ProviderCliActionableIssue;
      } => hasProviderCliAction(entry.issue),
    )
    .filter(({ hostId, issue }) => {
      const jobKey = providerCliJobKey(hostId, issue.provider);
      return runningJobKey !== jobKey && !queuedJobKeys.has(jobKey);
    });

  const connectedHostIds = inventory.machines
    .filter((machine) => machine.host.status === "connected")
    .map((machine) => machine.host.id);

  function handleCheckForUpdates(): void {
    startAppUpdateCheck(async () => {
      if (desktopApi !== null) {
        await desktopApi.checkForUpdates();
      } else {
        const version = await sdk.system.version({ force: true });
        hydrateSystemVersionCache({ queryClient, version });
      }
      await Promise.all(
        connectedHostIds.map((hostId) =>
          invalidateHostProviderCliStatus({ queryClient, hostId }),
        ),
      );
    });
  }

  const hostsSettled = !inventory.isLoading;
  const checkedOnLoad = useRef(false);
  useEffect(() => {
    if (checkedOnLoad.current || !hostsSettled) {
      return;
    }
    checkedOnLoad.current = true;
    handleCheckForUpdates();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [hostsSettled]);

  const appUpdateVisible =
    desktopInfo?.updateAvailable === true ||
    inventory.systemVersion?.updateAvailable === true ||
    inventory.appUpdateAvailable;
  const relevantFleetMachines = inventory.machines.filter(
    machineHasRelevantHealthStatus,
  );
  const stalledMachines = relevantFleetMachines.filter(
    (machine) =>
      machine.canRetryDaemonUpdate && hostUpdateIsStalled(machine.host, now),
  );
  const appMachine =
    inventory.machines.find((machine) => machine.isPrimary) ??
    inventory.machines[0] ??
    null;
  const visibleMachines = inventory.machines.filter(
    (machine) =>
      machine.host.id === appMachine?.host.id ||
      machineHasRelevantHealthStatus(machine) ||
      visibleInstalledProviderEntries(machine).length > 0,
  );
  const hasUpdateWork =
    appUpdateVisible ||
    visibleProviderIssues.length > 0 ||
    stalledMachines.length > 0;
  const fleetIsHealthy = relevantFleetMachines.length === 0;
  const showFallbackBbStatus =
    !hasUpdateWork && !fleetIsHealthy && isDesktop && desktopInfo === null;

  function retryDaemonUpdate(hostId: string): void {
    retryHostUpdate.mutate(hostId, {
      onSuccess: () => {
        const machine = inventory.machines.find(
          (candidate) => candidate.host.id === hostId,
        );
        appToast.success(
          `Retrying the update on ${machine?.host.name ?? "the requested machine"}`,
        );
      },
    });
  }

  function retryAllStalledDaemonUpdates(): void {
    for (const machine of stalledMachines) {
      retryHostUpdate.mutate(machine.host.id);
    }
    appToast.success(
      `Retrying the update on ${stalledMachines.length} machines`,
    );
  }

  const updateAllButton =
    actionableIssues.length > 1 ? (
      <UpdateActionButton
        label={`Update all ${actionableIssues.length} CLI tools`}
        tooltipLabel="Update all"
        icon={UPDATE_ACTION_ICON}
        visibleLabel="Update all"
        variant="default"
        onClick={() => {
          for (const { hostId, issue } of actionableIssues) {
            startInstall({ hostId, issue });
          }
        }}
      />
    ) : null;
  const retryAllButton =
    stalledMachines.length > BULK_RETRY_THRESHOLD ? (
      <UpdateActionButton
        label={`Update all ${stalledMachines.length} machines now`}
        visibleLabel="Retry all"
        icon="RotateCcw"
        iconPosition="end"
        variant="default"
        className="font-medium"
        onClick={retryAllStalledDaemonUpdates}
      />
    ) : null;
  const bulkActions =
    retryAllButton !== null || updateAllButton !== null ? (
      <div
        role="toolbar"
        aria-label="Bulk update actions"
        className="flex flex-wrap items-center justify-end gap-2"
      >
        {retryAllButton}
        {updateAllButton}
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {showChangelogPreview ? <ChangelogPreviewCard /> : null}

      <MachineUpdatesFleetSection action={bulkActions}>
        {visibleMachines.length === 0 ? (
          <ResourceListState state="empty" message="No machines available." />
        ) : (
          visibleMachines.map((machine) => {
            const ownsApp = machine.host.id === appMachine?.host.id;
            const showDaemon =
              machine.canRetryDaemonUpdate ||
              machine.host.status !== "connected";
            return (
              <MachineUpdatesSection
                key={machine.host.id}
                machine={machine}
                isThisMachine={
                  inventory.machines.length > 1 &&
                  machine.host.id === localDaemonHostId
                }
              >
                {ownsApp ? (
                  <BbAppUpdateRows
                    systemVersion={inventory.systemVersion}
                    desktopInfo={desktopInfo}
                    isDesktop={isDesktop}
                    isChecking={isChecking}
                    onRelaunchDesktop={
                      desktopApi === null || showFallbackBbStatus
                        ? null
                        : () => {
                            void desktopApi.installUpdate().catch((error) => {
                              appToast.error("Relaunch failed", {
                                description: checkErrorDescription(error),
                              });
                            });
                          }
                    }
                    onRetryDesktop={
                      desktopApi === null || showFallbackBbStatus
                        ? null
                        : () => {
                            void desktopApi.checkForUpdates().catch((error) => {
                              appToast.error("Update retry failed", {
                                description: checkErrorDescription(error),
                              });
                            });
                          }
                    }
                  />
                ) : null}
                {showDaemon ? (
                  <BbDaemonUpdateRow
                    machine={machine}
                    now={now}
                    retryUpdatePending={
                      retryHostUpdate.isPending &&
                      retryHostUpdate.variables === machine.host.id
                    }
                    onRetryDaemonUpdate={retryDaemonUpdate}
                    onOpenMachine={(hostId) =>
                      navigate(getSettingsMachineRoutePath(hostId))
                    }
                  />
                ) : null}
                {machine.statusError ? (
                  <ProviderCliCheckRow
                    machine={machine}
                    onRecheckClis={(hostId) => {
                      void invalidateHostProviderCliStatus({
                        queryClient,
                        hostId,
                      });
                    }}
                    onOpenMachine={(hostId) =>
                      navigate(getSettingsMachineRoutePath(hostId))
                    }
                  />
                ) : null}
                <MachineUpdatesRows
                  machine={machine}
                  runningJobKey={runningJobKey}
                  queuedJobKeys={queuedJobKeys}
                  failuresByJobKey={failuresByJobKey}
                  onStartInstall={(hostId, issue) =>
                    startInstall({ hostId, issue })
                  }
                  onOpenProvider={() =>
                    navigate(getSettingsRoutePath("providers"))
                  }
                />
              </MachineUpdatesSection>
            );
          })
        )}
      </MachineUpdatesFleetSection>
    </div>
  );
}
