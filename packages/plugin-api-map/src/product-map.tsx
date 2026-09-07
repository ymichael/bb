import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { cn } from "./cn";
import { SurfaceCard, useSurfaceCard } from "./surface-card";
import { surfaceIcon } from "./plugin-icons";
import {
  fixtureResponsiveStrategy,
  GROUP_BY_SURFACE_ID,
  SURFACE_GROUPS,
  SURFACES_BY_ID,
  type PluginSurface,
  type SurfaceGroup,
} from "./surfaces";
import {
  annotationChipCounterScale,
  CHIP_COUNTER_SCALE_PROPERTY,
  ExperimentalBadge,
  FOCUS_RING_CLASS,
  renderSurfaceCopy,
} from "./annotation";
import {
  SCROLLBAR_HIDDEN_CLASS,
  scrollEdgeFadeStyle,
  useScrollEdges,
} from "./scroll-edges";
import {
  AppShellWireframe,
  CommandPaletteWireframe,
  ComposeScreenWireframe,
  ExtensionsPluginPageWireframe,
  RealComposerAnnotated,
  SettingsWireframe,
  SurfaceMapContext,
  useSurfaceMap,
} from "./wireframes";

export const SURFACE_NUMBERS: ReadonlyMap<string, number> = new Map(
  SURFACE_GROUPS.filter((group) => group.id !== "headless").flatMap((group) =>
    group.surfaces.map((surface, index) => [surface.id, index + 1] as const),
  ),
);

export function annotationNeighbors(
  surfaces: readonly PluginSurface[],
  currentId: string,
): { previous: PluginSurface | null; next: PluginSurface | null } {
  const currentIndex = surfaces.findIndex(
    (surface) => surface.id === currentId,
  );
  if (currentIndex === -1) {
    return { previous: null, next: null };
  }
  return {
    previous: surfaces[currentIndex - 1] ?? null,
    next: surfaces[currentIndex + 1] ?? null,
  };
}

function PlatformCard({ surface }: { surface: PluginSurface }) {
  const { activeId, setActiveId, expandedId, onSelect } = useSurfaceMap();
  const selected = activeId === surface.id || expandedId === surface.id;
  const icon = surfaceIcon(surface.id);
  return (
    <a
      href={`#surface-${surface.id}`}
      aria-label={`${surface.title} — jump to details`}
      onClick={
        onSelect
          ? (event) => {
              event.preventDefault();
              onSelect(surface.id);
            }
          : undefined
      }
      onMouseEnter={() => setActiveId(surface.id)}
      onMouseLeave={() => setActiveId(null)}
      className={cn(
        "flex h-full items-center gap-3 rounded-lg border px-4 py-4 transition-colors",
        FOCUS_RING_CLASS,
        selected
          ? "border-border bg-surface-selected"
          : "border-border-hairline bg-surface-raised-solid hover:border-border hover:bg-state-hover",
      )}
    >
      {icon ? (
        <HugeiconsIcon
          icon={icon}
          className={cn(
            "size-4 shrink-0",
            selected ? "text-file-accent" : "text-foreground",
          )}
        />
      ) : null}
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {surface.title}
          </span>
          {surface.experimental ? <ExperimentalBadge /> : null}
        </span>
        {}
        <span className="line-clamp-2 text-sm text-muted-foreground @3xl:line-clamp-1">
          {renderSurfaceCopy(surface.tagline ?? surface.summary)}
        </span>
      </span>
    </a>
  );
}

function PlatformSlide({ group }: { group: SurfaceGroup }) {
  return (
    <div className="space-y-3">
      {(group.sections ?? []).map((section) => {
        const surfaces = section.surfaceIds
          .map((id) => SURFACES_BY_ID.get(id))
          .filter((surface): surface is PluginSurface => Boolean(surface));
        return (
          <section key={section.title} aria-label={section.title}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-subtle-foreground">
              {section.title}
            </h3>
            <ul className="mt-1 grid gap-1.5 sm:grid-cols-2">
              {surfaces.map((surface) => (
                <li key={surface.id} className="min-w-0">
                  <PlatformCard surface={surface} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export const MAX_FIXTURE_SCALE = 1.2;

export function spatialFixtureScale(
  availableWidth: number,
  authoredWidth: number,
  availableHeight?: number,
  authoredHeight?: number,
): number {
  if (availableWidth <= 0 || authoredWidth <= 0) return 1;
  const heightScale =
    availableHeight !== undefined &&
    authoredHeight !== undefined &&
    availableHeight > 0 &&
    authoredHeight > 0
      ? availableHeight / authoredHeight
      : Number.POSITIVE_INFINITY;
  return Math.min(
    MAX_FIXTURE_SCALE,
    availableWidth / authoredWidth,
    heightScale,
  );
}

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const FIXTURE_WIDTH_BANDS: Record<
  string,
  { min: number; max: number } | undefined
> = {
  "app-shell": { min: 1260, max: 1440 },
  "command-palette": { min: 860, max: 1200 },
  composer: { min: 720, max: 768 },
  home: { min: 560, max: 1080 },
  settings: { min: 640, max: 900 },
  extensions: { min: 640, max: 900 },
};

function SpatialFixture({
  band,
  children,
}: {
  band?: { min: number; max: number };
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const fixtureRef = useRef<HTMLDivElement>(null);
  const cardReserveRef = useRef(0);
  const [geometry, setGeometry] = useState({
    scale: 1,
    height: null as number | null,
    width: null as number | null,
    offsetX: 0,
  });

  useBrowserLayoutEffect(() => {
    const frame = frameRef.current;
    const fixture = fixtureRef.current;
    if (!frame || !fixture) return;
    const viewport = frame.closest<HTMLElement>("[data-guide-stage-viewport]");

    const measure = () => {
      const authoredWidth = fixture.scrollWidth;
      const authoredHeight = fixture.scrollHeight;
      const flowCard = frame
        .closest("section")
        ?.querySelector<HTMLElement>("[data-guide-card-flow]");
      if (flowCard) {
        cardReserveRef.current = Math.max(
          cardReserveRef.current,
          flowCard.getBoundingClientRect().height +
            parseFloat(getComputedStyle(flowCard).marginTop || "0"),
        );
      } else {
        cardReserveRef.current = 0;
      }
      const probe = frame
        .closest("[data-map-section]")
        ?.querySelector<HTMLElement>("[data-guide-card-probe]");
      let probeReserve = 0;
      if (probe) {
        for (const item of Array.from(probe.children)) {
          if (!(item instanceof HTMLElement)) continue;
          probeReserve = Math.max(
            probeReserve,
            item.offsetHeight +
              parseFloat(getComputedStyle(item).marginTop || "0"),
          );
        }
      }
      const cardFootprint = flowCard
        ? Math.max(probeReserve, cardReserveRef.current)
        : 0;
      const availableHeight = viewport
        ? viewport.clientHeight -
          (frame.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop) -
          cardFootprint -
          8
        : undefined;
      const scale = spatialFixtureScale(
        frame.clientWidth,
        authoredWidth,
        availableHeight,
        authoredHeight,
      );
      const scaled = Math.abs(scale - 1) >= 0.0001;
      const height = scaled ? authoredHeight * scale : null;
      const width = scaled ? authoredWidth : null;
      const offsetX = scaled ? (frame.clientWidth - authoredWidth) / 2 : 0;
      setGeometry((current) =>
        Math.abs(current.scale - scale) < 0.0001 &&
        current.height === height &&
        current.width === width &&
        Math.abs(current.offsetX - offsetX) < 0.5
          ? current
          : { scale, height, width, offsetX },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(fixture);
    if (viewport) observer.observe(viewport);
    const probeRoot = frame
      .closest("[data-map-section]")
      ?.querySelector("[data-guide-card-probe]");
    if (probeRoot?.firstElementChild) {
      observer.observe(probeRoot.firstElementChild);
    }
    const section = frame.closest("section");
    let observedCard: Element | null = null;
    const watchCard = () => {
      const card = section?.querySelector("[data-guide-card-flow]") ?? null;
      if (card === observedCard) return;
      if (observedCard) observer.unobserve(observedCard);
      observedCard = card;
      if (card) observer.observe(card);
      measure();
    };
    watchCard();
    const cardObserver = section ? new MutationObserver(watchCard) : null;
    cardObserver?.observe(section as Node, { childList: true });
    return () => {
      observer.disconnect();
      cardObserver?.disconnect();
    };
  }, []);

  const scaled = geometry.height !== null;
  return (
    <div
      ref={frameRef}
      data-guide-responsive-strategy="scale-together"
      data-guide-scale={geometry.scale.toFixed(4)}
      className="w-full overflow-x-clip transition-[height] duration-300 ease-out"
      style={scaled ? { height: geometry.height ?? undefined } : undefined}
    >
      <div
        ref={fixtureRef}
        className="mx-auto w-full origin-top transition-transform duration-300 ease-out"
        style={
          {
            minWidth: band?.min,
            maxWidth: band?.max,
            [CHIP_COUNTER_SCALE_PROPERTY]: annotationChipCounterScale(
              geometry.scale,
            ),
            ...(scaled
              ? {
                  transform: `scale(${geometry.scale})`,
                  width: geometry.width ?? undefined,
                  marginLeft: geometry.offsetX,
                  marginRight: 0,
                }
              : undefined),
          } as CSSProperties
        }
      >
        {children}
      </div>
    </div>
  );
}

function SlideContent({ group }: { group: SurfaceGroup }) {
  switch (group.id) {
    case "app-shell":
      return <AppShellWireframe />;
    case "command-palette":
      return <CommandPaletteWireframe />;
    case "composer":
      return <RealComposerAnnotated />;
    case "home":
      return <ComposeScreenWireframe />;
    case "settings":
      return <SettingsWireframe />;
    case "extensions":
      return <ExtensionsPluginPageWireframe />;
    case "headless":
      return <PlatformSlide group={group} />;
  }
}

const PROBE_NOOP = () => {};
const PROBE_COPY = async () => false;

function CardReserveProbe({ group }: { group: SurfaceGroup }) {
  return (
    <div
      inert
      aria-hidden
      data-guide-card-probe
      className="invisible h-0 overflow-hidden"
    >
      {group.surfaces.map((surface) => (
        <div
          key={surface.id}
          className="mt-[clamp(8px,var(--guide-stage-gap,8px),28px)] w-full"
        >
          <SurfaceCard
            probe
            surface={surface}
            number={SURFACE_NUMBERS.get(surface.id) ?? null}
            onDismiss={PROBE_NOOP}
            onCopyForAgent={PROBE_COPY}
            navigation={{
              ...annotationNeighbors(group.surfaces, surface.id),
              onOpen: PROBE_NOOP,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function Slide({ group }: { group: SurfaceGroup }) {
  if (fixtureResponsiveStrategy(group) === "reflow") {
    return (
      <div data-guide-responsive-strategy="reflow" className="w-full">
        <SlideContent group={group} />
      </div>
    );
  }
  return (
    <>
      <SpatialFixture band={FIXTURE_WIDTH_BANDS[group.id]}>
        <SlideContent group={group} />
      </SpatialFixture>
      <CardReserveProbe group={group} />
    </>
  );
}

function SlideTitle({ title }: { title: string }) {
  const parts = title.split(/\bbb\b/);
  if (parts.length === 1) {
    return <>{title}</>;
  }
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="font-bold italic">bb</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export function panCarets(
  index: number,
  slideCount: number,
): { previous: boolean; next: boolean } {
  return { previous: index > 0, next: index < slideCount - 1 };
}

function PanButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${direction === "previous" ? "Previous" : "Next"} surface`}
      className={cn(
        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        FOCUS_RING_CLASS,
      )}
    >
      <HugeiconsIcon
        icon={direction === "previous" ? ArrowLeft01Icon : ArrowRight01Icon}
        className="size-4"
      />
    </button>
  );
}

function useStageHeight(
  index: number,
  slideRefs: React.RefObject<Array<HTMLDivElement | null>>,
): { height: number | null; animate: boolean } {
  const [height, setHeight] = useState<number | null>(null);
  const [animate, setAnimate] = useState(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setAnimate(true);
    const timer = window.setTimeout(() => setAnimate(false), 350);
    return () => window.clearTimeout(timer);
  }, [index]);
  useEffect(() => {
    const slide = slideRefs.current[index];
    if (!slide) {
      return;
    }
    const measure = () => setHeight(slide.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slide);
    return () => observer.disconnect();
  }, [index, slideRefs]);
  return { height, animate };
}

export function ProductMap({
  header,
  pluginPageHref,
  initialSlideId,
  onSlideChange,
  onCopyForAgent,
  tone = "primary",
}: {
  header?: ReactNode;
  pluginPageHref?: (displayName: string) => string | null;
  initialSlideId?: string;
  onSlideChange?: (slideId: string) => void;
  onCopyForAgent?: (surface: PluginSurface) => Promise<boolean>;
  tone?: "primary" | "supporting";
}) {
  const slides = SURFACE_GROUPS;
  const containerRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pageListRef = useRef<HTMLDivElement>(null);
  const pageButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const card = useSurfaceCard();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pageListEdges = useScrollEdges(pageListRef);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      slides.findIndex((slide) => slide.id === initialSlideId),
    ),
  );
  const stage = useStageHeight(index, slideRefs);

  useEffect(() => {
    const list = pageListRef.current;
    const button = pageButtonRefs.current[index];
    if (!list || !button) return;
    const listRect = list.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const leftDelta = buttonRect.left - listRect.left;
    const rightDelta = buttonRect.right - listRect.right;
    if (leftDelta < 0) list.scrollLeft += leftDelta;
    else if (rightDelta > 0) list.scrollLeft += rightDelta;
  }, [index]);

  const openSurface = card.openId ? SURFACES_BY_ID.get(card.openId) : undefined;
  const carets = panCarets(index, slides.length);

  const show = (next: number) => {
    if (next < 0 || next >= slides.length) {
      return;
    }
    card.close();
    setHoverId(null);
    setIndex(next);
    onSlideChange?.(slides[next].id);
  };

  const goToSurface = (id: string) => {
    const group = GROUP_BY_SURFACE_ID.get(id);
    if (!group) return;
    const target = slides.findIndex((slide) => slide.id === group.id);
    if (target === -1) return;
    if (target !== index) show(target);
    card.open(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(index - 1);
    }
  };

  const mapState = useMemo(
    () => ({
      activeId: hoverId,
      setActiveId: setHoverId,
      expandedId: card.openId,
      numberOf: (id: string) => SURFACE_NUMBERS.get(id) ?? null,
      onSelect: card.open,
      pluginPageHref,
      currentGroupId: slides[index].id,
      onGoToSurface: goToSurface,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hoverId, card.openId, pluginPageHref, index],
  );

  const cardNode = openSurface ? (
    <SurfaceCard
      surface={openSurface}
      number={SURFACE_NUMBERS.get(openSurface.id) ?? null}
      onDismiss={card.close}
      onCopyForAgent={onCopyForAgent}
      navigation={{
        ...annotationNeighbors(slides[index].surfaces, openSurface.id),
        onOpen: goToSurface,
      }}
    />
  ) : null;
  useEffect(() => {
    if (card.openId === null) return;
    const container = containerRef.current;
    if (container === null) return;
    const scope =
      container.closest<HTMLElement>("[data-bb-plugin]") ?? container;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[role="dialog"]')) return;
      if (target.closest('a[href^="#surface-"]')) return;
      card.close();
    };
    scope.addEventListener("pointerdown", onPointerDown);
    return () => scope.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.openId]);

  return (
    <SurfaceMapContext.Provider value={mapState}>
      <div ref={containerRef} className="relative">
        {}
        <div data-map-column className="mx-auto w-full max-w-[100rem]">
          {header}

          <section
            aria-roledescription="carousel"
            aria-label="bb surfaces a plugin can extend"
            onKeyDown={onKeyDown}
            className={header ? "mt-8" : "mt-2"}
          >
            {}
            <div className="mb-3 border-b border-border-hairline pb-3">
              {tone === "supporting" ? (
                <h3 className="text-sm font-medium">
                  <SlideTitle title={slides[index].title} />
                </h3>
              ) : (
                <h2 className="text-base font-semibold">
                  <SlideTitle title={slides[index].title} />
                </h2>
              )}
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-subtle-foreground/75">
                {slides[index].blurb}
              </p>
            </div>
            {}
            <div className="mx-auto flex w-fit max-w-full items-center gap-1">
              <PanButton
                direction="previous"
                disabled={!carets.previous}
                onClick={() => show(index - 1)}
              />
              <div
                ref={pageListRef}
                data-guide-page-list-scroll
                className={cn(
                  "min-w-0 overflow-x-auto",
                  SCROLLBAR_HIDDEN_CLASS,
                )}
                style={scrollEdgeFadeStyle(
                  pageListEdges.canScrollLeft,
                  pageListEdges.canScrollRight,
                )}
              >
                <ul className="flex w-max flex-nowrap items-center gap-1">
                  {slides.map((entry, slideIndex) => (
                    <li key={entry.id} className="shrink-0">
                      <button
                        ref={(element) => {
                          pageButtonRefs.current[slideIndex] = element;
                        }}
                        type="button"
                        onClick={() => show(slideIndex)}
                        aria-current={slideIndex === index ? "true" : undefined}
                        className={cn(
                          "cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition-colors",
                          FOCUS_RING_CLASS,
                          slideIndex === index
                            ? "bg-surface-selected text-foreground"
                            : "text-subtle-foreground hover:bg-state-hover hover:text-foreground",
                        )}
                      >
                        {entry.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <PanButton
                direction="next"
                disabled={!carets.next}
                onClick={() => show(index + 1)}
              />
            </div>
            <div
              className={cn(
                "overflow-x-clip",
                stage.animate && "transition-[height] duration-300 ease-out",
              )}
              style={{
                ...(stage.height === null
                  ? undefined
                  : { height: stage.height }),
                clipPath: "inset(0 0 -24rem 0)",
              }}
            >
              <div
                className="flex transition-transform duration-300 ease-out"
                style={{ transform: `translateX(-${index * 100}%)` }}
              >
                {slides.map((entry, slideIndex) => (
                  <div
                    key={entry.id}
                    data-map-section={entry.id}
                    ref={(element) => {
                      slideRefs.current[slideIndex] = element;
                    }}
                    inert={slideIndex !== index}
                    style={
                      slideIndex === index || stage.height === null
                        ? undefined
                        : { maxHeight: stage.height, overflow: "hidden" }
                    }
                    className="min-w-0 w-full shrink-0 self-start px-1 pt-2"
                  >
                    <Slide group={entry} />
                  </div>
                ))}
              </div>
            </div>

            {}
            {cardNode ? (
              <div
                data-guide-card-flow
                className="mx-auto mt-[clamp(8px,var(--guide-stage-gap,8px),28px)] w-full"
              >
                {cardNode}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </SurfaceMapContext.Provider>
  );
}
