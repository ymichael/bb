import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginMarketplace } from "@bb/server-contract";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { SettingsSection } from "@/components/ui/settings-section";
import { appToast } from "@/components/ui/app-toast";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/dialogs/ConfirmDeleteDialog";
import { pluginAdminErrorMessage } from "@/lib/plugin-admin-error";
import { invalidatePluginMarketplaces } from "@/hooks/cache-owners/plugin-cache-owner";
import {
  addPluginMarketplace,
  refreshPluginMarketplaces,
  removePluginMarketplace,
  usePluginMarketplaces,
} from "@/hooks/queries/plugin-catalog-queries";

const SOURCE_PLACEHOLDER = "https://example.com/marketplace.json";

function formatRefreshedAt(marketplace: PluginMarketplace): string {
  if (marketplace.lastError !== null) {
    return `Last refresh failed: ${marketplace.lastError}`;
  }
  if (marketplace.lastRefreshAt === null) return "Never refreshed";
  return `Refreshed ${new Date(marketplace.lastRefreshAt).toLocaleString()}`;
}

export function MarketplacesSettingsSection() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [removing, setRemoving] = useState<PluginMarketplace | null>(null);
  const marketplacesQuery = usePluginMarketplaces({ enabled: true });
  const marketplaces = marketplacesQuery.data ?? [];

  const invalidate = () => invalidatePluginMarketplaces({ queryClient });

  const add = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (value: string) => addPluginMarketplace(fetch, value),
    onSuccess: (marketplace) => {
      setSource("");
      invalidate();
      appToast.success(`Added ${marketplace.displayName}`, {
        description: `${marketplace.entryCount} plugins listed. Adding a marketplace installs nothing.`,
      });
    },
    onError: (error) => {
      appToast.error("Adding the marketplace failed", {
        description: pluginAdminErrorMessage(error),
      });
    },
  });

  const refresh = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (name: string) => refreshPluginMarketplaces(fetch, name),
    onSuccess: (results) => {
      invalidate();
      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) {
        appToast.success("Marketplace refreshed");
        return;
      }
      appToast.error("Refreshing the marketplace failed", {
        description: `${failed[0]?.error ?? "Unknown error"}. The last catalog bb validated is still in use.`,
      });
    },
    onError: (error) => {
      appToast.error("Refreshing the marketplace failed", {
        description: pluginAdminErrorMessage(error),
      });
    },
  });

  const remove = useMutation({
    meta: { showErrorToast: false },
    mutationFn: (name: string) => removePluginMarketplace(fetch, name),
    onSuccess: (result) => {
      setRemoving(null);
      invalidate();
      appToast.success("Marketplace removed", {
        description:
          result.convertedPluginIds.length === 0
            ? undefined
            : `Kept as direct installs: ${result.convertedPluginIds.join(", ")}`,
      });
    },
    onError: (error) => {
      appToast.error("Removing the marketplace failed", {
        description: pluginAdminErrorMessage(error),
      });
    },
  });

  return (
    <SettingsSection
      title="Plugin marketplaces"
      description="bb reads plugin catalogs from these marketplaces. Adding one validates and caches its catalog; it never installs, updates, or runs plugin code."
    >
      <div className="space-y-1.5">
        <div className="flex items-start gap-2">
          <Input
            value={source}
            aria-label="Marketplace source"
            placeholder={SOURCE_PLACEHOLDER}
            className="h-8 font-mono text-xs"
            onChange={(event) => setSource(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={source.trim().length === 0 || add.isPending}
            onClick={() => add.mutate(source.trim())}
          >
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        <p className="text-2xs text-subtle-foreground">
          An https manifest URL, <code>git:&lt;url&gt;[@&lt;ref&gt;]</code>, or{" "}
          <code>path:&lt;directory&gt;</code> on the bb server&rsquo;s machine.
        </p>
      </div>

      <ul className="space-y-2 pt-1">
        {marketplaces.map((marketplace) => (
          <li
            key={marketplace.name}
            className="flex items-start gap-3 rounded-md border border-border p-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex items-center gap-2 text-sm text-foreground">
                {marketplace.displayName}
                <span className="font-mono text-2xs text-subtle-foreground">
                  {marketplace.name}
                </span>
                {marketplace.official ? (
                  <Badge variant="outline" className="text-2xs font-normal">
                    Official
                  </Badge>
                ) : null}
              </p>
              <p className="truncate font-mono text-2xs text-subtle-foreground">
                {marketplace.source}
              </p>
              <p className="text-2xs text-subtle-foreground">
                {marketplace.entryCount} plugins ·{" "}
                {formatRefreshedAt(marketplace)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refresh.isPending}
                aria-label={`Refresh ${marketplace.displayName}`}
                onClick={() => refresh.mutate(marketplace.name)}
              >
                Refresh
              </Button>
              {marketplace.official ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Remove ${marketplace.displayName}`}
                  onClick={() => setRemoving(marketplace)}
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDeleteDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <ConfirmDeleteDialogContent
          title={`Remove ${removing?.displayName ?? "marketplace"}?`}
          description="Its catalog and cached icons are deleted. Plugins installed from it keep running as direct installs and keep checking for updates from their recorded source."
          confirmLabel={remove.isPending ? "Removing…" : "Remove"}
          pending={remove.isPending}
          onConfirm={() => {
            if (removing !== null) remove.mutate(removing.name);
          }}
          onCancel={() => setRemoving(null)}
        />
      </ConfirmDeleteDialog>
    </SettingsSection>
  );
}
