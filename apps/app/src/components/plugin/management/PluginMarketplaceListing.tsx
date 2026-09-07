import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@bb/shared-ui/carousel";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ResourceDefinitionSection,
  ResourceListPanel,
  ResourceRow,
  ResourceRowDetailChevron,
} from "@bb/shared-ui/resource-list";
import type { PluginCatalogSearchEntry } from "@/hooks/queries/plugin-catalog-queries";
import { PluginOverviewMarkdown } from "@/components/plugin/management/PluginOverviewMarkdown";
import { CatalogEntryIconChip, PluginCategoryLabel } from "./plugin-ui";
import { PluginAuthorAvatar } from "./PluginAuthorAvatar";
import { PluginAuthorLink } from "./PluginAuthorLink";
import {
  entriesByMarketplaceAuthor,
  pluginAuthorGithub,
  pluginMarketplaceAuthorKey,
} from "./plugin-marketplace-author";

function repositoryLinkLabel(url: string): string {
  return url.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
}

export function PluginMarketplaceHeaderMetadata({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  if (entry.author === null) return null;
  const author = entry.author;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <PluginAuthorAvatar
        name={author.name}
        github={pluginAuthorGithub(author)}
        size="detail"
      />
      <span className="min-w-0">
        By{" "}
        <PluginAuthorLink
          entry={entry}
          className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {author.name}
        </PluginAuthorLink>
      </span>
    </span>
  );
}

export function PluginMarketplaceCategoryPill({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  return entry.category === undefined ? null : (
    <PluginCategoryLabel categoryId={entry.categoryId} label={entry.category} />
  );
}

function PluginMarketplaceDetail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-2xs font-medium text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 text-xs text-muted-foreground">{children}</dd>
    </div>
  );
}

function PluginMarketplaceDetails({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  return (
    <ResourceDefinitionSection label="Details">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {entry.publishedAt === undefined ? null : (
          <PluginMarketplaceDetail label="Listed">
            <time dateTime={entry.publishedAt}>
              {new Date(entry.publishedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          </PluginMarketplaceDetail>
        )}
        <PluginMarketplaceDetail label="Marketplace">
          {entry.marketplaceDisplayName}
        </PluginMarketplaceDetail>
      </dl>
    </ResourceDefinitionSection>
  );
}

function PluginMarketplaceSource({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  if (entry.repositoryUrl === null) return null;
  return (
    <ResourceDefinitionSection label="Source">
      <a
        href={entry.repositoryUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="truncate">
          {repositoryLinkLabel(entry.repositoryUrl)}
        </span>
        <Icon name="ExternalLink" className="size-3.5 shrink-0" aria-hidden />
        <span className="sr-only">Opens in a new tab</span>
      </a>
    </ResourceDefinitionSection>
  );
}

const SCREENSHOT_ROW_HEIGHT = 420;

function PluginScreenshotGallery({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  const [api, setApi] = useState<CarouselApi>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    if (api === undefined) return;
    const updateSelection = () => setSelectedIndex(api.selectedScrollSnap());
    updateSelection();
    api.on("select", updateSelection);
    api.on("reInit", updateSelection);
    return () => {
      api.off("select", updateSelection);
      api.off("reInit", updateSelection);
    };
  }, [api]);
  if (entry.screenshots.length === 0) return null;
  return (
    <>
      <Carousel
        setApi={setApi}
        opts={{ align: "start", containScroll: "trimSnaps" }}
        aria-label={`${entry.displayName} screenshots`}
        className={cn("w-full", entry.screenshots.length > 1 && "px-11")}
      >
        <CarouselContent
          className="-ml-3 items-center"
          style={{ minHeight: `${SCREENSHOT_ROW_HEIGHT}px` }}
        >
          {entry.screenshots.map((screenshot, index) => (
            <CarouselItem key={screenshot} className="basis-auto pl-3">
              <img
                src={screenshot}
                alt={`${entry.displayName} screenshot ${index + 1}`}
                referrerPolicy="no-referrer"
                loading="lazy"
                className="h-auto w-auto rounded-md border border-border object-contain"
                style={{
                  maxHeight: `${SCREENSHOT_ROW_HEIGHT}px`,
                  maxWidth: `${SCREENSHOT_ROW_HEIGHT * 2}px`,
                }}
              />
            </CarouselItem>
          ))}
        </CarouselContent>
        {entry.screenshots.length > 1 ? (
          <>
            <CarouselPrevious className="left-0 size-8" />
            <CarouselNext className="right-0 size-8" />
          </>
        ) : null}
      </Carousel>
      {entry.screenshots.length > 1 ? (
        <div
          className="flex justify-center gap-1.5"
          aria-label={`Screenshot ${selectedIndex + 1} of ${entry.screenshots.length}`}
          role="status"
        >
          {entry.screenshots.map((screenshot, index) => (
            <span
              key={screenshot}
              aria-hidden
              className={cn(
                "h-1 rounded-full transition-[width,background-color]",
                index === selectedIndex
                  ? "w-4 bg-foreground/70"
                  : "w-2 bg-border",
              )}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

export function PluginOverviewLead({ description }: { description: string }) {
  return (
    <p
      className="max-w-prose text-base leading-relaxed text-foreground"
      data-plugin-summary=""
    >
      {description}
    </p>
  );
}

function PluginMarketplaceOverview({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  return (
    <section className="space-y-6" data-resource-detail-section="overview">
      <PluginScreenshotGallery entry={entry} />
      <div className="space-y-3">
        <PluginOverviewLead description={entry.description} />
        {entry.overview === undefined ? null : (
          <>
            <hr className="border-t border-border" />
            <h2 className="text-sm font-medium text-foreground">Overview</h2>
            <PluginOverviewMarkdown markdown={entry.overview} />
          </>
        )}
      </div>
    </section>
  );
}

export function PluginMarketplaceListingSections({
  entry,
}: {
  entry: PluginCatalogSearchEntry;
}) {
  return (
    <>
      <PluginMarketplaceOverview entry={entry} />
      <PluginMarketplaceSource entry={entry} />
      <PluginMarketplaceDetails entry={entry} />
    </>
  );
}

export function PluginMoreFromAuthorSection({
  entry,
  catalogEntries,
  onOpenPlugin,
}: {
  entry: PluginCatalogSearchEntry;
  catalogEntries: readonly PluginCatalogSearchEntry[];
  onOpenPlugin: (pluginId: string) => void;
}) {
  const authorKey = pluginMarketplaceAuthorKey(entry);
  const moreEntries = useMemo(
    () =>
      authorKey === null
        ? []
        : entriesByMarketplaceAuthor(catalogEntries, authorKey)
            .filter(
              (candidate) =>
                candidate.compatible &&
                (candidate.marketplace !== entry.marketplace ||
                  candidate.entryId !== entry.entryId),
            )
            .sort(
              (left, right) =>
                left.displayName.localeCompare(right.displayName) ||
                left.entryId.localeCompare(right.entryId),
            )
            .slice(0, 4),
    [authorKey, catalogEntries, entry.entryId, entry.marketplace],
  );
  if (moreEntries.length === 0) return null;
  return (
    <ResourceDefinitionSection label="More from this author">
      <ResourceListPanel className="py-0">
        {moreEntries.map((candidate) => (
          <ResourceRow
            key={`${candidate.marketplace}/${candidate.entryId}`}
            leading={<CatalogEntryIconChip entry={candidate} />}
            title={candidate.displayName}
            description={candidate.description || undefined}
            trailingVisual={<ResourceRowDetailChevron />}
            openLabel={`Open ${candidate.displayName} details`}
            onOpen={() => onOpenPlugin(candidate.pluginId)}
          />
        ))}
      </ResourceListPanel>
    </ResourceDefinitionSection>
  );
}
