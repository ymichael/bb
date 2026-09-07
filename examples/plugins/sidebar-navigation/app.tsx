import { useState } from "react";
import {
  definePluginApp,
  type ExperimentalSidebarNavigationItem,
  type ExperimentalSidebarNavigationProps,
} from "@get-bb/plugin-sdk/app";

const HOST_ICON: Record<
  Extract<ExperimentalSidebarNavigationItem["icon"], { kind: "host" }>["name"],
  string
> = {
  "new-thread": "+",
  search: "⌕",
  extensions: "◇",
};

function itemGlyph(item: ExperimentalSidebarNavigationItem): string {
  return item.icon.kind === "host" ? HOST_ICON[item.icon.name] : "◆";
}

function SidebarNavigation({
  activeItemId,
  experimental_Original: Original,
  experimental_activate,
  isCompactViewport,
  items,
}: ExperimentalSidebarNavigationProps) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [shouldCrash, setShouldCrash] = useState(false);
  if (shouldCrash) throw new Error("Example navigation crash");

  if (showOriginal) {
    return (
      <section data-testid="sidebar-navigation-example-original">
        <div className="px-2 pt-2">
          <button
            type="button"
            className="w-full rounded-md border border-sidebar-border px-2 py-1.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={() => setShowOriginal(false)}
          >
            Return to custom navigation
          </button>
        </div>
        <Original />
      </section>
    );
  }

  return (
    <section
      data-testid="sidebar-navigation-example"
      aria-label="Custom sidebar navigation"
      className="space-y-2 px-2 py-2 text-sidebar-foreground"
    >
      <div className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
        <strong className="mr-auto font-medium text-sidebar-foreground">
          Garden navigation
        </strong>
        <span>{isCompactViewport ? "Compact" : "Desktop"}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={item.isDisabled}
            aria-current={item.id === activeItemId ? "page" : undefined}
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            title={item.shortcut?.label}
            className="flex min-w-0 items-center gap-2 rounded-md border border-sidebar-border px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent disabled:opacity-50 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
            {...item.experimental_splitProps}
            onClick={(event) =>
              experimental_activate(item.id, {
                openInSplit: event.metaKey || event.ctrlKey,
              })
            }
          >
            <span aria-hidden className="w-3 shrink-0 text-center">
              {itemGlyph(item)}
            </span>
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-1 border-t border-sidebar-border pt-2">
        <button
          type="button"
          className="flex-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={() => setShowOriginal(true)}
        >
          Use BB navigation
        </button>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-destructive"
          onClick={() => setShouldCrash(true)}
        >
          Test fallback
        </button>
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "garden",
    title: "Garden navigation",
    description: "A compact grid for the host sidebar destinations.",
    component: SidebarNavigation,
  });
});
