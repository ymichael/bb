import type { ReactNode } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import {
  SIDEBAR_ROW_BASE_CLASS,
  SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
  SIDEBAR_STANDARD_ROW_PADDING_CLASS,
} from "@/components/sidebar/sidebarRowClasses";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { AppCommandShortcutPill } from "./AppCommandShortcutHint";

export default {
  title: "commands/Shortcut Hint",
};

const MAC_SHORTCUTS = [
  shortcut("Meta+K", "⌘ K"),
  shortcut("Meta+1", "⌘ 1"),
  shortcut("Meta+Shift+P", "⇧ ⌘ P"),
  shortcut("Control+Meta+F", "⌃ ⌘ F"),
  shortcut("Meta+Enter", "⌘ Enter"),
] satisfies readonly AppShortcutPresentation[];

const WIN_SHORTCUTS = [
  shortcut("Control+K", "Ctrl + K"),
  shortcut("Control+1", "Ctrl + 1"),
  shortcut("Control+Shift+P", "Ctrl + Shift + P"),
  shortcut("Control+Alt+F", "Ctrl + Alt + F"),
  shortcut("Control+Enter", "Ctrl + Enter"),
] satisfies readonly AppShortcutPresentation[];

function shortcut(
  ariaKeyshortcuts: string,
  label: string,
): AppShortcutPresentation {
  return { ariaKeyshortcuts, label };
}

function ShortcutSet({
  shortcuts,
}: {
  shortcuts: readonly AppShortcutPresentation[];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {shortcuts.map((item) => (
        <AppCommandShortcutPill key={item.ariaKeyshortcuts} shortcut={item} />
      ))}
    </span>
  );
}

function CenterlineFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex min-h-8 min-w-0 items-center overflow-hidden rounded-md border border-border/70 bg-background px-2",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-muted-foreground/30"
      />
      <span className="relative inline-flex min-w-0 items-center gap-2">
        {children}
      </span>
    </span>
  );
}

function TextBaselineExample({
  className,
  shortcut,
}: {
  className: string;
  shortcut: AppShortcutPresentation;
}) {
  return (
    <CenterlineFrame>
      <span className={cn("inline-flex items-baseline gap-1.5", className)}>
        <span>Open panel</span>
        <AppCommandShortcutPill shortcut={shortcut} />
      </span>
    </CenterlineFrame>
  );
}

function ToolbarExample() {
  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-md border border-border/70 bg-background px-1">
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2">
        <Icon name="MessageSquarePlus" />
        <span>New thread</span>
        <AppCommandShortcutPill shortcut={MAC_SHORTCUTS[0]} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label="Search threads"
      >
        <Icon name="Search" />
      </Button>
      <AppCommandShortcutPill shortcut={MAC_SHORTCUTS[1]} />
    </div>
  );
}

function SidebarRowExample({
  shortcut,
}: {
  shortcut: AppShortcutPresentation;
}) {
  return (
    <div className="w-80 rounded-md bg-sidebar p-2 text-sidebar-foreground">
      <div
        className={cn(
          SIDEBAR_ROW_BASE_CLASS,
          SIDEBAR_STANDARD_ROW_PADDING_CLASS,
          SIDEBAR_ROW_INTERACTIVE_STATE_CLASS,
          "min-h-8",
        )}
      >
        <Icon
          name="MessageSquare"
          className="size-4 shrink-0 text-subtle-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          Storybook pass for shortcut alignment
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <AppCommandShortcutPill shortcut={shortcut} />
        </span>
      </div>
    </div>
  );
}

export function Overview() {
  return (
    <>
      <StoryCard columns={["macOS", "Windows/Linux"]} labelWidth="180px">
        <StoryRow label="shortcut labels">
          <ShortcutSet shortcuts={MAC_SHORTCUTS} />
          <ShortcutSet shortcuts={WIN_SHORTCUTS} />
        </StoryRow>
        <StoryRow label="long chord">
          <AppCommandShortcutPill shortcut={MAC_SHORTCUTS[2]} />
          <AppCommandShortcutPill shortcut={WIN_SHORTCUTS[2]} />
        </StoryRow>
      </StoryCard>

      <StoryCard labelWidth="180px">
        <StoryRow
          label="text-xs"
          hint="baseline frame shows the row center line"
        >
          <TextBaselineExample
            className="text-xs"
            shortcut={MAC_SHORTCUTS[0]}
          />
        </StoryRow>
        <StoryRow
          label="text-sm"
          hint="matches most sidebar and toolbar labels"
        >
          <TextBaselineExample
            className="text-sm"
            shortcut={MAC_SHORTCUTS[0]}
          />
        </StoryRow>
        <StoryRow label="text-base">
          <TextBaselineExample
            className="text-base"
            shortcut={MAC_SHORTCUTS[0]}
          />
        </StoryRow>
      </StoryCard>

      <StoryCard labelWidth="180px">
        <StoryRow label="toolbar">
          <ToolbarExample />
        </StoryRow>
        <StoryRow label="sidebar row">
          <SidebarRowExample shortcut={MAC_SHORTCUTS[1]} />
        </StoryRow>
        <StoryRow label="sidebar long chord">
          <SidebarRowExample shortcut={WIN_SHORTCUTS[2]} />
        </StoryRow>
      </StoryCard>
    </>
  );
}
