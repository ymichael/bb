import { useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceIconFrame } from "@bb/shared-ui/resource-list";
import {
  PluginCompactIconMask,
  PluginIcon,
  pluginIconName,
} from "@/components/plugin/PluginIcon";
import { usePreferredTheme } from "@/hooks/useTheme";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

export const UPDATE_ICON_STYLE = {
  color: "color-mix(in oklab, var(--success) 72%, var(--ink))",
} as const;

export function isReadablePluginVersion(version: string): boolean {
  return /^v?\d+\.\d+/u.test(version);
}

export function displayPluginVersion(version: string): string {
  return /^[0-9a-f]{12,}$/iu.test(version) ? version.slice(0, 7) : version;
}

export const SUCCESS_TEXT_STYLE = {
  color: "color-mix(in oklab, var(--success) 80%, var(--ink))",
} as const;

const PLUGIN_INSTALL_COUNT_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatPluginInstallCount(installs: number): string {
  return PLUGIN_INSTALL_COUNT_FORMATTER.format(installs);
}

const PLUGIN_CATEGORY_ACCENT_TOKENS: Record<string, string> = {
  "themes-and-appearance": "--file-accent",
  "thread-management": "--file-accent",
  "thread-content": "--file-accent",
  "memory-and-context": "--success",
  security: "--warning",
  "agents-and-providers": "--success",
  "token-usage-and-limits": "--warning",
  notifications: "--warning",
  "code-and-reviews": "--pr-merged",
  "file-viewers-and-editors": "--pr-merged",
  "cloud-and-remote": "--attention",
  "command-line": "--attention",
  utilities: "--attention",
  "plugin-development": "--pr-merged",
  "tasks-and-workflows": "--success",
};

function neutral(percent: number): string {
  return `color-mix(in oklch, var(--ink) ${percent}%, var(--canvas))`;
}

function accentTint(token: string, percent: number): string {
  return `color-mix(in oklch, var(${token}) ${percent}%, var(--canvas))`;
}

function accentInk(token: string, percent: number): string {
  return `color-mix(in oklch, var(${token}) ${percent}%, var(--ink))`;
}

function pluginCatalogCategoryAccentToken(
  categoryId: string | undefined,
): string | undefined {
  return categoryId === undefined
    ? undefined
    : PLUGIN_CATEGORY_ACCENT_TOKENS[categoryId];
}

export function pluginCatalogCategoryPillStyle(
  categoryId: string | undefined,
): CSSProperties {
  const accentToken = pluginCatalogCategoryAccentToken(categoryId);
  return accentToken === undefined
    ? {
        background: neutral(8),
        borderColor: neutral(16),
        color: neutral(55),
      }
    : {
        background: accentTint(accentToken, 16),
        borderColor: accentTint(accentToken, 24),
        color: accentInk(accentToken, 52),
      };
}

export function pluginCatalogCategoryMutedAccentStyle(
  categoryId: string | undefined,
): CSSProperties {
  const accentToken = pluginCatalogCategoryAccentToken(categoryId);
  return {
    background:
      accentToken === undefined ? neutral(36) : accentTint(accentToken, 55),
  };
}

export function PluginLogo({
  plugin,
  className,
}: {
  plugin: PluginListItem;
  className: string;
}) {
  const theme = usePreferredTheme();
  const logoUrl =
    theme === "dark" && plugin.logoDarkUrl !== null
      ? plugin.logoDarkUrl
      : plugin.logoUrl;
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  if (logoUrl === null || logoUrl === failedLogoUrl) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "grid shrink-0 place-items-center text-muted-foreground",
          className,
        )}
      >
        <PluginIcon
          pluginId={plugin.id}
          icon={plugin.icon}
          compactIconUrl={plugin.compactIconUrl}
          className="size-full"
        />
      </span>
    );
  }
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      data-testid={`plugin-settings-logo-${plugin.id}`}
      className={cn("rounded-sm object-contain", className)}
      onError={() => setFailedLogoUrl(logoUrl)}
    />
  );
}

export function CatalogEntryIcon({
  entry,
  className,
}: {
  entry: {
    displayName: string;
    icon: string | null;
    iconUrl: string | null;
    iconTinted: boolean;
  };
  className: string;
}) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      data-catalog-entry-icon-glyph=""
      className={cn("grid shrink-0 place-items-center", className)}
    >
      {entry.iconUrl !== null && entry.iconTinted ? (
        <PluginCompactIconMask url={entry.iconUrl} className="size-full" />
      ) : entry.iconUrl === null || entry.iconUrl === failedIconUrl ? (
        <Icon name={pluginIconName(entry.icon)} className="size-full" />
      ) : (
        <img
          src={entry.iconUrl}
          alt=""
          className="size-full rounded-sm object-contain"
          onError={() => setFailedIconUrl(entry.iconUrl)}
        />
      )}
    </span>
  );
}

export function PluginCategoryLabel({
  categoryId,
  label,
}: {
  categoryId: string | undefined;
  label: string;
}) {
  return (
    <span
      className="shrink-0 truncate rounded border px-2 py-1 text-2xs leading-none"
      style={pluginCatalogCategoryPillStyle(categoryId)}
    >
      {label}
    </span>
  );
}

export function CatalogEntryIconChip({
  entry,
  className,
}: {
  entry: {
    displayName: string;
    icon: string | null;
    iconUrl: string | null;
    iconTinted: boolean;
  };
  className?: string;
}) {
  return (
    <ResourceIconFrame
      className={cn("size-10 rounded-md border", className)}
      style={{
        background: neutral(5),
        borderColor: neutral(14),
        color: neutral(55),
      }}
    >
      {() => <CatalogEntryIcon entry={entry} className="size-6" />}
    </ResourceIconFrame>
  );
}

export function formatAbsoluteDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface DetailsDisclosureProps {
  summary: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
}

export function DetailsDisclosure({
  summary,
  children,
  defaultExpanded = false,
  className,
}: DetailsDisclosureProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border-seam text-xs",
        className,
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 bg-muted/40 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <Icon
          name="ChevronDown"
          className={cn("size-3.5 shrink-0", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div className="border-t border-border-seam px-3 py-2.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function KeyValueGrid({
  entries,
}: {
  entries: { key: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      {entries.map((entry) => (
        <div key={entry.key} className="contents">
          <dt className="text-muted-foreground">{entry.key}</dt>
          <dd className="min-w-0 break-words text-foreground font-mono">
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function FullTrustWarning() {
  return (
    <p
      className="flex items-start gap-1.5 text-2xs leading-snug text-subtle-foreground"
      data-testid="full-trust-warning"
    >
      <Icon name="Lock" className="mt-0.5 size-3 shrink-0" />
      <span>
        Plugins run as full-trust code with access to your computer. Only
        install from sources you trust.
      </span>
    </p>
  );
}

export function RollbackNote({
  fromVersion,
  toVersion,
}: {
  fromVersion: string;
  toVersion: string;
}) {
  return (
    <div
      className="flex gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground"
      data-testid="rollback-note"
    >
      <Icon name="RotateCcw" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Your plugin data is snapshotted first — if {toVersion} fails to start,
        bb restores {fromVersion} and its data automatically.
      </span>
    </div>
  );
}
