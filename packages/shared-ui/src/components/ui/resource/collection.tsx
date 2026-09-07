import type { ComponentProps, ReactNode, Ref } from "react";
import { Button, type ButtonProps } from "../button";
import { Icon, type IconName } from "../icon";
import { ScrollArea } from "../scroll-area";
import { cn } from "../../../lib/utils";
import { ResourceOverview, ResourceSectionTitle } from "./detail-shell";
import { ResourceActionButton } from "./row";
import { ResourceTabDescription, ResourceToolbar } from "./toolbar";

export interface ResourceCollectionMode<Mode extends string> {
  id: Mode;
  label: ReactNode;
  count?: number;
  accessibleLabel?: string;
}

type ResourceCollectionModeProps<Mode extends string> =
  | { modes?: undefined; activeMode?: undefined; onModeChange?: undefined }
  | {
      modes: readonly ResourceCollectionMode<Mode>[];
      activeMode: Mode;
      onModeChange: (mode: Mode) => void;
    };

export function ResourceCollectionPage<Mode extends string>({
  id,
  description,
  modes,
  activeMode,
  onModeChange,
  actions,
  children,
  className,
  bandClassName,
}: {
  id: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bandClassName?: string;
} & ResourceCollectionModeProps<Mode>) {
  const modeList = modes ?? [];
  const hasModes = modeList.length > 0;
  const changeMode = onModeChange ?? (() => {});
  const activeTabId = hasModes ? `${id}-${activeMode}-tab` : undefined;
  const activePanelId = hasModes ? `${id}-${activeMode}-panel` : undefined;
  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-5", className)}>
      {}
      <div className="pr-3">
        <div className={bandClassName}>
          <ResourceTabDescription>{description}</ResourceTabDescription>
        </div>
      </div>
      {hasModes || actions !== undefined ? (
        <div className="pr-3">
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-2",
              bandClassName,
            )}
          >
            <div
              className="flex items-center gap-1"
              role={hasModes ? "tablist" : undefined}
            >
              {modeList.map((mode) => {
                const active = mode.id === activeMode;
                const modeIndex = modeList.indexOf(mode);
                return (
                  <button
                    key={mode.id}
                    id={`${id}-${mode.id}-tab`}
                    type="button"
                    role="tab"
                    aria-label={mode.accessibleLabel}
                    aria-selected={active}
                    aria-controls={`${id}-${mode.id}-panel`}
                    tabIndex={active ? 0 : -1}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => changeMode(mode.id)}
                    onKeyDown={(event) => {
                      let nextIndex: number | null = null;
                      if (event.key === "ArrowRight") {
                        nextIndex = (modeIndex + 1) % modeList.length;
                      } else if (event.key === "ArrowLeft") {
                        nextIndex =
                          (modeIndex - 1 + (modes?.length ?? 1)) %
                          (modes?.length ?? 1);
                      } else if (event.key === "Home") {
                        nextIndex = 0;
                      } else if (event.key === "End") {
                        nextIndex = modeList.length - 1;
                      }
                      if (nextIndex === null) return;
                      event.preventDefault();
                      const nextMode = modeList[nextIndex];
                      if (nextMode === undefined) return;
                      changeMode(nextMode.id);
                      document
                        .getElementById(`${id}-${nextMode.id}-tab`)
                        ?.focus();
                    }}
                  >
                    {mode.label}
                    {mode.count !== undefined ? (
                      <span className="text-2xs text-subtle-foreground">
                        {mode.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {actions}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        id={activePanelId}
        role={hasModes ? "tabpanel" : undefined}
        aria-labelledby={activeTabId}
        tabIndex={hasModes ? 0 : undefined}
        className="min-h-0 flex-1 focus-visible:outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export function ResourceCollectionViewport({
  toolbar,
  children,
  footer,
  scrollId,
  viewportRef,
  className,
  contentClassName,
  bandClassName,
}: {
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  scrollId?: string;
  viewportRef?: Ref<HTMLDivElement>;
  className?: string;
  contentClassName?: string;
  bandClassName?: string;
}) {
  return (
    <div
      className={cn("flex h-full min-h-0 flex-col gap-5", className)}
      data-resource-collection-viewport
    >
      {}
      {toolbar ? (
        <div className="shrink-0 pr-3">
          <div className={bandClassName}>{toolbar}</div>
        </div>
      ) : null}
      <ScrollArea
        type="scroll"
        scrollHideDelay={600}
        className="min-h-0 flex-1"
        scrollbarClassName="w-2"
        viewportRef={viewportRef}
        viewportProps={{
          id: scrollId,
          className: cn("overscroll-contain pr-3", contentClassName),
          "data-resource-collection-scroll": true,
        }}
      >
        {children}
      </ScrollArea>
      {footer ? (
        <div
          className="sticky bottom-0 z-10 shrink-0 border-t border-border/70 bg-background pt-3 pr-3"
          data-resource-collection-footer
        >
          <div className={bandClassName}>{footer}</div>
        </div>
      ) : null}
    </div>
  );
}

export function ResourceOverviewSection({
  id,
  label,
  toolbar,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  toolbar: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={cn("space-y-2", className)}>
      <ResourceSectionTitle id={id} className="px-3">
        {label}
      </ResourceSectionTitle>
      {toolbar}
      {children}
    </section>
  );
}

export function ResourceBrowseGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(min(100%,23rem),1fr))] gap-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ResourceBrowseSectionItem {
  id: string;
  content: ReactNode;
}

export function ResourceBrowseSection({
  icon,
  attribution,
  onBrowseAll,
  items,
  state,
}: {
  icon: IconName;
  attribution?: ReactNode;
  onBrowseAll?: () => void;
  items?: readonly ResourceBrowseSectionItem[];
  state?: ReactNode;
}) {
  const visibleItems = items ?? [];
  const shouldShowOverflowFade = visibleItems.length > 3;
  if (state === undefined && visibleItems.length === 0) return null;

  return (
    <ResourceSourceShelf
      label="Browse"
      leading={
        <Icon
          name={icon}
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      }
      attribution={attribution}
      browseAction={
        onBrowseAll ? (
          <ResourceShelfSeeAllAction type="button" onClick={onBrowseAll} />
        ) : undefined
      }
      contentMode={state === undefined ? "rail" : "panel"}
      scrollOverlay={
        state === undefined && shouldShowOverflowFade ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-[var(--resource-source-shelf-fade-ramp)] bg-gradient-to-r from-transparent to-surface-recessed-solid"
          />
        ) : undefined
      }
    >
      {state ??
        visibleItems.map((item) => (
          <ResourceSourceItem key={item.id}>{item.content}</ResourceSourceItem>
        ))}
    </ResourceSourceShelf>
  );
}

export function ResourceOverviewPage({
  description,
  browse,
  installed,
  className,
}: {
  description: ReactNode;
  browse: ComponentProps<typeof ResourceBrowseSection>;
  installed: {
    headingId: string;
    label: ReactNode;
    searchValue: string;
    searchPlaceholder: string;
    searchLabel?: string;
    onSearchChange: (value: string) => void;
    controls?: ReactNode;
    action?: ReactNode;
    body: ReactNode;
  };
  className?: string;
}) {
  return (
    <ResourceOverview
      className={className}
      description={description}
      browse={<ResourceBrowseSection {...browse} />}
    >
      <ResourceOverviewSection
        id={installed.headingId}
        label={installed.label}
        toolbar={
          <ResourceToolbar
            searchValue={installed.searchValue}
            searchPlaceholder={installed.searchPlaceholder}
            searchLabel={installed.searchLabel}
            onSearchChange={installed.onSearchChange}
            controls={installed.controls}
            action={installed.action}
          />
        }
      >
        {installed.body}
      </ResourceOverviewSection>
    </ResourceOverview>
  );
}

export function ResourceSourceShelf({
  label,
  attribution,
  description,
  leading,
  browseAction,
  scrollOverlay,
  contentMode = "rail",
  contentSurface = "recessed",
  children,
}: {
  label: ReactNode;
  attribution?: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  browseAction?: ReactNode;
  scrollOverlay?: ReactNode;
  contentMode?: "rail" | "panel";
  contentSurface?: "recessed" | "plain";
  children: ReactNode;
}) {
  return (
    <section className="w-full max-w-full space-y-[var(--resource-source-shelf-section-gap)] text-popover-foreground">
      <div className="flex min-w-0 items-center gap-[var(--resource-source-shelf-label-gap)] px-[var(--resource-source-shelf-inset)] text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-[var(--resource-source-shelf-label-gap)]">
          {leading}
          <ResourceSectionTitle className="truncate">
            {label}
          </ResourceSectionTitle>
          {attribution !== undefined &&
          attribution !== null &&
          attribution !== false ? (
            <span className="truncate text-subtle-foreground">
              {attribution}
            </span>
          ) : null}
        </div>
        {browseAction && description === undefined ? (
          <div className="ml-auto shrink-0 text-xs text-muted-foreground">
            {browseAction}
          </div>
        ) : null}
      </div>
      {description === undefined ? null : (
        <div className="flex min-w-0 items-center gap-3 px-[var(--resource-source-shelf-inset)]">
          <p className="min-w-0 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
          {browseAction ? (
            <div className="ml-auto shrink-0 text-xs text-muted-foreground">
              {browseAction}
            </div>
          ) : null}
        </div>
      )}
      <div
        className={cn(
          contentSurface === "recessed"
            ? "rounded-lg bg-surface-recessed/70 p-[var(--resource-source-shelf-inset)]"
            : "px-[var(--resource-source-shelf-inset)]",
        )}
      >
        {contentMode === "panel" ? (
          children
        ) : (
          <div className="relative">
            <div className="-ml-[var(--resource-source-shelf-shadow-left-bleed)] -my-[var(--resource-source-shelf-shadow-bleed)] overflow-x-auto pl-[var(--resource-source-shelf-shadow-left-bleed)] py-[var(--resource-source-shelf-shadow-bleed)]">
              <div className="flex w-full snap-x snap-mandatory gap-[var(--resource-source-shelf-item-gap)]">
                {children}
              </div>
            </div>
            {scrollOverlay ? (
              <div className="pointer-events-none absolute inset-x-0 top-[var(--resource-source-shelf-shadow-bleed)] bottom-[var(--resource-source-shelf-shadow-bleed)]">
                {scrollOverlay}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

export function ResourceShelfAction({
  className,
  ...props
}: Omit<ButtonProps, "size" | "variant">) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto shrink-0 rounded-md px-[var(--resource-source-shelf-action-inline)] py-[var(--resource-source-shelf-action-block)] text-xs font-normal text-muted-foreground hover:bg-state-hover hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ResourceShelfSeeAllAction({
  className,
  ...props
}: Omit<ButtonProps, "children" | "size" | "variant">) {
  return (
    <ResourceShelfAction className={className} {...props}>
      See all
    </ResourceShelfAction>
  );
}

export function ResourceSourceItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-[22rem] shrink-0 snap-start md:w-[var(--resource-source-shelf-item-width)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

type ResourceBrowseCardProps = {
  className?: string;
  leading?: ReactNode;
  leadingClassName?: string;
  title: ReactNode;
  description?: ReactNode;
  descriptionLines?: 2 | 3;
  byline?: ReactNode;
  headerAction?: ReactNode;
  footerMeta?: ReactNode;
  pointerOnlyOpen?: boolean;
} & (
  | { openLabel: string; onOpen: (trigger: HTMLButtonElement) => void }
  | { openLabel?: undefined; onOpen?: undefined }
);

export function ResourceBrowseCard({
  className,
  leading,
  leadingClassName,
  title,
  description,
  descriptionLines = 2,
  byline,
  headerAction,
  footerMeta,
  pointerOnlyOpen = false,
  openLabel,
  onOpen,
}: ResourceBrowseCardProps) {
  const hasLeading =
    leading !== undefined && leading !== null && leading !== false;
  return (
    <div
      className={cn(
        "group relative grid min-h-28 w-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-2 rounded-lg border border-border bg-card p-3 text-left",
        onOpen &&
          "transition-[border-color,box-shadow,background-color] duration-150 hover:border-foreground/30 hover:bg-[color-mix(in_oklab,var(--ink)_2.5%,transparent)] hover:shadow-sm",
        className,
      )}
    >
      {onOpen ? (
        <button
          type="button"
          aria-label={pointerOnlyOpen ? undefined : openLabel}
          aria-hidden={pointerOnlyOpen || undefined}
          tabIndex={pointerOnlyOpen ? -1 : undefined}
          data-resource-card-pointer-action={pointerOnlyOpen ? "" : undefined}
          onClick={(event) => onOpen(event.currentTarget)}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : null}
      {hasLeading ? (
        <span className="pointer-events-none relative col-start-1 row-start-1 flex min-w-0 items-center">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center",
              leadingClassName,
            )}
          >
            {leading}
          </span>
          <span className="ml-3 min-w-0 flex-1">{renderTitle()}</span>
        </span>
      ) : (
        <span className="pointer-events-none relative col-start-1 row-start-1 min-w-0 self-center">
          {renderTitle()}
        </span>
      )}
      {headerAction ? (
        <span
          data-row-action
          className="relative col-start-2 row-start-1 flex shrink-0 cursor-default items-center justify-end whitespace-nowrap"
        >
          {headerAction}
        </span>
      ) : null}
      {description ? (
        <span
          className={cn(
            "pointer-events-none relative col-span-2 row-start-2 self-center text-left text-xs leading-snug text-muted-foreground",
            descriptionLines === 3 ? "line-clamp-3" : "line-clamp-2",
          )}
        >
          {description}
        </span>
      ) : null}
      {byline ? (
        <span className="pointer-events-none relative col-start-1 row-start-3 mt-1.5 flex min-h-4 min-w-0 items-center text-left text-xs text-subtle-foreground">
          <span className="block min-w-0 truncate">{byline}</span>
        </span>
      ) : null}
      {footerMeta ? (
        <span className="pointer-events-none relative col-start-2 row-start-3 mt-1.5 flex min-h-4 min-w-0 items-center justify-end text-right">
          {footerMeta}
        </span>
      ) : null}
    </div>
  );

  function renderTitle() {
    return (
      <span className="block truncate text-sm font-medium text-foreground">
        {title}
      </span>
    );
  }
}

export function ResourceTemplateBrowseCard({
  title,
  description,
  actionLabel = "Use template",
  onUse,
}: {
  title: string;
  description: ReactNode;
  actionLabel?: string;
  onUse: () => void;
}) {
  return (
    <ResourceBrowseCard
      title={title}
      description={description}
      descriptionLines={3}
      openLabel={`${actionLabel}: ${title}`}
      pointerOnlyOpen
      headerAction={
        <ResourceActionButton
          label={`${actionLabel}: ${title}`}
          tooltipLabel={actionLabel}
          icon="MessageCirclePlus"
          className="size-7 hover:bg-state-hover focus-visible:bg-state-hover"
          onClick={onUse}
        />
      }
      onOpen={onUse}
    />
  );
}
