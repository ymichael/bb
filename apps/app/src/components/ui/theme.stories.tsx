import type { ReactNode } from "react";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { cn } from "@bb/shared-ui/lib/utils";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Pill } from "@bb/shared-ui/pill";
import { EmptyStatePanel } from "@bb/shared-ui/empty-state";
import { SIDEBAR_UNREAD_DOT_CLASS } from "../sidebar/sidebarRowClasses";

export default {
  title: "Theme Tokens",
};

const THEME_MODES: readonly string[] = ["light", "dark"];

function DualTheme({ children }: { children: ReactNode }) {
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {THEME_MODES.map((mode) => (
        <div
          key={mode}
          className={cn(
            mode,
            "flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-3 text-foreground",
          )}
        >
          {children}
        </div>
      ))}
    </div>
  );
}

function OnBothSurfaces({ children }: { children: ReactNode }) {
  return (
    <div className="grid w-full grid-cols-2 gap-3">
      {(
        [
          ["on background", "bg-background"],
          ["on sidebar", "bg-sidebar"],
        ] as const
      ).map(([label, surface]) => (
        <div key={label} className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">
            {label}
          </span>
          <div className={cn("rounded-md border border-border p-3", surface)}>
            {children}
          </div>
        </div>
      ))}
    </div>
  );
}

const INTERACTIVE_STATES: readonly (readonly [string, string])[] = [
  ["rest", ""],
  ["hover", "bg-state-hover text-foreground"],
  ["active", "bg-state-active text-foreground"],
  ["selected", "bg-surface-selected border border-surface-selected-border"],
];

function StateRows() {
  return (
    <div className="flex flex-col gap-1">
      {INTERACTIVE_STATES.map(([label, cls]) => (
        <div
          key={label}
          className={cn(
            "flex items-center justify-between rounded-md px-3 py-1.5 text-xs",
            cls,
          )}
        >
          <span>List row — {label}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {cls.split(" ")[0] || "transparent"}
          </span>
        </div>
      ))}
    </div>
  );
}

function Swatch({ token, fill }: { token: string; fill: string }) {
  return (
    <div className="flex w-16 flex-col items-center gap-1">
      <div
        className={cn("h-11 w-full rounded-md border border-border", fill)}
      />
      <span className="text-center text-[10px] leading-tight text-muted-foreground">
        {token}
      </span>
    </div>
  );
}

function EmphasisChip({
  tier,
  token,
  className,
}: {
  tier: string;
  token: string;
  className: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className={cn(
          "flex h-11 w-24 items-center justify-center rounded-md text-xs font-medium",
          className,
        )}
      >
        {tier}
      </div>
      <span className="text-center text-[10px] leading-tight text-muted-foreground">
        {token}
      </span>
    </div>
  );
}

function SurfaceTag({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("text-[10px] font-medium", className)}>{children}</span>
  );
}

function SurfaceWidget() {
  return (
    <div className="flex h-44 overflow-hidden rounded-lg border border-border shadow-sm">
      <div className="flex w-36 flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground">
        <SurfaceTag className="text-sidebar-foreground">sidebar</SurfaceTag>
        <div className="rounded border border-surface-selected-border bg-surface-selected px-2 py-1 text-[10px]">
          Active item
        </div>
        <div className="rounded bg-state-hover px-2 py-1 text-[10px]">
          Hovered item
        </div>
        <div className="flex items-center justify-between px-2 py-1 text-[10px] text-muted-foreground">
          <span>Unread item</span>
          <span className={SIDEBAR_UNREAD_DOT_CLASS} />
        </div>
        <div className="px-2 py-1 text-[10px] text-muted-foreground">Item</div>
      </div>
      <div className="relative flex-1 bg-background p-3 text-foreground">
        <SurfaceTag className="text-foreground">background</SurfaceTag>
        <div className="mt-2 rounded-md border border-border bg-card p-2 text-card-foreground shadow-xs">
          <SurfaceTag className="text-card-foreground">card</SurfaceTag>
          <div className="mt-1.5 h-1.5 w-3/4 rounded-full bg-muted" />
          <div className="mt-1 h-1.5 w-1/2 rounded-full bg-secondary" />
        </div>
        <div className="absolute right-3 bottom-3 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[10px] text-popover-foreground shadow-md">
          popover
        </div>
      </div>
    </div>
  );
}

const RAMP: readonly (readonly [string, string])[] = [
  ["background", "bg-background"],
  ["sidebar", "bg-sidebar"],
  ["secondary", "bg-secondary"],
  ["accent", "bg-accent"],
  ["muted", "bg-muted"],
];

function RampBar() {
  return (
    <div className="w-full">
      <div className="flex overflow-hidden rounded-md border border-border">
        {RAMP.map(([token, cls]) => (
          <div key={token} className={cn("h-10 flex-1", cls)} />
        ))}
      </div>
      <div className="mt-1 flex">
        {RAMP.map(([token]) => (
          <span
            key={token}
            className="flex-1 text-center text-[9px] leading-tight text-muted-foreground"
          >
            {token}
          </span>
        ))}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        {title}
      </span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({ token, children }: { token: string; children: ReactNode }) {
  return (
    <div className="flex w-16 flex-col items-center gap-1">
      <div className="flex size-11 items-center justify-center rounded-md border border-border bg-background">
        {children}
      </div>
      <span className="text-center text-[10px] leading-tight text-muted-foreground">
        {token}
      </span>
    </div>
  );
}

function LineChip({ token, className }: { token: string; className: string }) {
  return (
    <Chip token={token}>
      <div
        className={cn("size-7 rounded border-2 bg-transparent", className)}
      />
    </Chip>
  );
}

function OverlayChip({
  token,
  className,
}: {
  token: string;
  className: string;
}) {
  return (
    <Chip token={token}>
      <div className={cn("size-7 rounded", className)} />
    </Chip>
  );
}

function Primitives() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="default" size="sm">
          Default
        </Button>
        <Button variant="outline" size="sm">
          Outline
        </Button>
        <Button variant="secondary" size="sm">
          Secondary
        </Button>
        <Button variant="ghost" size="sm">
          Ghost
        </Button>
        <Button variant="destructive" size="sm">
          Destructive
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Pill variant="outline">outline</Pill>
        <Pill variant="secondary">secondary</Pill>
        <Pill variant="emphasis">emphasis</Pill>
      </div>
      <Input placeholder="Input field" className="h-8 text-xs" />
      <EmptyStatePanel className="text-xs">
        Empty state placeholder
      </EmptyStatePanel>
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard labelWidth="150px">
      <StoryRow
        label="Neutral surfaces"
        hint="Card and popover sit flush with the page (elevation = border + shadow, see widget); the fill ramp below is the lift steps that remain — adjacent steps should stay distinguishable."
      >
        <DualTheme>
          <SurfaceWidget />
          <RampBar />
        </DualTheme>
      </StoryRow>

      <StoryRow
        label="Lines & overlays"
        hint="Borders are strokes; overlays are translucent (shown on a card)."
      >
        <DualTheme>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
            <Group title="Lines">
              <LineChip token="hairline" className="border-border-hairline" />
              <LineChip token="border" className="border-border" />
              <LineChip token="input" className="border-input" />
            </Group>
            <Group title="Overlays">
              <OverlayChip
                token="surface-raised"
                className="bg-surface-raised"
              />
              <OverlayChip
                token="surface-recessed"
                className="bg-surface-recessed"
              />
            </Group>
          </div>
        </DualTheme>
      </StoryRow>

      <StoryRow
        label="Interactive states"
        hint="Each should read clearly on both surfaces; selected sits a step apart."
      >
        <DualTheme>
          <OnBothSurfaces>
            <StateRows />
          </OnBothSurfaces>
        </DualTheme>
      </StoryRow>

      <StoryRow
        label="Emphasis fills"
        hint="The two solid fills used to make something stand out — a dark chip with light text in light mode, flipped in dark. foreground is the strongest (the primary button, the emphasis pill); primary is one step softer (tooltips, count badges, selected controls). The pale fills in the ramp above are the quiet opposite of these."
      >
        <DualTheme>
          <div className="flex flex-wrap gap-2">
            <EmphasisChip
              tier="strong"
              token="foreground"
              className="bg-foreground text-background"
            />
            <EmphasisChip
              tier="mid"
              token="primary"
              className="bg-primary text-primary-foreground"
            />
          </div>
        </DualTheme>
      </StoryRow>

      <StoryRow
        label="Status & accent"
        hint="The semantic palette — each should stay distinct from the others and from the neutral ramp."
      >
        <DualTheme>
          <div className="flex flex-wrap gap-2">
            <Swatch token="destructive" fill="bg-destructive" />
            <Swatch token="warning" fill="bg-warning" />
            <Swatch token="attention" fill="bg-attention" />
            <Swatch token="success" fill="bg-success" />
            <Swatch token="timeline-accent" fill="bg-timeline-accent" />
            <Swatch token="diff-added" fill="bg-diff-added" />
            <Swatch token="diff-removed" fill="bg-diff-removed" />
          </div>
        </DualTheme>
      </StoryRow>

      <StoryRow
        label="Live primitives"
        hint="Catches fills/borders that clash on a surface."
      >
        <DualTheme>
          <OnBothSurfaces>
            <Primitives />
          </OnBothSurfaces>
        </DualTheme>
      </StoryRow>
    </StoryCard>
  );
}
