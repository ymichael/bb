import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CURATED_PLUGIN_MARKETPLACE_NAME,
  type InstalledPlugin,
  type PluginCatalogInstallPlan,
  type PluginCatalogResolvedSource,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { appToast } from "@/components/ui/app-toast.js";
import { pluginToast } from "@/components/plugin/PluginNotificationDescription";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import {
  applyInstalledPlugin,
  invalidatePluginCatalogSearch,
  invalidatePluginList,
} from "@/hooks/cache-owners/plugin-cache-owner";
import {
  installCatalogPlugin,
  installPlugin,
  useCatalogInstallPlan,
} from "@/hooks/queries/plugin-catalog-queries";
import { CatalogEntryIcon, FullTrustWarning } from "./plugin-ui";

export type AddPluginInitial = {
  entryId: string;
  marketplace: string;
  pluginId: string;
  publisherLabel: string;
  displayName: string;
  icon: string | null;
  iconUrl: string | null;
  iconTinted: boolean;
  source: string;
};

function catalogInstallDescription(
  source: string,
  publisherLabel: string,
): string {
  if (source.startsWith("builtin:")) {
    return "Install this plugin, bundled with BB.";
  }
  if (source.startsWith("npm:")) {
    return `Install this ${publisherLabel} plugin from its listed npm package.`;
  }
  return `Install this ${publisherLabel} plugin from its listed source repository.`;
}

interface AddPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (plugin: InstalledPlugin) => void;
  initial?: AddPluginInitial | null;
}

export function AddPluginDialog({
  open,
  onOpenChange,
  onInstalled,
  initial,
}: AddPluginDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <AddPluginDialogContent
            initial={initial ?? null}
            onOpenChange={onOpenChange}
            onInstalled={onInstalled}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function buildRequest(
  initial: AddPluginInitial | null,
  sourceText: string,
):
  | { kind: "catalog"; entryId: string; marketplace: string }
  | { kind: "direct"; source: string }
  | null {
  if (initial !== null) {
    return {
      kind: "catalog",
      entryId: initial.entryId,
      marketplace: initial.marketplace,
    };
  }
  const trimmed = sourceText.trim();
  return trimmed.length === 0 ? null : { kind: "direct", source: trimmed };
}

function resolvedSourceRows(
  source: PluginCatalogResolvedSource,
): { label: string; value: string; href?: string }[] {
  if (source.kind === "npm") {
    return [
      {
        label: "npm package",
        value: `${source.package}@${source.range ?? source.tag ?? "latest"}`,
      },
      ...(source.registry === undefined
        ? []
        : [{ label: "registry", value: source.registry }]),
    ];
  }
  return [
    { label: "repository", value: source.url, href: source.url },
    ...(source.subdir === undefined
      ? []
      : [{ label: "subdirectory", value: source.subdir }]),
    ...(source.ref === undefined ? [] : [{ label: "ref", value: source.ref }]),
    ...(source.range === undefined
      ? []
      : [
          {
            label: "semver range",
            value:
              source.tagPrefix === undefined
                ? source.range
                : `${source.range} (tags ${source.tagPrefix}vX.Y.Z)`,
          },
        ]),
    ...(source.resolvedTag === undefined
      ? []
      : [{ label: "resolves to tag", value: source.resolvedTag }]),
    ...(source.resolvedCommit === undefined
      ? []
      : [{ label: "resolves to commit", value: source.resolvedCommit }]),
    ...(source.unresolvedReason === undefined
      ? []
      : [{ label: "not resolved", value: source.unresolvedReason }]),
  ];
}

function ThirdPartySourceDisclosure({
  plan,
  pending,
  error,
}: {
  plan: PluginCatalogInstallPlan | undefined;
  pending: boolean;
  error: unknown;
}) {
  if (pending) {
    return (
      <p className="text-2xs text-subtle-foreground" role="status">
        Resolving the listed source…
      </p>
    );
  }
  if (error !== null && error !== undefined) {
    return (
      <p className="text-2xs text-warning-text" role="status">
        Could not resolve this listing&rsquo;s source:{" "}
        {pluginAdminErrorMessage(error)}
      </p>
    );
  }
  if (plan === undefined || plan.kind !== "marketplace" || plan.official) {
    return null;
  }
  const author =
    plan.author.url === null ? null : (
      <a
        href={plan.author.url}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2"
      >
        {plan.author.name}
      </a>
    );
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-2xs text-subtle-foreground">
        Listed by{" "}
        <span className="text-foreground">{plan.marketplaceDisplayName}</span>,
        a third-party marketplace that BB does not review.
      </p>
      <dl className="space-y-0.5">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-2xs text-subtle-foreground">
            author
          </dt>
          <dd className="min-w-0 break-all font-mono text-2xs text-foreground">
            {author ?? plan.author.name}
          </dd>
        </div>
        {resolvedSourceRows(plan.resolvedSource).map((row) => (
          <div key={row.label} className="flex gap-2">
            <dt className="w-28 shrink-0 text-2xs text-subtle-foreground">
              {row.label}
            </dt>
            <dd className="min-w-0 break-all font-mono text-2xs text-foreground">
              {row.href === undefined ? (
                row.value
              ) : (
                <a
                  href={row.href}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {row.value}
                </a>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function AddPluginDialogContent({
  initial,
  onOpenChange,
  onInstalled,
}: {
  initial: AddPluginInitial | null;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (plugin: InstalledPlugin) => void;
}) {
  const queryClient = useQueryClient();
  const [sourceText, setSourceText] = useState("");
  const request = buildRequest(initial, sourceText);
  const thirdParty =
    initial !== null &&
    initial.marketplace !== CURATED_PLUGIN_MARKETPLACE_NAME &&
    !initial.source.startsWith("builtin:");
  const planQuery = useCatalogInstallPlan(
    thirdParty && initial !== null
      ? { entryId: initial.entryId, marketplace: initial.marketplace }
      : null,
  );
  const plan = planQuery.data;

  const install = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (body: NonNullable<typeof request>) =>
      body.kind === "catalog"
        ? installCatalogPlugin(fetch, {
            entryId: body.entryId,
            marketplace: body.marketplace,
            ...(thirdParty && plan?.kind === "marketplace"
              ? { confirmedSource: plan.resolvedSource }
              : {}),
          })
        : installPlugin(fetch, body.source),
    onSuccess: (plugin) => {
      applyInstalledPlugin({ queryClient, plugin });
      invalidatePluginList({ queryClient });
      invalidatePluginCatalogSearch({ queryClient });
      pluginToast.success("Plugin installed", plugin, "installed");
      onOpenChange(false);
      onInstalled?.(plugin);
    },
    onError: (error) => {
      const detail = pluginAdminErrorMessage(error);
      if (initial === null) {
        appToast.error("Plugin installation failed", { description: detail });
        return;
      }
      pluginToast.error(
        "Plugin installation failed",
        { id: initial.pluginId, name: initial.displayName },
        "catalog",
        detail,
      );
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {initial !== null ? `Install ${initial.displayName}?` : "Add plugin"}
        </DialogTitle>
        <DialogDescription>
          {initial === null
            ? "Install from npm, a Git repository, or a local path."
            : thirdParty
              ? "Install this plugin from the source its marketplace lists."
              : catalogInstallDescription(
                  initial.source,
                  initial.publisherLabel,
                )}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {initial !== null ? (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2.5">
              <CatalogEntryIcon entry={initial} className="size-6" />
              <span className="text-sm font-medium text-foreground">
                {initial.displayName}
              </span>
              <span className="ml-auto font-mono text-xs text-subtle-foreground">
                {initial.entryId}
              </span>
            </div>
            {}
            <p className="overflow-x-auto whitespace-nowrap font-mono text-2xs text-subtle-foreground">
              {initial.source}
            </p>
          </div>
        ) : (
          <div>
            <Input
              value={sourceText}
              autoFocus
              placeholder="https://github.com/owner/bb-plugin-name"
              aria-label="Plugin source"
              className="h-8 font-mono text-xs"
              onChange={(event) => setSourceText(event.target.value)}
            />
            <p className="mt-1.5 text-2xs text-subtle-foreground">
              GitHub repository URL · npm:package[@version] · ./local/path
            </p>
          </div>
        )}

        {thirdParty ? (
          <ThirdPartySourceDisclosure
            plan={plan}
            pending={planQuery.isPending}
            error={planQuery.error}
          />
        ) : null}

        {install.isPending ? (
          <div
            className="h-0.5 overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label="Installing plugin"
          >
            <div className="h-full w-1/3 animate-indeterminate-progress rounded-full bg-muted-foreground" />
          </div>
        ) : (
          <FullTrustWarning />
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            request === null ||
            install.isPending ||
            (thirdParty && planQuery.isPending) ||
            (thirdParty && plan === undefined)
          }
          aria-busy={install.isPending}
          onClick={() => {
            if (request !== null) install.mutate(request);
          }}
        >
          {install.isPending ? (
            <Icon name="Spinner" className="animate-spin" />
          ) : null}
          {install.isPending
            ? `Installing ${initial?.displayName ?? "plugin"}…`
            : `Install ${initial?.displayName ?? "plugin"}`}
        </Button>
      </DialogFooter>
    </>
  );
}
