import type { PluginCatalogAuthor } from "@bb/server-contract";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";

const GITHUB_AUTHOR_PREFIX = "github:";
const NAME_AUTHOR_PREFIX = "name:";

export function pluginAuthorGithub(
  author: PluginCatalogAuthor | null,
): string | null {
  return author?.github ?? null;
}

export function pluginMarketplaceAuthorKey(
  entry: Pick<PluginCatalogSearchEntry, "author" | "marketplace">,
): string | null {
  if (entry.author === null) return null;
  const github = pluginAuthorGithub(entry.author);
  const identity =
    github !== null
      ? `${GITHUB_AUTHOR_PREFIX}${github.toLowerCase()}`
      : `${NAME_AUTHOR_PREFIX}${entry.author.name}`;
  return `${entry.marketplace.length}:${entry.marketplace}:${identity}`;
}

export function entriesByMarketplaceAuthor<
  Entry extends Pick<PluginCatalogSearchEntry, "author" | "marketplace">,
>(entries: readonly Entry[], authorKey: string): Entry[] {
  return entries.filter(
    (entry) => pluginMarketplaceAuthorKey(entry) === authorKey,
  );
}
