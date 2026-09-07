export type AreaId = "mock" | "overlays" | "components" | "stylesheet";

export const AREA_TITLES: Record<AreaId, string> = {
  mock: "Preview",
  overlays: "Overlays",
  components: "Components",
  stylesheet: "Style sheet",
};

export const MOCK_VIEWS = [
  { id: "thread", label: "Thread", exercises: "sidebar row states + scoped overrides, held-open table-of-contents popover, bubbles on surface-recessed, seam/hairline borders, diff washes, file/timeline accents, metadata panel, verification badges, composer ring, primary send" },
  { id: "new", label: "New thread", exercises: "empty welcome hierarchy, action-row hover and focus, muted supporting copy" },
  { id: "split", label: "Split", exercises: "pane seam, focused and inactive panes, background scrim, two distinct transcripts" },
  { id: "settings", label: "Settings", exercises: "settings navigation selection, appearance section card, responsive label and description hierarchy, outline controls, active theme and mode, switch" },
] as const;

export const COLOR_GROUPS = [
  {
    id: "surfaces",
    title: "Surfaces",
    band: "palette",
    contrast: "none",
    tokens: ["canvas", "sidebar", "card", "popover", "secondary", "muted", "surface-recessed-solid", "surface-scrim"],
  },
  {
    id: "ink",
    title: "Ink",
    band: "palette",
    contrast: "vs-surface",
    tokens: ["ink", "foreground", "muted-foreground", "subtle-foreground", "readback-foreground", "sidebar-foreground"],
  },
  {
    id: "accent",
    title: "Accent",
    band: "palette",
    contrast: "none",
    tokens: ["primary", "file-accent", "timeline-accent", "surface-selected", "state-hover", "state-active"],
  },
  {
    id: "status",
    title: "Status",
    band: "palette",
    contrast: "as-painted",
    tokens: ["success", "warning", "attention", "destructive", "pr-merged", "diff-added", "diff-removed"],
  },
  {
    id: "lines",
    title: "Lines",
    band: "foundation",
    contrast: "none",
    tokens: ["border", "border-hairline", "border-seam", "sidebar-border", "input", "ring"],
  },
] as const;

export const TYPE_SPECIMENS = [
  { id: "font-sans", title: "Sans", token: "font-sans" },
  { id: "font-mono", title: "Mono", token: "font-mono" },
  { id: "text-scale", title: "Text size", token: "text-sm" },
  { id: "line-height", title: "Line height", token: "text-sm--line-height" },
] as const;

export const RHYTHM_SPECIMENS = [
  { id: "density", title: "Density", token: "spacing", unit: "px" },
  { id: "tracking", title: "Tracking", token: "tracking-normal", unit: "em" },
  { id: "row-height", title: "Sidebar row", token: "bb-sidebar-row-height", unit: "px" },
  { id: "icon-stroke", title: "Icon stroke", token: "icon-stroke-width", unit: "" },
] as const;

export const RADIUS_SPECIMENS = [
  { id: "radius", title: "Base", source: "var(--radius)" },
  { id: "radius-sm", title: "Small", source: "calc(var(--radius) - 4px)" },
  { id: "radius-md", title: "Medium", source: "calc(var(--radius) - 2px)" },
  { id: "radius-lg", title: "Large", source: "var(--radius)" },
  { id: "radius-xl", title: "Extra large", source: "calc(var(--radius) + 4px)" },
] as const;

export const SHADOW_SPECIMENS = [
  { id: "y", title: "Y", token: "shadow-y" },
  { id: "blur", title: "Blur", token: "shadow-blur" },
  { id: "x", title: "X", token: "shadow-x" },
  { id: "spread", title: "Spread", token: "shadow-spread" },
  { id: "color", title: "Color", token: "tp-shadow-color" },
  { id: "opacity", title: "Opacity", token: "tp-shadow-opacity-percent" },
] as const;

export const COMPONENT_SPECIMENS = [
  { id: "buttons", title: "Buttons", vendored: "@bb/shared-ui/button" },
  { id: "badges", title: "Badges", vendored: "@bb/shared-ui/badge" },
  { id: "inputs", title: "Inputs", vendored: "@bb/shared-ui/input" },
  { id: "switch", title: "Switch", vendored: "@bb/shared-ui/switch" },
  { id: "checkbox", title: "Checkbox", vendored: "@bb/shared-ui/checkbox" },
] as const;

export const OVERLAY_SPECIMENS = [
  { id: "menu", label: "Menu", vendored: "@bb/shared-ui/dropdown-menu" },
  { id: "dialog", label: "Dialog", vendored: "@bb/shared-ui/dialog" },
  { id: "popover", label: "Popover", vendored: "@bb/shared-ui/popover" },
  { id: "tooltip", label: "Tooltip", vendored: "@bb/shared-ui/tooltip" },
  { id: "hover-card", label: "Hover card", vendored: "@bb/shared-ui/hover-card" },
  { id: "toast", label: "Toast", vendored: "sonner via the app-mounted Toaster" },
] as const;

export const STYLESHEET_SPECIMEN_IDS: readonly string[] = [
  ...COLOR_GROUPS.flatMap((group) => group.tokens.map((token) => `color:${token}`)),
  ...TYPE_SPECIMENS.map((specimen) => `type:${specimen.id}`),
  ...RHYTHM_SPECIMENS.map((specimen) => `rhythm:${specimen.id}`),
  ...RADIUS_SPECIMENS.map((specimen) => `radius:${specimen.id}`),
  ...SHADOW_SPECIMENS.map((specimen) => `shadow:${specimen.id}`),
];
