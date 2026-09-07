import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useDebounceValue } from "usehooks-ts";
import { Icon } from "@bb/shared-ui/icon";
import {
  ResourceCollectionViewport,
  ResourceListState,
  ResourceSortMenu,
  ResourceToolbar,
} from "@bb/shared-ui/resource-list";
import { cn } from "@bb/shared-ui/lib/utils";
import { TOOLS_PAGE_BAND_CLASSES } from "@/components/tools/tools-navigation";
import {
  type PluginCatalogSearchEntry,
  usePluginCatalogSearch,
} from "@/hooks/queries/plugin-catalog-queries";
import { getPluginsRoutePath } from "@/lib/route-paths";
import type { AddPluginInitial } from "./AddPluginDialog";
import {
  PluginCatalogGrid,
  pluginCategoryFilterOptions,
} from "./BrowsePluginsTab";
import { PluginAuthorAvatar } from "./PluginAuthorAvatar";
import {
  PluginBrowseCategoryFilter,
  pluginBrowseSort,
  pluginBrowseSortDirection,
  pluginBrowseSortOptions,
} from "./PluginBrowseControls";
import {
  pluginCategoryFilterId,
  sortPluginEntries,
} from "./plugin-browse-discovery";
import {
  entriesByMarketplaceAuthor,
  pluginAuthorGithub,
} from "./plugin-marketplace-author";

function authorUrlLabel(url: string): string {
  return url.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

function authorForEntries(
  entries: readonly PluginCatalogSearchEntry[],
): PluginCatalogSearchEntry["author"] {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.author === null) continue;
    nameCounts.set(
      entry.author.name,
      (nameCounts.get(entry.author.name) ?? 0) + 1,
    );
  }
  let selected: PluginCatalogSearchEntry["author"] = null;
  for (const entry of entries) {
    if (entry.author === null) continue;
    const candidateCount = nameCounts.get(entry.author.name) ?? 0;
    const selectedCount =
      selected === null ? 0 : (nameCounts.get(selected.name) ?? 0);
    if (
      selected === null ||
      candidateCount > selectedCount ||
      (candidateCount === selectedCount &&
        entry.author.name.length > selected.name.length)
    ) {
      selected = entry.author;
    }
  }
  return selected;
}

export function PluginAuthorPage({
  authorKey,
  onInstall,
  onOpenPlugin,
}: {
  authorKey: string;
  onInstall: (initial: AddPluginInitial) => void;
  onOpenPlugin: (pluginId: string, trigger: HTMLButtonElement) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("query") ?? "";
  const [debouncedQuery] = useDebounceValue(query.trim(), 300);
  const selectedCategories = searchParams.getAll("category");
  const requestedSort = pluginBrowseSort(searchParams.get("sort"));
  const sortDirection =
    pluginBrowseSortDirection(searchParams.get("direction")) ?? "desc";
  const catalogQuery = usePluginCatalogSearch("", { enabled: true });
  const searchQuery = usePluginCatalogSearch(debouncedQuery, {
    enabled: debouncedQuery !== "",
  });
  const entries = useMemo(
    () =>
      entriesByMarketplaceAuthor(
        (catalogQuery.data?.entries ?? []).filter((entry) => entry.compatible),
        authorKey,
      ),
    [authorKey, catalogQuery.data?.entries],
  );
  const author = useMemo(() => authorForEntries(entries), [entries]);
  const installsKnown = entries.some((entry) => entry.installs !== null);
  const sort =
    requestedSort === "most-installed" && !installsKnown ? null : requestedSort;
  const categoryOptions = useMemo(
    () => pluginCategoryFilterOptions(entries, selectedCategories),
    [entries, selectedCategories],
  );
  const visibleEntries = useMemo(() => {
    const selected = new Set(selectedCategories);
    const searchEntries =
      debouncedQuery === ""
        ? (catalogQuery.data?.entries ?? [])
        : (searchQuery.data?.entries ?? []);
    const filtered = entriesByMarketplaceAuthor(
      searchEntries.filter((entry) => entry.compatible),
      authorKey,
    ).filter(
      (entry) =>
        selected.size === 0 || selected.has(pluginCategoryFilterId(entry)),
    );
    return sort === null
      ? filtered
      : sortPluginEntries(filtered, sort, sortDirection);
  }, [
    authorKey,
    catalogQuery.data?.entries,
    debouncedQuery,
    searchQuery.data?.entries,
    selectedCategories,
    sort,
    sortDirection,
  ]);
  const searchPending = debouncedQuery !== "" && searchQuery.isPending;
  const browseParams = new URLSearchParams(searchParams);
  browseParams.delete("author");
  const browseSearch = browseParams.toString();

  const changeSearchParams = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams);
    change(next);
    setSearchParams(next, { replace: true });
  };

  return (
    <ResourceCollectionViewport scrollId="plugin-author-results">
      <div className={cn("space-y-6 pb-8", TOOLS_PAGE_BAND_CLASSES)}>
        <div className="mx-auto w-full max-w-3xl space-y-2">
          <Link
            to={{
              pathname: getPluginsRoutePath(),
              search: browseSearch === "" ? "" : `?${browseSearch}`,
            }}
            className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Icon name="ChevronLeft" className="size-3" aria-hidden />
            Browse plugins
          </Link>
          {author === null ? null : (
            <div className="flex items-center gap-3">
              <PluginAuthorAvatar
                name={author.name}
                github={pluginAuthorGithub(author)}
                size="page"
              />
              <div className="min-w-0 space-y-1">
                <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold text-foreground">
                  <span>{author.name}</span>
                  <span className="rounded-md bg-muted px-2 py-1 text-2xs font-medium tabular-nums text-subtle-foreground">
                    {entries.length.toLocaleString()}{" "}
                    {entries.length === 1 ? "plugin" : "plugins"}
                  </span>
                </h1>
                {author.url === null ? null : (
                  <a
                    href={author.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-sm text-xs text-subtle-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {authorUrlLabel(author.url)}
                    <Icon name="ExternalLink" className="size-3" aria-hidden />
                    <span className="sr-only">Opens in a new tab</span>
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {catalogQuery.isPending ? (
          <ResourceListState state="loading" message="Loading author" />
        ) : catalogQuery.isError && entries.length === 0 ? (
          <ResourceListState
            state="error"
            message="The author catalog is not available."
            onRetry={() => void catalogQuery.refetch()}
          />
        ) : author === null ? (
          <ResourceListState state="empty" message="Author not found." />
        ) : (
          <section className="space-y-6">
            <div className="mx-auto w-full max-w-3xl">
              <ResourceToolbar
                searchValue={query}
                searchPlaceholder="Search plugins"
                onSearchChange={(value) =>
                  changeSearchParams((next) => {
                    if (value === "") next.delete("query");
                    else next.set("query", value);
                  })
                }
                controls={
                  <>
                    <PluginBrowseCategoryFilter
                      selectionMode="multiple"
                      value={selectedCategories}
                      options={categoryOptions}
                      onChange={(values) =>
                        changeSearchParams((next) => {
                          next.delete("category");
                          for (const value of values) {
                            next.append("category", value);
                          }
                        })
                      }
                    />
                    <ResourceSortMenu
                      value={sort}
                      direction={sortDirection}
                      compact
                      placeholderLabel="Featured"
                      options={pluginBrowseSortOptions(installsKnown)}
                      onChange={(value) =>
                        changeSearchParams((next) => {
                          if (value === sort) {
                            next.set(
                              "direction",
                              sortDirection === "asc" ? "desc" : "asc",
                            );
                          } else {
                            next.set("sort", value);
                            next.set("direction", "desc");
                          }
                        })
                      }
                      onClear={() =>
                        changeSearchParams((next) => {
                          next.delete("sort");
                          next.delete("direction");
                        })
                      }
                    />
                  </>
                }
              />
            </div>
            {catalogQuery.isError || searchQuery.isError ? (
              <p className="text-xs text-warning-text" role="status">
                The latest search failed. The page shows saved catalog results.
              </p>
            ) : null}
            {searchPending ? (
              <ResourceListState state="loading" message="Loading plugins" />
            ) : visibleEntries.length === 0 ? (
              <ResourceListState
                state="empty"
                message="No plugins match these filters."
              />
            ) : (
              <PluginCatalogGrid
                entries={visibleEntries}
                showCategory
                onInstall={onInstall}
                onOpenPlugin={onOpenPlugin}
              />
            )}
          </section>
        )}
      </div>
    </ResourceCollectionViewport>
  );
}
