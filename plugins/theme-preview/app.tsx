import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Badge as BbBadge } from "@bb/shared-ui/badge";
import { Button as BbButton } from "@bb/shared-ui/button";
import { Checkbox as BbCheckbox } from "@bb/shared-ui/checkbox";
import { CHROME_SECTION_LABEL_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import {
  COARSE_POINTER_ICON_SIZE_CLASS,
  COARSE_POINTER_ROW_HEIGHT_CLASS,
} from "@bb/shared-ui/coarse-pointer-sizing";
import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@bb/shared-ui/hover-card";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { Input as BbInput } from "@bb/shared-ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@bb/shared-ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@bb/shared-ui/select";
import { Switch as BbSwitch } from "@bb/shared-ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bb/shared-ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import { cn } from "@bb/shared-ui/lib/utils";
import { toast } from "sonner";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { rpcContract } from "./server";
import {
  contentInsetForWidth,
  SURFACE_RAIL_WIDTH,
  frameCompositionForWidth,
  frameHeightForWidth,
  INFO_PANEL_WIDTH,
  layoutBandForWidth,
  SIDEBAR_WIDTH,
  surfaceRailWidth,
  type FrameComposition,
  type LayoutBand,
} from "./responsive-layout";
import { LatestRequest, contrastRatio } from "./theme-utils";
import {
  AREA_TITLES,
  COLOR_GROUPS,
  MOCK_VIEWS,
  RADIUS_SPECIMENS,
  RHYTHM_SPECIMENS,
  SHADOW_SPECIMENS,
  TYPE_SPECIMENS,
} from "./taxonomy";

// ---------------------------------------------------------------------------
// Everything reads the theme's CSS custom properties directly, and the mock
// mirrors what bb actually paints: surfaces, radii and borders were measured
// off the running app rather than invented, so a palette fails here the same
// way it fails there. Decoration bb's theme does not touch — icons, window
// chrome, nav lists — is left out on purpose.
// ---------------------------------------------------------------------------

const v = (name: string, fallback?: string): string =>
  fallback === undefined ? `var(--${name})` : `var(--${name}, ${fallback})`;
const SANS = v("font-sans", "ui-sans-serif, system-ui, sans-serif");
const MONO = v("font-mono", "ui-monospace, SFMono-Regular, Menlo, monospace");
const space = (units: number): string => `calc(var(--spacing, 0.25rem) * ${units})`;
const RADIUS_MD = v("radius-md", "calc(var(--radius, 0.5rem) - 2px)");
const RADIUS_LG = v("radius-lg", v("radius", "0.5rem"));

// Measured off the running app: composer and messages 16px, code blocks 10px.
const R_BUBBLE = 16;
const R_BLOCK = 10;

// The mock views come from the taxonomy so the toggle, the renderer, and the
// coverage test share one inventory.
const VIEWS = MOCK_VIEWS.map((view) => view.id);
type View = (typeof MOCK_VIEWS)[number]["id"];
const VIEW_LABEL = Object.fromEntries(MOCK_VIEWS.map((view) => [view.id, view.label])) as Record<View, string>;
const STUDIO_MAX_WIDTH = 1600;
// Anchor scrolling must clear the sticky header, or an area's heading lands
// underneath it. The offset is measured from the header itself (it wraps to
// two rows on the mobile band), never authored.
const CLIENT_RPC_TIMEOUT_MS = 20_000;

function withRpcTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${CLIENT_RPC_TIMEOUT_MS / 1000} seconds`)),
      CLIENT_RPC_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

type Mode = "light" | "dark";
type ThemeSelection = { themeId: string; mode: Mode };

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return <span style={{ display: "inline-block", width: size, height: size, borderRadius: 999, background: color, flex: "none" }} />;
}

function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: v("muted-foreground"), ...style }}>
      {children}
    </div>
  );
}

type Tone = "outline" | "primary" | "secondary" | "success" | "warning" | "destructive" | "merged";
function Badge({ children, tone = "outline" }: { children: ReactNode; tone?: Tone }) {
  const tones: Record<Tone, string> = {
    outline: "border-border text-foreground",
    primary: "border-transparent bg-primary text-primary-foreground",
    secondary: "border-transparent bg-secondary text-secondary-foreground",
    success: "border-transparent bg-success/15 text-success",
    warning: "border-transparent bg-warning/15 text-warning-text",
    destructive: "border-transparent bg-destructive/15 text-destructive-text",
    merged: "border-transparent bg-pr-merged/15 text-pr-merged",
  };
  return (
    <BbBadge
      variant="outline"
      className={cn("h-5 gap-1 whitespace-nowrap px-1.5 py-0 text-[11px] font-medium", tones[tone])}
    >
      {children}
    </BbBadge>
  );
}

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
function Button({ children, variant = "default", size = "md", disabled = false }: { children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; disabled?: boolean }) {
  return (
    <BbButton asChild variant={variant} size={size === "sm" ? "sm" : "default"}>
      <span aria-disabled={disabled || undefined} className={cn("pointer-events-none", disabled && "opacity-50")}>{children}</span>
    </BbButton>
  );
}

function Switch({ on }: { on: boolean }) {
  return <BbSwitch checked={on} tabIndex={-1} aria-hidden className="pointer-events-none" />;
}

function TextInput({ focused = false, value, placeholder, width = 190 }: { focused?: boolean; value?: string; placeholder?: string; width?: number }) {
  return (
    <BbInput
      readOnly
      tabIndex={-1}
      value={value ?? ""}
      placeholder={placeholder}
      style={{ width }}
      className={cn("pointer-events-none", focused && "ring-1 ring-ring")}
    />
  );
}

// ---------------------------------------------------------------------------
// Sidebar. Carries bb's real `fixed bg-sidebar` classes so any theme block
// scoped to that selector (token overrides, the noise overlay) applies here
// exactly as it does in the app.
// ---------------------------------------------------------------------------

const sidebarScope: CSSProperties = { position: "relative", inset: "auto", zIndex: "auto" };

// From bb's sidebarRowClasses.ts: hover paints bg-sidebar-accent with
// sidebar-accent-foreground text; the open thread's row paints bg-state-active
// (CONTEXT_SELECTION_SURFACE_CLASS); open-in-split resolves sidebar-accent 50%
// against the sidebar unless the theme overrides the variable.
type RowState = "rest" | "hover" | "selected" | "split";
const MOCK_SIDEBAR_ROW_CLASS = cn(COARSE_POINTER_ROW_HEIGHT_CLASS, "w-full min-w-0 justify-start gap-2 overflow-hidden rounded-md px-2 text-sm font-normal text-sidebar-foreground/85 ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 dark:text-sidebar-foreground");

function MockSidebarPanel({ children, side = "left", width = SIDEBAR_WIDTH, scoped = true, dataAttribute }: { children: ReactNode; side?: "left" | "right"; width?: number; scoped?: boolean; dataAttribute?: string }) {
  return (
    <aside
      className={cn(scoped && "fixed", "bg-sidebar flex min-h-0 shrink-0 flex-col text-sidebar-foreground", side === "left" ? "border-r border-border-seam" : "border-l border-border-seam")}
      data-tp-mock-sidebar={dataAttribute ?? side}
      style={{ ...sidebarScope, width, fontFamily: SANS }}
    >
      {children}
    </aside>
  );
}

function MockSidebarLabel({ children, roomy = false }: { children: ReactNode; roomy?: boolean }) {
  return <div className={cn(CHROME_SECTION_LABEL_CLASS, "pl-2", roomy ? "mt-3" : "mt-1")}>{children}</div>;
}

function MockSidebarRow({ label, state = "rest", dot, icon, interactive = false }: { label: string; state?: RowState; dot?: "unread" | "status"; icon?: IconName; interactive?: boolean }) {
  const content = (
    <>
      {icon ? <Icon name={icon} className={cn(COARSE_POINTER_ICON_SIZE_CLASS, "shrink-0 text-subtle-foreground")} /> : null}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {dot === "unread" ? <Dot color={v("foreground")} size={5} /> : dot === "status" ? <Dot color={`color-mix(in oklab, ${v("muted-foreground")} 60%, transparent)`} size={5} /> : null}
    </>
  );
  const className = cn(
    MOCK_SIDEBAR_ROW_CLASS,
    state === "hover" && "bg-sidebar-accent text-sidebar-accent-foreground",
    state === "selected" && "bb-sidebar-selected-row bg-state-active text-sidebar-foreground",
    state === "split" && "bb-sidebar-open-in-split-row",
  );
  if (interactive) {
    return <BbButton type="button" size="sm" variant="ghost" aria-current={state === "selected" ? "page" : undefined} data-tp-sidebar-row="" data-tp-sidebar-state={state} className={className}>{content}</BbButton>;
  }
  return <BbButton asChild size="sm" variant="ghost" className={cn(className, "pointer-events-none cursor-default")}><div data-tp-sidebar-row="" data-tp-sidebar-state={state}>{content}</div></BbButton>;
}

function Sidebar({ selected, split, hover }: { selected?: boolean; split?: boolean; hover?: boolean }) {
  return (
    <MockSidebarPanel>
      <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <div className="flex h-8 items-center px-2 text-sm font-semibold">bb-plugins</div>
        <MockSidebarRow label="New thread" />
        <MockSidebarLabel>Today</MockSidebarLabel>
        <MockSidebarRow label="Endless theme family — blacklight" state={selected ? "selected" : "rest"} dot="unread" />
        <MockSidebarRow label="Specimen sheets + social grid" state={split ? "split" : "rest"} dot="status" />
        <MockSidebarRow label="theme-preview plugin" state={hover ? "hover" : "rest"} />
        <MockSidebarRow label="Crit: endless-color light foil" dot="unread" />
        <MockSidebarLabel roomy>Yesterday</MockSidebarLabel>
        <MockSidebarRow label="Fix pink split row (oklch mix)" dot="status" />
        <MockSidebarRow label="Hue census battery" />
      </div>
    </MockSidebarPanel>
  );
}

// ---------------------------------------------------------------------------
// Thread. Surfaces measured off the running app: the composer sits on the
// canvas with a 1px border (not on --card), and messages and code blocks are
// the faintest recessed wash with a seam border.
// ---------------------------------------------------------------------------

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div style={{ alignSelf: "flex-end", maxWidth: "70%", background: v("surface-recessed", "rgba(127,127,127,.05)"), boxShadow: `inset 0 0 0 1px ${v("border-seam", v("border"))}`, borderRadius: R_BUBBLE, padding: "10px 14px" }}>
      {children}
    </div>
  );
}

function CodeBlock() {
  const line = (text: string, kind?: "add" | "del") => (
    <div key={text} style={{ padding: "0 12px", whiteSpace: "pre", background: kind === "add" ? `color-mix(in srgb, ${v("diff-added")} 18%, transparent)` : kind === "del" ? `color-mix(in srgb, ${v("diff-removed")} 18%, transparent)` : undefined }}>
      {text}
    </div>
  );
  return (
    <div style={{ borderRadius: R_BLOCK, overflow: "hidden", boxShadow: `inset 0 0 0 1px ${v("border-seam", v("border"))}`, fontFamily: MONO, fontSize: 12, lineHeight: "19px", color: v("foreground"), padding: "8px 0" }}>
      <div style={{ padding: "0 12px 6px", fontSize: 11, display: "flex", gap: 8, color: v("muted-foreground") }}>
        <span style={{ color: v("file-accent", v("muted-foreground")) }}>themes/endless-color.css</span><span>+2 −1</span>
      </div>
      {line("  .dark .fixed.bg-sidebar {")}
      {line("-   --sidebar: #1d1d1d;", "del")}
      {line("+   --sidebar: #070707;", "add")}
      {line("  }")}
    </div>
  );
}

function Composer({ focused = false, text }: { focused?: boolean; text?: string }) {
  return (
    <div
      style={{
        borderRadius: R_BUBBLE, background: v("background", v("canvas")), padding: "12px 12px 10px", display: "flex", flexDirection: "column", gap: 12,
        boxShadow: focused
          ? `inset 0 0 0 1px ${v("ring")}, 0 0 0 3px color-mix(in srgb, ${v("ring")} 25%, transparent)`
          : `inset 0 0 0 1px ${v("border")}`,
      }}
    >
      <div style={{ fontSize: 13.5, color: text ? v("foreground") : v("muted-foreground"), minHeight: 20 }}>{text ?? "Ask for a follow-up."}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, color: v("muted-foreground") }}>claude-fable-5</span>
        <div style={{ flex: 1 }} />
        <div style={{ width: 26, height: 26, borderRadius: 8, background: text ? v("primary") : v("muted"), color: text ? v("primary-foreground") : v("muted-foreground"), display: "grid", placeItems: "center", fontSize: 12 }}>↑</div>
      </div>
    </div>
  );
}

function VerificationCard() {
  const rows: ReadonlyArray<[string, string, Tone]> = [
    ["Theme tokens", "28 resolved", "success"],
    ["Base contrast", "AA passed", "success"],
    ["Reference sheet", "Updated", "secondary"],
  ];
  return (
    <div style={{ borderRadius: R_BLOCK, background: v("surface-recessed", "rgba(127,127,127,.05)"), boxShadow: `inset 0 0 0 1px ${v("border-seam", v("border"))}`, padding: "10px 12px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Verification summary</div>
      {rows.map(([label, value, tone]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 25, borderTop: `1px solid ${v("border-hairline", v("border"))}` }}>
          <span style={{ flex: 1, color: v("muted-foreground") }}>{label}</span>
          <Badge tone={tone}>{value}</Badge>
        </div>
      ))}
    </div>
  );
}

const TOC_MESSAGES = {
  agent: [
    "Three blacks were fragmenting the frame.",
    "Selection now reads rgba(47,180,255,.20).",
    "Tightened the raised surfaces and kept the seams neutral.",
  ],
  you: [
    "Make the blacklight variant feel like the reference.",
    "Match the selection blue to the glove.",
    "Keep the hierarchy calm.",
  ],
} as const;

/** A compact projection of bb's real thread ToC popover, held open so every
 * theme can be judged against the same transient surface. */
function ThreadTocFixture() {
  const [tab, setTab] = useState<keyof typeof TOC_MESSAGES>("you");
  const [active, setActive] = useState(0);
  const messages = TOC_MESSAGES[tab];
  return (
    <aside
      data-tp-thread-toc=""
      aria-label="Thread table of contents"
      style={{ position: "absolute", zIndex: 6, top: 54, right: 9, width: "min(250px, calc(100% - 34px))", display: "flex", alignItems: "flex-start", pointerEvents: "auto" }}
    >
      <div style={{ minWidth: 0, flex: 1, borderRadius: RADIUS_LG, border: `1px solid ${v("border")}`, background: v("popover"), boxShadow: v("shadow-lg"), padding: 4 }}>
        <Tabs value={tab} onValueChange={(next) => {
          if (next !== "agent" && next !== "you") return;
          setTab(next);
          setActive(0);
        }}>
          <TabsList aria-label="Table of contents messages" className="h-7 w-full justify-start p-0.5">
            <TabsTrigger value="agent" className="h-6 flex-1 cursor-pointer px-2 text-xs">Agent</TabsTrigger>
            <TabsTrigger value="you" className="h-6 flex-1 cursor-pointer px-2 text-xs">You</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 3 }}>
            {messages.map((message, index) => (
              <BbButton
                key={message}
                variant="ghost"
                size="sm"
                aria-current={active === index ? "true" : undefined}
                className={cn("h-auto min-h-7 w-full cursor-pointer justify-start whitespace-normal px-2 py-1 text-left text-xs font-normal leading-snug", active === index && "bg-state-hover text-foreground")}
                onClick={() => setActive(index)}
              >
                <span style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}>{message}</span>
              </BbButton>
            ))}
          </TabsContent>
        </Tabs>
      </div>
      <div aria-hidden style={{ width: 22, padding: "8px 0 0 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
        {messages.map((_, index) => <span key={index} style={{ width: active === index ? 14 : 8, height: 3, borderRadius: 999, background: active === index ? `color-mix(in oklab, ${v("foreground")} 70%, transparent)` : `color-mix(in oklab, ${v("foreground")} 20%, transparent)` }} />)}
      </div>
    </aside>
  );
}

const NEW_THREAD_ACTIONS = [
  { icon: "MessageSquarePlus", title: "New thread", description: "Start a new conversation" },
  { icon: "FolderGit", title: "Automatically import my projects", description: "Find repos touched in the last 30 days" },
  { icon: "FolderPlus", title: "New project", description: "Create one from a local folder" },
  { icon: "Explore", title: "Learn what bb can do", description: "Get a tour of its capabilities" },
] as const;

function Thread({ title = "Endless theme family — blacklight pass", active = true, narrow = false, brief = false, empty = false, showToc = false, story = "blacklight" }: { title?: string; active?: boolean; narrow?: boolean; brief?: boolean; empty?: boolean; showToc?: boolean; story?: "blacklight" | "specimen" }) {
  const pad = narrow ? 20 : 30;
  const canvasColor = v("canvas", v("background"));
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, background: v("canvas", v("background")), color: v("foreground"), display: "flex", flexDirection: "column", fontFamily: SANS, position: "relative" }}>
      {empty ? (
        <div data-tp-new-welcome="" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: narrow ? 22 : 34, padding: `0 ${pad}px` }}>
          <div role="img" aria-label="bb" style={{ fontSize: narrow ? 28 : 34, lineHeight: 1, fontWeight: 700, letterSpacing: "-0.08em", color: v("foreground") }}>bb</div>
          <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 4 }}>
            {NEW_THREAD_ACTIONS.map((action) => (
              <BbButton key={action.title} type="button" variant="ghost" className="h-auto w-full cursor-pointer justify-start gap-3 px-3 py-2.5 text-left">
                <Icon name={action.icon} className="size-5 shrink-0 text-subtle-foreground" />
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: v("foreground") }}>{action.title}</span>
                  <span style={{ fontSize: 12, color: v("muted-foreground") }}>{action.description}</span>
                </span>
              </BbButton>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div style={{ height: 48, display: "flex", alignItems: "center", gap: 10, padding: `0 ${pad}px`, flex: "none", position: "relative" }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{title}</span>
            <Badge tone="success"><Dot color={v("success")} size={6} /> Running</Badge>
            {narrow ? null : <Badge tone="outline">bb/endless-theme-plugin</Badge>}
          </div>
          {showToc ? <ThreadTocFixture /> : null}
          {/* Anchored at the bottom like a scrolled thread: messages keep their
              natural size and the oldest clip off the top, never squash. The
              scrim makes the cut read as scrolled-away rather than broken. */}
          <div style={{ flex: 1, overflow: "hidden", position: "relative", padding: `0 ${pad}px`, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
          <div aria-hidden style={{ position: "absolute", top: 0, left: 0, right: 0, height: 28, zIndex: 1, pointerEvents: "none", background: `linear-gradient(to bottom, ${canvasColor}, color-mix(in oklab, ${canvasColor} 0%, transparent))` }} />
          {story === "specimen" ? (
            <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 16, fontSize: 13.5, lineHeight: "21px", paddingTop: 22 }}>
              <Bubble>lay the specimen sheet out as a grid — one tile per token family, social crop last.</Bubble>
              <div>
                Laid out six tiles: surfaces, ink, accents, status, lines, type. Each sits on{" "}
                <code style={{ fontFamily: MONO, fontSize: "0.92em", fontWeight: 600, background: v("surface-recessed"), padding: "1px 5px", borderRadius: 4 }}>--card</code>{" "}
                with a seam border, so the sheet reads in both modes without retinting.
              </div>
              <div style={{ color: v("muted-foreground"), fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 1, height: 18, background: v("timeline-accent", v("border")) }} />
                15:04 · <span style={{ color: v("file-accent", v("muted-foreground")), fontFamily: MONO }}>sheets/specimen-grid.css</span>
              </div>
              <Bubble>good — export the 1200×675 crop for the announcement.</Bubble>
            </div>
          ) : (
          <div style={{ flex: "none", display: "flex", flexDirection: "column", gap: 16, fontSize: 13.5, lineHeight: "21px", paddingTop: 22 }}>
            <Bubble>make the blacklight variant feel like the reference — neon orange seam, blue selection, calm UV canvas.</Bubble>
            <div>
              Three blacks were fragmenting the frame. The base theme's{" "}
              <code style={{ fontFamily: MONO, fontSize: "0.92em", fontWeight: 600, background: v("surface-recessed"), padding: "1px 5px", borderRadius: 4 }}>.fixed.bg-sidebar</code>{" "}
              block was overriding the variant's sidebar tokens, so it rendered <span style={{ fontFamily: MONO, fontSize: "0.92em" }}>#1d1d1d</span> instead of true black.
            </div>
            <CodeBlock />
            {brief ? null : (
              <>
                <div style={{ color: v("muted-foreground"), fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 1, height: 18, background: v("timeline-accent", v("border")) }} />
                  14:02 · <span style={{ color: v("file-accent", v("muted-foreground")), fontFamily: MONO }}>themes/endless-color.css</span>
                </div>
                <Bubble>looks right — now match the selection blue to the glove.</Bubble>
                <div>
                  Done. Selection now reads <span style={{ fontFamily: MONO, fontSize: "0.92em" }}>rgba(47,180,255,.20)</span> over the canvas, and file paths pick up the
                  glove's steel blue — <span style={{ color: v("file-accent", v("muted-foreground")), fontFamily: MONO, fontSize: "0.92em" }}>build-color.py</span> shows it inline.
                  <span data-tp-selection="sample" style={{ background: v("selection-color-default", v("surface-selected")), color: v("foreground"), borderRadius: 3, padding: "0 3px", WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone" }}> Selected text stays readable.</span>
                </div>
                <div style={{ color: v("muted-foreground"), fontSize: 12.5, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 1, height: 18, background: v("timeline-accent", v("border")) }} />
                  14:18 · checks completed
                </div>
                <VerificationCard />
                <Bubble>keep the hierarchy calm — orange should guide the eye, not fill the room.</Bubble>
                <div>
                  Tightened the raised surfaces and kept the content seams neutral. The sidebar edge is the only persistent orange line; focus and selection stay blue, so the two signals never compete.
                </div>
              </>
            )}
          </div>
          )}
          </div>
          <div style={{ padding: `12px ${pad}px 18px`, flex: "none" }}><Composer focused={active} /></div>
        </>
      )}
    </div>
  );
}

function InfoPanel() {
  const kv = (k: string, val: ReactNode) => (
    <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12.5, height: 28 }}>
      <span style={{ color: v("muted-foreground") }}>{k}</span>
      <span style={{ color: v("foreground"), textAlign: "right", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{val}</span>
    </div>
  );
  return (
    <MockSidebarPanel side="right" width={INFO_PANEL_WIDTH} scoped={false} dataAttribute="right">
      <div data-tp-thread-info="" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-3 px-4 text-xs">
          {["Info", "Diff"].map((t, i) => (
            <span key={t} className={cn(i === 0 ? "font-semibold text-foreground" : "font-normal text-muted-foreground")}>{t}</span>
          ))}
        </div>
        <div className="flex flex-col gap-3.5 px-4 py-3.5">
          <div>
            {kv("Environment", "Worktree")}
            {kv("Directory", <span style={{ fontFamily: MONO, fontSize: 12 }}>~/Code/bb</span>)}
            {kv("Branch", <span style={{ fontFamily: MONO, fontSize: 12 }}>bb/endless-theme</span>)}
            {kv("Compare to", <span style={{ fontFamily: MONO, fontSize: 12 }}>main</span>)}
            {kv("Status", <Badge tone="success">Clean</Badge>)}
            {kv("Pull request", <Badge tone="merged">Merged #42</Badge>)}
          </div>
          <div>
            <Eyebrow style={{ marginBottom: 4 }}>Files</Eyebrow>
            {["themes/endless-color.css", "build-color.py"].map((f) => (
              <div key={f} style={{ height: 24, fontSize: 12.5, fontFamily: MONO, color: v("file-accent", v("foreground")), overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{f}</div>
            ))}
          </div>
          <div style={{ borderRadius: R_BLOCK, background: v("surface-recessed-soft-solid", v("card")), boxShadow: `inset 0 0 0 1px ${v("border-hairline", v("border"))}`, padding: "10px 12px", fontSize: 12.5, color: v("readback-foreground", v("muted-foreground")), lineHeight: "18px" }}>
            Sidebar reads true black with the orange seam; blue selection at .20.
          </div>
        </div>
      </div>
    </MockSidebarPanel>
  );
}

function SettingsPage({ narrow = false, themeName, mode }: { narrow?: boolean; themeName: string; mode: Mode }) {
  const control = (label: string, value: ReactNode) => (
    <BbButton type="button" variant="outline" size="sm" aria-label={label} className="h-7 w-full min-w-0 cursor-pointer justify-between border-border/60 bg-card px-2 text-xs sm:w-36">
      <span style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{value}</span>
      <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
    </BbButton>
  );
  const row = (label: string, description: string | null, child: ReactNode) => (
    <div key={label} style={{ display: "flex", flexDirection: narrow ? "column" : "row", alignItems: narrow ? "stretch" : description ? "flex-start" : "center", justifyContent: "space-between", gap: narrow ? 10 : 20 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, lineHeight: "20px", color: v("foreground") }}>{label}</div>
        {description ? <div style={{ marginTop: 2, fontSize: 12, lineHeight: "16px", color: `color-mix(in oklab, ${v("subtle-foreground", v("muted-foreground"))} 75%, transparent)` }}>{description}</div> : null}
      </div>
      <div style={{ flex: "none", display: "flex", justifyContent: narrow ? "stretch" : "flex-end" }}>{child}</div>
    </div>
  );
  return (
    <div data-tp-settings-content="appearance" style={{ flex: 1, minWidth: 0, minHeight: 0, background: v("canvas", v("background")), color: v("foreground"), fontFamily: SANS, overflow: "auto" }}>
      <div style={{ width: "100%", maxWidth: 768, margin: "0 auto", padding: narrow ? "22px 16px" : "26px 28px", boxSizing: "border-box" }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 13, lineHeight: "20px", fontWeight: 600 }}>Appearance</h2>
          <div style={{ borderRadius: RADIUS_LG, border: `1px solid ${v("border")}`, background: v("card"), padding: "14px 16px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {row("Theme", null, control("Theme", mode === "light" ? "Light" : "Dark"))}
              {row("Palette", "Palettes change bb's colors, including syntax colors in diffs and file previews. Choose a built-in palette or create one from a prompt.", control("Palette", themeName))}
              {row("Favicon color", "Tint browser tabs to tell instances apart.", control("Favicon color", <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: v("foreground") }} />Default</span>))}
              {row("Fade inactive splits", "Fade out splits that do not have focus.", <BbSwitch checked aria-label="Fade inactive splits" />)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const SETTINGS_NAV_ITEMS = [
  { icon: "Settings", label: "General" },
  { icon: "Bot", label: "Providers" },
  { icon: "Palette", label: "Appearance" },
  { icon: "SlidersHorizontal", label: "Keyboard" },
  { icon: "ChartColumn", label: "Usage limits" },
  { icon: "Folder", label: "Files" },
  { icon: "Laptop", label: "Machines" },
] as const;

function SettingsSidebarFixture() {
  return (
    <MockSidebarPanel dataAttribute="settings">
      <div data-tp-settings-sidebar="" className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 py-2">
        <MockSidebarRow label="Back to app" icon="ChevronLeft" interactive />
        <MockSidebarLabel roomy>Settings</MockSidebarLabel>
        <div className="mt-1 flex flex-col gap-0.5">
          {SETTINGS_NAV_ITEMS.map((item) => (
            <MockSidebarRow key={item.label} label={item.label} icon={item.icon} state={item.label === "Appearance" ? "selected" : "rest"} interactive />
          ))}
        </div>
      </div>
    </MockSidebarPanel>
  );
}

function SplitPaneFixture({ focused, children }: { focused: boolean; children: ReactNode }) {
  return (
    <div data-tp-split-pane="" data-focused={focused ? "true" : "false"} style={{ position: "relative", display: "flex", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {children}
      <div data-pane-focus-scrim="" aria-hidden style={{ pointerEvents: "none", position: "absolute", inset: 0, zIndex: 20, background: focused ? "transparent" : `color-mix(in oklab, ${v("background", v("canvas"))} 30%, transparent)` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The frame. A fluid mock of a bb window: components keep their natural
// sizes, and panels join or leave the composition with width exactly the way
// bb's own responsive layout behaves. Nothing here is scaled or zoomed.
// ---------------------------------------------------------------------------

function FrameView({ view, composition, themeName, mode }: { view: View; composition: FrameComposition; themeName: string; mode: Mode }) {
  const { sidebar, infoPanel, splitColumns, narrow } = composition;
  switch (view) {
    case "thread":
      return (
        <>
          {sidebar ? <Sidebar selected /> : null}
          <Thread narrow={narrow} showToc />
          {infoPanel ? <InfoPanel /> : null}
        </>
      );
    case "new":
      return (
        <>
          {sidebar ? <Sidebar hover /> : null}
          <Thread empty narrow={narrow} />
        </>
      );
    case "split":
      return (
        <>
          {sidebar ? <Sidebar selected split /> : null}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: splitColumns ? "row" : "column" }}>
            <SplitPaneFixture focused><Thread narrow brief={!splitColumns} /></SplitPaneFixture>
            <div style={{ flex: "none", alignSelf: "stretch", width: splitColumns ? 1 : undefined, height: splitColumns ? undefined : 1, background: v("border-seam-vertical", v("border-seam", v("border"))) }} />
            <SplitPaneFixture focused={false}><Thread title="Specimen sheets + social grid" active={false} narrow brief={!splitColumns} story="specimen" /></SplitPaneFixture>
          </div>
        </>
      );
    case "settings":
      return (
        <>
          {sidebar ? <SettingsSidebarFixture /> : null}
          <SettingsPage narrow={narrow} themeName={themeName} mode={mode} />
        </>
      );
  }
}

function Frame({ view, themeName, mode }: { view: View; themeName: string; mode: Mode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={hostRef} style={{ minWidth: 0 }}>
      {width > 0 ? (
        <div
          data-tp-frame=""
          style={{
            width: "100%", height: frameHeightForWidth(width), display: "flex", overflow: "hidden", borderRadius: 12, position: "relative", boxSizing: "border-box",
            boxShadow: v("shadow-lg", "0 10px 30px rgba(0,0,0,.25)"), background: v("canvas", v("background")),
          }}
        >
          <FrameView view={view} composition={frameCompositionForWidth(width)} themeName={themeName} mode={mode} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
const ALL_TOKENS = [
  ...COLOR_GROUPS.flatMap((group) => group.tokens),
  "warning-text", "destructive-text",
  "font-sans", "font-mono", "text-sm", "text-sm--line-height",
  "spacing", "tracking-normal", "bb-sidebar-row-height", "icon-stroke-width",
  "radius", "radius-sm", "radius-md", "radius-lg", "radius-xl",
  "shadow-x", "shadow-y", "shadow-blur", "shadow-spread",
  "shadow-color", "shadow-opacity", "tp-shadow-color", "tp-shadow-opacity-percent",
];

type ContrastSpec = { fgToken: string; fgFallbackToken?: string; washToken: string; washAlpha: number };
const STATUS_CONTRAST: Record<string, ContrastSpec> = {
  success: { fgToken: "success", washToken: "success", washAlpha: 0.15 },
  warning: { fgToken: "warning-text", fgFallbackToken: "warning", washToken: "warning", washAlpha: 0.15 },
  attention: { fgToken: "attention", washToken: "attention", washAlpha: 0.15 },
  destructive: { fgToken: "destructive-text", fgFallbackToken: "destructive", washToken: "destructive", washAlpha: 0.15 },
  "pr-merged": { fgToken: "pr-merged", washToken: "pr-merged", washAlpha: 0.15 },
  "diff-added": { fgToken: "foreground", washToken: "diff-added", washAlpha: 0.18 },
  "diff-removed": { fgToken: "foreground", washToken: "diff-removed", washAlpha: 0.18 },
};

function atAlpha(rgb: string, alpha: number): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!match) return rgb;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

type Computed = Record<string, { value: string; hex: string; rgb: string; sidebar: string | null }>;

function resolveColor(color: string): { rgb: string; hex: string } {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  const hexMatch = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  let channels: readonly number[] | null = null;
  if (match) {
    channels = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
  } else if (hexMatch) {
    channels = [
      Number.parseInt(hexMatch[1].slice(0, 2), 16),
      Number.parseInt(hexMatch[1].slice(2, 4), 16),
      Number.parseInt(hexMatch[1].slice(4, 6), 16),
      hexMatch[2] ? Number.parseInt(hexMatch[2], 16) / 255 : 1,
    ];
  } else if (color) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      channels = [r, g, b, a / 255];
    }
  }
  if (!channels || channels.length < 3 || channels.some((channel) => !Number.isFinite(channel))) return { rgb: "", hex: "—" };
  const [r, g, b, a] = channels;
  const rounded = [r, g, b].map((channel) => Math.round(channel));
  const baseHex = `#${rounded.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const alpha = a === undefined ? 1 : a;
  return {
    rgb: alpha < 1 ? `rgba(${rounded.join(", ")}, ${alpha})` : `rgb(${rounded.join(", ")})`,
    hex: alpha < 1 ? `${baseHex} ${Math.round(alpha * 100)}%` : baseHex,
  };
}

function useComputedTokens(names: readonly string[], revision: string): Computed {
  const [out, setOut] = useState<Computed>({});
  const acceptedFingerprint = useRef<string | null>(null);
  useEffect(() => {
    const previousFingerprint = acceptedFingerprint.current;
    const deadline = Date.now() + 4_000;
    let candidateFingerprint: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const rootStyle = getComputedStyle(document.documentElement);
      const values = names.map((name) => rootStyle.getPropertyValue(`--${name}`).trim());
      const fingerprint = values.join("\u0001");
      if (previousFingerprint !== null && Date.now() < deadline) {
        if (fingerprint === previousFingerprint) {
          candidateFingerprint = null;
          timer = setTimeout(read, 100);
          return;
        }
        if (candidateFingerprint !== fingerprint) {
          candidateFingerprint = fingerprint;
          timer = setTimeout(read, 100);
          return;
        }
      }
      const probe = document.createElement("div");
      probe.className = "fixed bg-sidebar";
      probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;pointer-events:none";
      document.body.appendChild(probe);
      const sidebarStyle = getComputedStyle(probe);
      const swatch = document.createElement("span");
      swatch.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px";
      document.body.appendChild(swatch);
      const next: Computed = {};
      for (const [index, name] of names.entries()) {
        const value = values[index] ?? "";
        const scoped = sidebarStyle.getPropertyValue(`--${name}`).trim();
        swatch.style.backgroundColor = "";
        swatch.style.backgroundColor = `var(--${name})`;
        const painted = getComputedStyle(swatch).backgroundColor;
        const authoredColor = value ? resolveColor(value) : { rgb: "", hex: "—" };
        const resolved = value && !authoredColor.rgb ? resolveColor(painted) : authoredColor;
        next[name] = { value, hex: resolved.hex, rgb: resolved.rgb, sidebar: scoped && scoped !== value ? scoped : null };
      }
      probe.remove();
      swatch.remove();
      acceptedFingerprint.current = fingerprint;
      setOut(next);
    };
    timer = setTimeout(read, previousFingerprint === null ? 350 : 0);
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [names, revision]);
  return out;
}

function useResolvedRadii(revision: string): Record<string, string> {
  const [out, setOut] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:10px;height:10px;pointer-events:none";
      document.body.appendChild(probe);
      const next: Record<string, string> = {};
      for (const specimen of RADIUS_SPECIMENS) {
        probe.style.borderTopLeftRadius = "";
        probe.style.borderTopLeftRadius = specimen.source;
        const resolved = getComputedStyle(probe).borderTopLeftRadius;
        next[specimen.id] = resolved ? `${Math.round(Number.parseFloat(resolved))}` : "";
      }
      probe.remove();
      setOut(next);
    }, 350);
    return () => clearTimeout(timer);
  }, [revision]);
  return out;
}

const TEXT_SECTION: CSSProperties = { margin: 0, fontSize: 14, lineHeight: "20px", fontWeight: 650, letterSpacing: "-0.01em", color: v("foreground") };
const TEXT_CATEGORY: CSSProperties = { margin: 0, fontSize: 10.5, lineHeight: "16px", fontWeight: 650, letterSpacing: "0.065em", textTransform: "uppercase", color: v("foreground") };
const TEXT_LABEL: CSSProperties = { fontSize: 12.5, lineHeight: "18px", fontWeight: 550, color: v("foreground") };
const TEXT_VALUE: CSSProperties = { fontFamily: MONO, fontSize: 11.5, lineHeight: "17px", fontVariantNumeric: "tabular-nums", color: v("readback-foreground", v("muted-foreground")) };
const SHEET_SPACE = { block: 6, inline: 10, control: 8, group: 16, section: 20 } as const;

function AreaHeading({ area }: { area: "overlays" | "components" | "stylesheet" }) {
  return <h2 id={`tp-${area}-heading`} data-tp-role="section" style={TEXT_SECTION}>{AREA_TITLES[area]}</h2>;
}

function firstFamily(value: string | undefined): string {
  if (!value) return "";
  return value.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function formatValue(value: string | undefined, suffix = ""): string {
  if (!value) return "—";
  const trimmed = value.trim();
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return trimmed;
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return value;
  return `${Number(number.toFixed(2))}${suffix}`;
}

function formatLineHeight(value: string | undefined): string {
  if (!value) return "—";
  const division = /^calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/.exec(value.trim());
  if (!division) return formatValue(value);
  const numerator = Number.parseFloat(division[1]);
  const denominator = Number.parseFloat(division[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return value;
  return `${Number((numerator / denominator).toFixed(2))}`;
}

function colorRatio(name: string, policy: string, computed: Computed): number | null {
  const color = computed[name];
  if (policy === "vs-surface") {
    const surface = name === "sidebar-foreground" ? "sidebar" : "canvas";
    if (!color?.rgb || !computed[surface]?.rgb) return null;
    return contrastRatio(color.rgb, computed[surface].rgb, surface === "canvas" ? undefined : computed.canvas?.rgb);
  }
  if (policy === "as-painted") {
    const spec = STATUS_CONTRAST[name];
    if (!spec) return null;
    const foreground = computed[spec.fgToken]?.rgb || (spec.fgFallbackToken ? computed[spec.fgFallbackToken]?.rgb : "");
    const wash = computed[spec.washToken]?.rgb;
    const canvas = computed.canvas?.rgb;
    return foreground && wash && canvas ? contrastRatio(foreground, atAlpha(wash, spec.washAlpha), canvas) : null;
  }
  return null;
}

type StyleSegmentProps = {
  specimen: string;
  label: string;
  value: string;
  leading?: ReactNode;
  reserveLeading?: boolean;
  trailing?: ReactNode;
  labelStyle?: CSSProperties;
};

function styleSegmentColumns(hasLeading: boolean, hasTrailing: boolean): string {
  return [
    ...(hasLeading ? ["24px"] : []),
    "minmax(72px, 1fr)",
    `minmax(58px, ${hasTrailing ? "0.72fr" : "1fr"})`,
    ...(hasTrailing ? ["minmax(92px, 0.95fr)"] : []),
  ].join(" ");
}

function StyleSegment({ specimen, label, value, leading, reserveLeading = false, trailing, labelStyle }: StyleSegmentProps) {
  const hasLeading = leading !== undefined || reserveLeading;
  const columns = styleSegmentColumns(hasLeading, trailing !== undefined);
  return (
    <div data-tp-style-segment="" data-tp-specimen={specimen} style={{ display: "grid", gridTemplateColumns: columns, gridColumn: "1 / -1", columnGap: SHEET_SPACE.control, alignItems: "center", minHeight: 32, minWidth: 0, boxSizing: "border-box", padding: `${SHEET_SPACE.block}px ${SHEET_SPACE.inline}px`, borderTop: `1px solid ${v("border-hairline", v("border"))}` }}>
      {hasLeading ? <span data-tp-role="preview" style={{ width: 24, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-start" }}>{leading}</span> : null}
      <span data-tp-role="label" title={label} style={{ ...TEXT_LABEL, ...labelStyle, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{label}</span>
      <span data-tp-role="value" title={value || "—"} style={{ ...TEXT_VALUE, minWidth: 0, textAlign: "right", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{value || "—"}</span>
      {trailing !== undefined ? <span data-tp-role="meta" style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", textAlign: "right" }}>{trailing}</span> : null}
    </div>
  );
}

function ColorSegment({ name, policy, computed }: { name: string; policy: string; computed: Computed }) {
  const color = computed[name];
  const hasContrast = policy !== "none";
  const ratio = hasContrast ? colorRatio(name, policy, computed) : null;
  const title = color?.sidebar ? `${color.value}\nSidebar override: ${color.sidebar}` : color?.value;
  const ratioLabel = ratio === null ? "—" : `${ratio.toFixed(2)}:1`;
  return (
    <StyleSegment
      specimen={`color:${name}`}
      label={name}
      value={color?.hex ?? "—"}
      labelStyle={{ ...TEXT_VALUE, color: v("foreground") }}
      leading={<span aria-label={`${name} swatch${color?.sidebar ? ", has a sidebar override" : ""}`} title={title} style={{ width: 24, height: 16, borderRadius: 5, background: color?.value ? v(name) : "transparent", boxShadow: `inset 0 0 0 1px ${color?.sidebar ? v("warning") : v("border-hairline", v("border"))}` }} />}
      trailing={hasContrast ? (
        <span data-tp-contrast-ratio="" aria-label={`${name} contrast ratio: ${ratioLabel}`} style={{ ...TEXT_VALUE, textAlign: "right", whiteSpace: "nowrap" }}>
          {ratioLabel}
        </span>
      ) : undefined}
    />
  );
}

function SystemBlock({ id, title, trailingLabel, children }: { id: string; title: string; trailingLabel?: string; children: ReactNode }) {
  const hasTrailingLabel = trailingLabel !== undefined;
  return (
    <div data-tp-block={id} data-tp-grid="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridAutoRows: "minmax(32px, auto)", alignItems: "center", alignContent: "start", minWidth: 0, overflow: "hidden", border: `1px solid ${v("border-hairline", v("border"))}`, borderRadius: RADIUS_MD, background: v("card") }}>
      <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, gridColumn: "1 / -1", gridTemplateColumns: hasTrailingLabel ? styleSegmentColumns(true, true) : undefined, columnGap: hasTrailingLabel ? SHEET_SPACE.control : undefined, minHeight: 32, minWidth: 0, boxSizing: "border-box", display: hasTrailingLabel ? "grid" : "flex", alignItems: "center", padding: `${SHEET_SPACE.block}px ${SHEET_SPACE.inline}px`, background: v("surface-recessed-soft-solid", v("secondary")) }}>
        <span style={{ gridColumn: hasTrailingLabel ? "1 / 4" : undefined, minWidth: 0 }}>{title}</span>
        {trailingLabel ? <span data-tp-column="contrast" style={{ gridColumn: "4", minWidth: 0, textAlign: "right", color: v("muted-foreground"), overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{trailingLabel}</span> : null}
      </h3>
      {children}
    </div>
  );
}

function TypographySheet({ computed }: { computed: Computed }) {
  const values: Record<string, string> = {
    "font-sans": firstFamily(computed["font-sans"]?.value),
    "font-mono": firstFamily(computed["font-mono"]?.value),
    "text-scale": computed["text-sm"]?.value ?? "—",
    "line-height": formatLineHeight(computed["text-sm--line-height"]?.value),
  };
  return (
    <SystemBlock id="typography" title="Typography">
      {TYPE_SPECIMENS.map((specimen) => (
        <StyleSegment key={specimen.id} specimen={`type:${specimen.id}`} label={specimen.title} value={values[specimen.id] ?? "—"} leading={<span aria-hidden style={{ fontFamily: specimen.id === "font-mono" ? MONO : SANS, fontSize: 12.5, color: v("foreground") }}>Aa</span>} />
      ))}
    </SystemBlock>
  );
}

function RhythmSheet({ computed }: { computed: Computed }) {
  return (
    <SystemBlock id="rhythm" title="Rhythm">
      {RHYTHM_SPECIMENS.map((specimen) => <StyleSegment key={specimen.id} specimen={`rhythm:${specimen.id}`} label={specimen.title} value={formatValue(computed[specimen.token]?.value, specimen.unit)} />)}
    </SystemBlock>
  );
}

function RadiusSheet({ resolved }: { resolved: Record<string, string> }) {
  return (
    <SystemBlock id="radius" title="Corner radius">
      {RADIUS_SPECIMENS.map((specimen) => (
        <StyleSegment key={specimen.id} specimen={`radius:${specimen.id}`} label={specimen.title} value={resolved[specimen.id] ? `${resolved[specimen.id]}px` : "—"} leading={<span aria-hidden style={{ width: 18, height: 18, borderTopLeftRadius: specimen.source, borderTop: `2px solid ${v("foreground")}`, borderLeft: `2px solid ${v("foreground")}`, opacity: 0.65 }} />} />
      ))}
    </SystemBlock>
  );
}

function ShadowSheet({ computed }: { computed: Computed }) {
  const managedShadowColor = computed["tp-shadow-color"];
  const shadowColor = managedShadowColor?.rgb ? managedShadowColor : computed["shadow-color"];
  const opacity = computed["tp-shadow-opacity-percent"]?.value
    ? `${formatValue(computed["tp-shadow-opacity-percent"]?.value)}%`
    : computed["shadow-opacity"]?.value
      ? `${Math.round(Number.parseFloat(computed["shadow-opacity"].value) * 100)}%`
      : "—";
  const values: Record<string, string> = {
    y: formatValue(computed["shadow-y"]?.value, "px"),
    blur: formatValue(computed["shadow-blur"]?.value, "px"),
    x: formatValue(computed["shadow-x"]?.value, "px"),
    spread: formatValue(computed["shadow-spread"]?.value, "px"),
    color: shadowColor?.hex ?? "—",
    opacity,
  };
  return (
    <SystemBlock id="shadow" title="Shadow">
      <div data-tp-shadow-preview="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 54px", gridColumn: "1 / -1", alignItems: "center", columnGap: SHEET_SPACE.control, minHeight: 40, boxSizing: "border-box", padding: `${SHEET_SPACE.block}px ${SHEET_SPACE.inline}px`, borderTop: `1px solid ${v("border-hairline", v("border"))}` }}>
        <span style={TEXT_LABEL}>Live shadow</span>
        <span aria-hidden style={{ width: 54, height: 26, borderRadius: RADIUS_MD, background: v("card"), boxShadow: v("shadow-md", v("shadow")) }} />
      </div>
      {SHADOW_SPECIMENS.map((specimen) => (
        <StyleSegment key={specimen.id} specimen={`shadow:${specimen.id}`} label={specimen.title} value={values[specimen.id] ?? "—"} reserveLeading leading={specimen.id === "color" ? <span aria-hidden style={{ width: 24, height: 16, borderRadius: 5, background: shadowColor?.rgb || "transparent", boxShadow: `inset 0 0 0 1px ${v("border-hairline", v("border"))}` }} /> : undefined} />
      ))}
    </SystemBlock>
  );
}

function StyleSheetSection({ computed, radii }: { computed: Computed; radii: Record<string, string> }) {
  const paletteGroups = COLOR_GROUPS.filter((group) => group.band === "palette");
  const foundationGroups = COLOR_GROUPS.filter((group) => group.band === "foundation");
  return (
    <div data-tp-style-readonly="">
      <div data-tp-style-colors="" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 292px), 1fr))", alignItems: "start", gap: SHEET_SPACE.group }}>
        {paletteGroups.map((group) => (
          <SystemBlock key={group.id} id={group.id} title={group.title} trailingLabel={group.contrast !== "none" ? "Contrast" : undefined}>
            {group.tokens.map((token) => <ColorSegment key={token} name={token} policy={group.contrast} computed={computed} />)}
          </SystemBlock>
        ))}
      </div>
      <div data-tp-style-systems="" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))", alignItems: "start", gap: SHEET_SPACE.group, marginTop: SHEET_SPACE.section }}>
        {foundationGroups.map((group) => (
          <SystemBlock key={group.id} id={group.id} title={group.title} trailingLabel={group.contrast !== "none" ? "Contrast" : undefined}>
            {group.tokens.map((token) => <ColorSegment key={token} name={token} policy={group.contrast} computed={computed} />)}
          </SystemBlock>
        ))}
        <TypographySheet computed={computed} />
        <RhythmSheet computed={computed} />
        <RadiusSheet resolved={radii} />
        <ShadowSheet computed={computed} />
      </div>
    </div>
  );
}
// Area 2 — interactive overlays. Every launcher is a real button that opens a
// real bb surface, so it carries a full affordance set: pointer cursor, hover
// fill, focus ring, and an open (selected) state. Radix triggers publish
// `data-state="open"`; the two hover surfaces are controlled here.
// ---------------------------------------------------------------------------

// bb's standard hover delay (the app's tooltips use 300ms); the close delay
// is the grace period for crossing the gap from trigger to card.
const HOVER_OPEN_DELAY_MS = 300;
const HOVER_CLOSE_DELAY_MS = 150;

// Compact launchers: no trailing icon, tighter box, states carried by fill and
// border so they still read as buttons.
const OVERLAY_TRIGGER_CLASS =
  "h-7 w-full cursor-pointer justify-center px-2 text-xs font-normal " +
  "hover:bg-accent hover:text-accent-foreground hover:border-ring/60 " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 " +
  "data-[state=open]:border-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

function OverlayTriggerLabel({ children }: { children: ReactNode }) {
  return <span style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{children}</span>;
}

// A tooltip that stays readable while the pointer crosses it: opening uses the
// standard delay, dismissal waits out normal pointer movement, and keyboard
// focus drives the same state.
const TOOLTIP_DISMISS_DELAY_MS = 700;

function useDelayedTooltip() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => { if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined; } };
  useEffect(() => clear, []);
  return {
    open,
    show: () => { clear(); setOpen(true); },
    hideSoon: () => { clear(); timer.current = setTimeout(() => setOpen(false), TOOLTIP_DISMISS_DELAY_MS); },
    hideNow: () => { clear(); setOpen(false); },
    setOpen,
  };
}

function OverlaySpecimens({ vertical = false }: { vertical?: boolean }) {
  // Tooltip and hover card are hover surfaces, but every launcher should also
  // answer a click — a silent button reads as broken.
  const tooltip = useDelayedTooltip();
  const [hoverCardOpen, setHoverCardOpen] = useState(false);
  const openClass = (open: boolean) => cn(OVERLAY_TRIGGER_CLASS, open && "border-ring bg-accent text-accent-foreground");
  return (
    <div
      data-tp-overlay-launchers=""
      style={vertical
        ? { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))", gap: 4 }
        : { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 4 }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <BbButton variant="outline" size="sm" className={OVERLAY_TRIGGER_CLASS}><OverlayTriggerLabel>Menu</OverlayTriggerLabel></BbButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Thread</DropdownMenuLabel>
          <DropdownMenuItem>Rename…</DropdownMenuItem>
          <DropdownMenuItem>Open in split</DropdownMenuItem>
          <DropdownMenuItem>Copy link</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive">Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog>
        <DialogTrigger asChild>
          <BbButton variant="outline" size="sm" className={OVERLAY_TRIGGER_CLASS}><OverlayTriggerLabel>Dialog</OverlayTriggerLabel></BbButton>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive thread?</DialogTitle>
            <DialogDescription>“Endless theme family — blacklight pass” moves to the archive. You can restore it from search at any time.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <BbButton variant="outline" size="sm">Cancel</BbButton>
            </DialogClose>
            <DialogClose asChild>
              <BbButton size="sm">Archive</BbButton>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Popover>
        <PopoverTrigger asChild>
          <BbButton variant="outline" size="sm" className={OVERLAY_TRIGGER_CLASS}><OverlayTriggerLabel>Popover</OverlayTriggerLabel></BbButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-1">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">On this page</div>
          {["Verification summary", "Selection blue", "Sidebar seam"].map((item, index) => (
            <div key={item} className={cn("rounded-sm px-2 py-1 text-sm", index === 0 ? "bg-accent text-accent-foreground" : "text-foreground")}>{item}</div>
          ))}
        </PopoverContent>
      </Popover>
      <TooltipProvider delayDuration={HOVER_OPEN_DELAY_MS}>
        <Tooltip open={tooltip.open} onOpenChange={tooltip.setOpen}>
          <TooltipTrigger asChild>
            <BbButton
              variant="outline"
              size="sm"
              data-tp-tooltip-trigger=""
              className={openClass(tooltip.open)}
              onMouseEnter={tooltip.show}
              onMouseLeave={tooltip.hideSoon}
              onFocus={tooltip.show}
              onBlur={tooltip.hideNow}
              onClick={(event) => { event.preventDefault(); tooltip.show(); }}
            >
              <OverlayTriggerLabel>Tooltip</OverlayTriggerLabel>
            </BbButton>
          </TooltipTrigger>
          <TooltipContent
            data-tp-tooltip-content=""
            onMouseEnter={tooltip.show}
            onMouseLeave={tooltip.hideSoon}
          >
            Copy branch name
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* Radix owns the hover lifecycle: it opens after the delay and closes
          once the pointer has left BOTH the trigger and the content, so no
          manual mouse handler can strand it open. Click stays available as an
          explicit toggle for tap and keyboard users. */}
      <HoverCard
        open={hoverCardOpen}
        onOpenChange={setHoverCardOpen}
        openDelay={HOVER_OPEN_DELAY_MS}
        closeDelay={HOVER_CLOSE_DELAY_MS}
      >
        <HoverCardTrigger asChild>
          <BbButton
            variant="outline"
            size="sm"
            data-tp-hovercard-trigger=""
            className={openClass(hoverCardOpen)}
            onClick={() => setHoverCardOpen((open) => !open)}
          >
            <OverlayTriggerLabel>Hover card</OverlayTriggerLabel>
          </BbButton>
        </HoverCardTrigger>
        <HoverCardContent
          data-tp-hovercard-content=""
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // Sized to its trigger like bb's select content, so the two line up
          // instead of the card being shunted sideways to avoid a collision.
          style={{ width: "max(var(--radix-hover-card-trigger-width), 15rem)" }}
          className="p-3"
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Endless theme family</span>
            <Badge tone="success"><Dot color={v("success")} size={6} /> Running</Badge>
          </div>
          <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 12, color: v("muted-foreground") }}>bb/endless-theme</div>
          <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: "18px", color: v("muted-foreground") }}>Sidebar reads true black with the orange seam; blue selection at .20.</div>
          {/* Controls live inside the card: acting on them must not dismiss it. */}
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <BbButton
              variant="outline"
              size="sm"
              className="h-7 flex-1 cursor-pointer px-2 text-xs"
            >
              Copy branch
            </BbButton>
            <BbButton
              size="sm"
              className="h-7 flex-1 cursor-pointer px-2 text-xs"
            >
              Open in split
            </BbButton>
          </div>
        </HoverCardContent>
      </HoverCard>
      <BbButton variant="outline" size="sm" className={OVERLAY_TRIGGER_CLASS} onClick={() => toast.success("Reference sheet updated", { description: "themes/endless-color.css" })}>
        <OverlayTriggerLabel>Toast</OverlayTriggerLabel>
      </BbButton>
    </div>
  );
}

function ComponentsSection() {
  const [search, setSearch] = useState("");
  const [notify, setNotify] = useState(true);
  const [compact, setCompact] = useState(false);
  const [checked, setChecked] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const compactBlock = (wide = false): CSSProperties => ({ minWidth: 0, gridColumn: wide ? "1 / -1" : undefined });
  const toggleBlock: CSSProperties = { ...compactBlock(), paddingBlock: space(3) };
  const toggleControls: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
  const compactLabel: CSSProperties = { ...TEXT_LABEL, minWidth: 0, fontSize: 11.5, lineHeight: "16px" };
  return (
    <div data-tp-components="" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 16, rowGap: 16, alignItems: "start" }}>
      <div data-tp-block="buttons" style={compactBlock(true)}>
        <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, marginBottom: 8 }}>Buttons</h3>
        <div data-tp-button-grid="" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
          <BbButton size="sm" className="h-7 min-w-0 cursor-pointer px-2 text-xs">Default</BbButton>
          <BbButton size="sm" variant="secondary" className="h-7 min-w-0 cursor-pointer px-2 text-xs">Secondary</BbButton>
          <BbButton size="sm" variant="outline" className="h-7 min-w-0 cursor-pointer px-2 text-xs">Outline</BbButton>
          <BbButton size="sm" variant="ghost" className="h-7 min-w-0 cursor-pointer px-2 text-xs">Ghost</BbButton>
          <BbButton size="sm" variant="destructive" className="h-7 min-w-0 cursor-pointer px-2 text-xs">Delete</BbButton>
          <BbButton size="sm" variant="outline" className="h-7 min-w-0 px-2 text-xs" disabled>Disabled</BbButton>
        </div>
      </div>
      <div data-tp-block="badges" style={compactBlock(true)}>
        <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, marginBottom: 8 }}>Badges</h3>
        <div data-tp-badge-row="" style={{ display: "flex", flexWrap: "nowrap", gap: 4, alignItems: "center", overflowX: "auto" }}>
          <Badge tone="success"><Dot color={v("success")} size={6} /> Running</Badge><Badge tone="warning">Attention</Badge>
          <Badge tone="destructive">Failed</Badge><Badge tone="merged">Merged</Badge><Badge tone="outline">branch</Badge>
        </div>
      </div>
      <div data-tp-block="inputs" style={compactBlock(true)}>
        <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, marginBottom: 8 }}>Inputs</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <BbInput className="h-7 px-2 text-xs" aria-label="Search threads" placeholder="Search threads…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <BbInput className="h-7 px-2 text-xs" aria-label="Disabled input" value="Disabled" disabled readOnly />
        </div>
      </div>
      <div data-tp-block="switch" style={toggleBlock}>
        <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, marginBottom: 8 }}>Switch</h3>
        <div data-tp-toggle-controls="" style={toggleControls}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...compactLabel }}>
            <BbSwitch checked={notify} onCheckedChange={setNotify} className="cursor-pointer" /> Notifications
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...compactLabel }}>
            <BbSwitch checked={compact} onCheckedChange={setCompact} className="cursor-pointer" /> Compact rows
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, ...compactLabel, color: v("muted-foreground") }}>
            <BbSwitch checked disabled /> Disabled
          </label>
        </div>
      </div>
      <div data-tp-block="checkbox" style={toggleBlock}>
        <h3 data-tp-role="category" style={{ ...TEXT_CATEGORY, marginBottom: 8 }}>Checkbox</h3>
        <div data-tp-toggle-controls="" style={toggleControls}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...compactLabel }}>
            <BbCheckbox checked={checked} onCheckedChange={(next) => setChecked(next === true)} className="cursor-pointer" /> Include drafts
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", ...compactLabel }}>
            <BbCheckbox checked={agreed} onCheckedChange={(next) => setAgreed(next === true)} className="cursor-pointer" /> Watch this branch
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, ...compactLabel, color: v("muted-foreground") }}>
            <BbCheckbox checked disabled /> Disabled
          </label>
        </div>
      </div>
    </div>
  );
}

/** The rail beside the mock: two compact interaction areas, kept as siblings. */
function StageRail() {
  return (
    <>
      <section data-tp-area="overlays" aria-labelledby="tp-overlays-heading" style={{ minWidth: 0, paddingBottom: space(4) }}>
        <AreaHeading area="overlays" />
        <div style={{ marginTop: space(3) }}>
          <OverlaySpecimens vertical />
        </div>
      </section>
      <section data-tp-area="components" aria-labelledby="tp-components-heading" style={{ minWidth: 0, paddingTop: space(4), borderTop: `1px solid ${v("border-seam", v("border"))}` }}>
        <AreaHeading area="components" />
        <div style={{ marginTop: space(3) }}>
          <ComponentsSection />
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// The theme control: bb's own select, one option per theme. Every row
// previews the theme it names — its prominent colours as chips, its face as
// live type — so the choice is made on appearance rather than on an id.
// ---------------------------------------------------------------------------

type Swatch = {
  canvas: string | null; sidebar: string | null; card: string | null;
  primary: string | null; accent: string | null; foreground: string | null;
  fontSans: string | null; fontMono: string | null;
};
type ThemeEntry = {
  id: string;
  name: string;
  light: Swatch | null;
  dark: Swatch | null;
};
type Catalog = { activeThemeId: string | null; themes: ThemeEntry[]; revision: number };

const EMPTY_CATALOG: Catalog = { activeThemeId: null, themes: [], revision: 0 };
let catalogSnapshot: Catalog = EMPTY_CATALOG;

function commitCatalog(next: Catalog, update: (catalog: Catalog) => void): void {
  catalogSnapshot = next;
  update(next);
}

const CHIP_KEYS = ["sidebar", "canvas", "card", "primary", "accent"] as const;

function Chips({ swatch, w = 13, h = 20 }: { swatch: Swatch | null; w?: number; h?: number }) {
  return (
    <span style={{ display: "flex", gap: 3, flex: "none" }}>
      {CHIP_KEYS.map((key) => (
        <span
          key={key}
          title={`--${key === "accent" ? "file-accent" : key}: ${swatch?.[key] ?? "bundled with the app, not readable from disk"}`}
          style={{
            width: w, height: h, borderRadius: 3, flex: "none", background: swatch?.[key] ?? "transparent",
            boxShadow: `inset 0 0 0 1px ${swatch?.[key] ? v("border-hairline", v("border")) : v("border")}`,
            opacity: swatch?.[key] ? 1 : 0.35,
          }}
        />
      ))}
    </span>
  );
}

function ThemeOption({ entry, mode }: { entry: ThemeEntry; mode: Mode }) {
  const swatch = mode === "dark" ? entry.dark : entry.light;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <Chips swatch={swatch} w={8} h={14} />
      <span style={{ minWidth: 0, flex: 1, fontSize: 12.5, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{entry.name}</span>
    </span>
  );
}

/** Light/dark as a two-option switch, labelled for assistive tech. */
function ModeSwitch({ mode, disabled, onPick }: { mode: Mode; disabled: boolean; onPick: (next: Mode) => void }) {
  return (
    <div
      data-tp-mode-switch=""
      role="group"
      aria-label="Colour mode"
      className="border-input"
      style={{ display: "flex", gap: 2, padding: 2, borderRadius: RADIUS_MD, borderWidth: 1, borderStyle: "solid", flex: "none" }}
    >
      {(["light", "dark"] as const).map((option) => {
        const active = mode === option;
        return (
          <button
            key={option}
            type="button"
            data-tp-mode={option}
            aria-pressed={active}
            aria-label={option === "light" ? "Light mode" : "Dark mode"}
            title={option === "light" ? "Light mode" : "Dark mode"}
            disabled={disabled}
            onClick={() => onPick(option)}
            className={cn(
              "flex h-6 w-7 cursor-pointer items-center justify-center rounded-sm transition-colors",
              "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active && "bg-accent text-accent-foreground",
              disabled && "cursor-not-allowed",
            )}
          >
            <HugeiconsIcon
              aria-hidden
              data-tp-mode-icon={option}
              icon={option === "light" ? Sun03Icon : Moon02Icon}
              className="size-4"
            />
          </button>
        );
      })}
    </div>
  );
}

function ThemePicker({
  catalog,
  computed,
  mode,
  pendingSelection,
  selectionSlow,
  selectionFailed,
  onPick,
  onRetry,
}: {
  catalog: Catalog;
  computed: Computed;
  mode: Mode;
  pendingSelection: ThemeSelection | null;
  selectionSlow: boolean;
  selectionFailed: boolean;
  onPick: (themeId: string, mode: Mode) => void;
  onRetry: () => void;
}) {
  const displayThemeId = pendingSelection?.themeId ?? catalog.activeThemeId;
  const displayMode = pendingSelection?.mode ?? mode;
  const current = catalog.themes.find((theme) => theme.id === displayThemeId) ?? catalog.themes[0];
  const diskSwatch = current ? (displayMode === "dark" ? current.dark : current.light) : null;
  const measured = (name: string): string | null => computed[name]?.rgb || null;
  const currentSwatch: Swatch | null = pendingSelection === null && current?.id === catalog.activeThemeId
    ? {
        canvas: diskSwatch?.canvas ?? measured("canvas"),
        sidebar: diskSwatch?.sidebar ?? measured("sidebar"),
        card: diskSwatch?.card ?? measured("card"),
        primary: diskSwatch?.primary ?? measured("primary"),
        accent: diskSwatch?.accent ?? measured("file-accent"),
        foreground: diskSwatch?.foreground ?? measured("foreground"),
        fontSans: diskSwatch?.fontSans ?? null,
        fontMono: diskSwatch?.fontMono ?? null,
      }
    : diskSwatch;
  const pending = pendingSelection !== null;
  const unavailable = pending;
  const loading = catalog.themes.length === 0;
  const accessibleName = loading
    ? "Loading themes"
    : pending
    ? `${selectionSlow ? "Still applying" : "Applying"} ${current?.name ?? "theme"} ${displayMode}`
    : `${current?.name ?? "Theme"} ${displayMode}`;

  return (
    <div data-tp-theme-picker="" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, minWidth: 0, maxWidth: "100%" }}>
      <div data-tp-theme-picker-row="" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, width: "fit-content", maxWidth: "100%" }}>
        <Select
          value={current?.id ?? ""}
          onValueChange={(themeId) => onPick(themeId, displayMode)}
        >
          <SelectTrigger
            data-tp-theme-control=""
            aria-busy={unavailable}
            aria-label={accessibleName}
            disabled={unavailable || loading}
            className="h-8 min-w-36 gap-2 overflow-hidden text-sm disabled:opacity-100"
            style={{ width: "fit-content", maxWidth: "100%", flex: "1 1 auto" }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: "1 1 auto" }}>
              <Chips swatch={currentSwatch} w={6} h={11} />
              <span data-tp-theme-name="" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 auto" }}>{loading ? "Loading themes…" : current?.name ?? "Theme"}</span>
            </span>
          </SelectTrigger>
          <SelectContent align="end" className="w-56 max-w-[calc(100vw-24px)]">
            <SelectGroup>
              {catalog.themes.map((entry) => (
                <SelectItem key={entry.id} value={entry.id} textValue={entry.name}>
                  <ThemeOption entry={entry} mode={displayMode} />
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <ModeSwitch
          mode={displayMode}
          disabled={unavailable || loading}
          onPick={(next) => { if (current) onPick(current.id, next); }}
        />
      </div>
      {pending && selectionSlow ? (
        <div role="status" style={{ fontSize: 10.5, color: v("muted-foreground") }}>Still applying…</div>
      ) : null}
      {selectionFailed ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 20, fontSize: 10.5, color: v("destructive-text", v("destructive")) }}>
          <span>Theme didn’t apply.</span>
          <button
            type="button"
            aria-label="Retry theme"
            onClick={onRetry}
            className="cursor-pointer underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
            style={{ appearance: "none", border: 0, background: "none", padding: 0, color: "inherit", font: "inherit" }}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Light/dark is a per-client preference in bb, stored in localStorage under
// `bb.theme` as "light" | "dark" | "system" and mirrored onto the document's
// `.dark` class. Writing the key (not just the class) is what makes the choice
// stick and what keeps Settings → Appearance showing the same thing; the
// storage event tells bb's own control to re-read it.
const MODE_KEY = "bb.theme";

function useColorMode(): [Mode, (next: Mode) => void] {
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : "light") as Mode;
  const [mode, setMode] = useState<Mode>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setMode(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  const set = (next: Mode) => {
    const previous = localStorage.getItem(MODE_KEY);
    localStorage.setItem(MODE_KEY, next);
    // Same-document writes do not fire `storage`, so dispatch it ourselves for
    // any listener in this window; other windows get the native event.
    window.dispatchEvent(new StorageEvent("storage", { key: MODE_KEY, oldValue: previous, newValue: next, storageArea: localStorage }));
    document.documentElement.classList.toggle("dark", next === "dark");
    setMode(next);
  };
  return [mode, set];
}

function PreviewPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [mode, setMode] = useColorMode();
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [layout, setLayout] = useState<{ band: LayoutBand; width: number }>({ band: "mobile", width: 0 });
  const [catalog, setCatalog] = useState<Catalog>(() => catalogSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ThemeSelection | null>(null);
  const [failedSelection, setFailedSelection] = useState<ThemeSelection | null>(null);
  const [selectionSlow, setSelectionSlow] = useState(false);
  const catalogRequests = useRef(new LatestRequest());
  const selectionPending = useRef(false);
  const catalogLoadPending = useRef(false);
  const catalogLoadQueued = useRef(false);

  const view = useMemo<View>(() => {
    const first = subPath.split("/").filter(Boolean)[0] ?? "";
    return (VIEWS as readonly string[]).includes(first) ? (first as View) : "thread";
  }, [subPath]);

  // Poll while the panel is open: the server compares the active theme file's
  // mtime and re-applies it when an agent has rewritten it, so a theme being
  // edited in the other split repaints here without anyone clicking anything.
  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (selectionPending.current || catalogLoadPending.current) {
        catalogLoadQueued.current = true;
        return;
      }
      catalogLoadQueued.current = false;
      catalogLoadPending.current = true;
      const request = catalogRequests.current.begin();
      withRpcTimeout(rpc.call("themeCatalog", {}), "Theme catalog")
        .then((c) => {
          if (!cancelled && !catalogLoadQueued.current && catalogRequests.current.isLatest(request)) {
            commitCatalog(c, setCatalog);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled && !catalogLoadQueued.current && catalogRequests.current.isLatest(request)) {
            setError(String(e));
          }
        })
        .finally(() => {
          catalogLoadPending.current = false;
          if (!cancelled && catalogLoadQueued.current) load();
        });
    };
    loadRef.current = load;
    load();
    // Slow fallback only; the server's directory watcher signals changes instantly.
    const timer = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [rpc]);
  useRealtime("theme-preview:changed", () => loadRef.current());

  useEffect(() => {
    if (!pendingSelection) {
      setSelectionSlow(false);
      return;
    }
    const timer = setTimeout(() => setSelectionSlow(true), 5_000);
    return () => clearTimeout(timer);
  }, [pendingSelection]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => setHeaderHeight(header.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const band = layoutBandForWidth(width);
      setLayout((current) => current.band === band && current.width === width ? current : { band, width });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const applySelection = (selection: ThemeSelection) => {
    if (selectionPending.current) return;
    setMode(selection.mode);
    // Always send the explicit choice. The catalog reflects the last completed
    // apply, so it can be stale while a slower selection is still in flight.
    selectionPending.current = true;
    setPendingSelection(selection);
    setFailedSelection(null);
    setError(null);
    const request = catalogRequests.current.begin();
    withRpcTimeout(rpc.call("setTheme", { themeId: selection.themeId }), "Theme selection")
      .then((next) => {
        if (catalogRequests.current.isLatest(request)) {
          commitCatalog(next, setCatalog);
          setFailedSelection(null);
        }
      })
      .catch(() => {
        if (catalogRequests.current.isLatest(request)) setFailedSelection(selection);
      })
      .finally(() => {
        if (catalogRequests.current.isLatest(request)) {
          selectionPending.current = false;
          setPendingSelection(null);
          if (catalogLoadQueued.current) loadRef.current();
        }
      });
  };
  const pick = (themeId: string, nextMode: Mode) => applySelection({ themeId, mode: nextMode });
  const retrySelection = () => { if (failedSelection) applySelection(failedSelection); };

  const revision = `${mode}:${catalog.activeThemeId ?? ""}:${catalog.revision}`;
  const computed = useComputedTokens(ALL_TOKENS, revision);
  const radii = useResolvedRadii(revision);
  const mobile = layout.band === "mobile";
  const railWidth = layout.band === "narrow" ? surfaceRailWidth(layout.width) : SURFACE_RAIL_WIDTH;
  const contentInset = contentInsetForWidth(layout.width);
  const displayThemeId = pendingSelection?.themeId ?? catalog.activeThemeId;
  const displayThemeName = catalog.themes.find((theme) => theme.id === displayThemeId)?.name ?? "Current theme";

  return (
    <div ref={rootRef} data-tp-root data-tp-band={layout.band} style={{ height: "100%", overflowY: "auto", overflowX: "hidden", background: v("canvas", v("background")), color: v("foreground"), fontFamily: SANS, letterSpacing: v("tracking-normal", "0em") }}>
      <div ref={headerRef} style={{ position: "sticky", top: 0, zIndex: 20, borderBottom: `1px solid ${v("border-seam", v("border"))}`, background: v("canvas", v("background")) }}>
        <div data-tp-header-inner="" style={{ width: "100%", maxWidth: STUDIO_MAX_WIDTH, margin: "0 auto", boxSizing: "border-box", display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: space(2), gap: space(2), padding: `${space(3)} ${contentInset}px` }}>
          <Tabs value={view} onValueChange={(next) => navigate.toPluginPanel("preview", { subPath: next })}>
            <TabsList data-tp-view-control="" aria-label="Preview view" className={cn(mobile && "w-full")}>
              {VIEWS.map((item) => (
                <TabsTrigger key={item} value={item} className={cn("cursor-pointer", mobile && "flex-1")}>
                  {VIEW_LABEL[item]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div style={{ flex: 1 }} />
          {error ? <span style={{ fontSize: 12, color: v("destructive-text", v("destructive")) }}>{error}</span> : null}
          <div style={{ flex: mobile ? "1 1 100%" : "0 1 auto", minWidth: 0, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", gap: space(1) }}>
            <ThemePicker
              catalog={catalog}
              computed={computed}
              mode={mode}
              pendingSelection={pendingSelection}
              selectionSlow={selectionSlow}
              selectionFailed={failedSelection !== null}
              onPick={pick}
              onRetry={retrySelection}
            />
          </div>
        </div>
      </div>

      {/* Layout system, level 2: the plugin window. One stage zone (mock +
          at-a-glance rail on wider bands), then flow sections in taxonomy
          order, all on the same max-width spine. On the mobile band the rail
          content becomes the first flow section so nothing is lost, only
          restacked. */}
      <div style={{ borderBottom: `1px solid ${v("border-seam", v("border"))}` }}>
        <div
          data-tp-layout={layout.band}
          style={{
            width: "100%", maxWidth: STUDIO_MAX_WIDTH, margin: "0 auto", minHeight: 0, display: "grid",
            gridTemplateColumns: mobile ? "minmax(0, 1fr)" : `minmax(0, 1fr) ${railWidth}px`,
            alignItems: "start",
          }}
        >
          <div data-tp-area="mock" style={{ minWidth: 0 }}>
            <div
              data-tp-mock-container=""
              style={{ width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box", padding: contentInset }}
            >
              <Frame view={view} themeName={displayThemeName} mode={mode} />
            </div>
          </div>
          {mobile ? null : (
            <div
              data-tp-section="rail"
              style={{
                minWidth: 0, alignSelf: "stretch", padding: `${contentInset}px ${contentInset}px ${space(4)}`,
                borderLeft: `1px solid ${v("border-seam", v("border"))}`,
                background: v("surface-recessed-soft-solid", v("card")),
              }}
            >
              <StageRail />
            </div>
          )}
        </div>
      </div>

      {(mobile
        ? (["overlays", "components", "stylesheet"] as const)
        : (["stylesheet"] as const)
      ).map((area) => (
        <section key={area} data-tp-area={area} aria-labelledby={`tp-${area}-heading`} style={{ width: "100%", maxWidth: STUDIO_MAX_WIDTH, margin: "0 auto", boxSizing: "border-box", scrollMarginTop: headerHeight + 12, padding: `${space(5)} ${contentInset}px ${space(3)}` }}>
          <AreaHeading area={area} />
          <div style={{ marginTop: space(3) }}>
            {area === "overlays" ? <OverlaySpecimens vertical />
              : area === "components" ? <ComponentsSection />
              : <StyleSheetSection computed={computed} radii={radii} />}
          </div>
        </section>
      ))}
      <div style={{ height: space(8) }} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "preview",
    title: "Theme Preview",
    icon: "Palette",
    path: "preview",
    component: PreviewPage,
  });
});
