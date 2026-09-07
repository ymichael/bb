import { resolve } from "node:path";
import { Command } from "commander";
import type { PluginMarketplace } from "@bb/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

function normalizeSource(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith("path:")
    ? `path:${resolve(trimmed.slice("path:".length))}`
    : trimmed;
}

function formatTimestamp(value: number | null): string {
  if (value === null) return "never";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function printMarketplace(marketplace: PluginMarketplace): void {
  console.log(`${marketplace.name}  ${marketplace.displayName}`);
  console.log(`  source: ${marketplace.source}`);
  if (marketplace.resolvedCommit !== null) {
    console.log(`  commit: ${marketplace.resolvedCommit}`);
  }
  console.log(`  entries: ${marketplace.entryCount}`);
  console.log(`  refreshed: ${formatTimestamp(marketplace.lastRefreshAt)}`);
  if (marketplace.lastError !== null) {
    console.log(`  last error: ${marketplace.lastError}`);
  }
}

export function registerMarketplaceCommands(
  program: Command,
  getUrl: () => string,
): void {
  const marketplace = program
    .command("marketplace")
    .description("Manage the plugin marketplaces bb reads catalogs from");

  marketplace
    .command("add <source>")
    .description(
      "Add a marketplace from an https manifest URL, git:<url>[@<ref>], or path:<directory> (validates and caches the catalog; installs nothing)",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (source: string, opts: JsonOutputOptions) => {
        const added = await createCliBbSdk(getUrl()).plugins.marketplaces.add({
          source: normalizeSource(source),
        });
        if (opts.json) {
          outputJson(opts, added);
          return;
        }
        console.log(`Added marketplace ${added.name}:`);
        printMarketplace(added);
        console.log(
          `Adding a marketplace installs nothing. Install an entry with \`bb plugin install <id>@${added.name}\`.`,
        );
      }),
    );

  marketplace
    .command("list")
    .description("List the marketplaces bb reads catalogs from")
    .option("--json", "Output JSON")
    .action(
      action(async (opts: JsonOutputOptions) => {
        const marketplaces =
          await createCliBbSdk(getUrl()).plugins.marketplaces.list();
        if (opts.json) {
          outputJson(opts, marketplaces);
          return;
        }
        console.log(
          renderBorderlessTable(
            {
              head: ["Name", "Source", "Entries", "Refreshed"],
              colWidths: [24, 58, 9, 26],
              trimTrailingWhitespace: true,
            },
            marketplaces.map((entry) => [
              entry.official ? `${entry.name} (official)` : entry.name,
              entry.source,
              String(entry.entryCount),
              entry.lastError === null
                ? formatTimestamp(entry.lastRefreshAt)
                : `failed: ${entry.lastError}`,
            ]),
          ),
        );
      }),
    );

  marketplace
    .command("refresh [name]")
    .description(
      "Re-read one marketplace catalog, or every one of them. Discovery metadata and icons only: a refresh never installs, updates, or runs plugin code",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (name: string | undefined, opts: JsonOutputOptions) => {
        const results = await createCliBbSdk(
          getUrl(),
        ).plugins.marketplaces.refresh(name === undefined ? {} : { name });
        if (opts.json) {
          outputJson(opts, results);
          return;
        }
        for (const result of results) {
          console.log(
            result.ok
              ? `${result.name}: ${result.marketplace.entryCount} entries`
              : `${result.name}: refresh failed (${result.error ?? "unknown error"}); keeping the last catalog`,
          );
        }
        if (results.some((result) => !result.ok)) process.exit(1);
      }),
    );

  marketplace
    .command("remove <name>")
    .description(
      "Forget a marketplace. bb-official and bb-community cannot be removed. Installed plugins keep their direct sources",
    )
    .option("--json", "Output JSON")
    .action(
      action(async (name: string, opts: JsonOutputOptions) => {
        const removed = await createCliBbSdk(
          getUrl(),
        ).plugins.marketplaces.remove({ name });
        if (opts.json) {
          outputJson(opts, removed);
          return;
        }
        console.log(`Removed marketplace ${name}.`);
        if (removed.convertedPluginIds.length === 0) return;
        console.log(
          `Kept as direct installs: ${removed.convertedPluginIds.join(", ")}`,
        );
      }),
    );
}
