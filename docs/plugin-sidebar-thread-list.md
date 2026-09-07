# Plugin API: replace the sidebar thread list

Status: **implemented**. The members below ship in `@get-bb/plugin-sdk/app`.

This document specifies one exclusive slot and the data surface it needs.
A plugin uses them to replace bb's thread list with its own.

Every member below ships with the `experimental_` prefix and an entry in
[api_to_audit.md](api_to_audit.md), per [AGENTS.md](../AGENTS.md).

---

## 1. What the plugin owns, and what the host keeps

`AppSidebar` renders five regions from top to bottom:

| Region                                     | Owner today                | After this change |
| ------------------------------------------ | -------------------------- | ----------------- |
| Top reserve / window drag row              | host                       | host, always      |
| Primary actions (New thread, search)       | `ProjectListActionButtons` | host, always      |
| Plugin nav rows (Tools, Docs, Tasks)       | `PluginNavSidebarItems`    | host, always      |
| **Scrolling thread list**                  | `ProjectList`              | **the plugin**    |
| Footer (Settings, plugin actions, updates) | host                       | host, always      |

The plugin replaces the scroll area only. The host keeps the chrome, so
every sidebar looks like bb, resizes like bb, and collapses like bb.

Two reasons the host keeps the rest. The nav rows and footer are other
plugins' surfaces — Docs, Tasks, and every sidebar footer item live there —
and one plugin must not be able to remove another's. The drag row and resize
handle carry desktop window behavior that is not a plugin concern.

An earlier revision let a list claim the New-thread and search row too. That
is gone: the row is shared chrome, and passing it down as a prop would mean a
plugin could silently drop it. A list that wants its own controls puts them at
the top of its own scroll area. Thread search stays host-owned in the quick
palette; the required `searchQuery` prop remains only for compatibility and is
always `""`.

---

## 2. The slot

```ts
app.slots.experimental_threadList(registration: PluginThreadListRegistration): void;
```

```ts
interface PluginThreadListRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Label in Settings → Appearance → Sidebar. */
  title: string;
  /** One line under the title in the picker. */
  description?: string;
  component: ComponentType<PluginThreadListProps>;
}
```

```ts
interface PluginThreadListProps {
  /** The thread the route currently shows, or null. */
  activeThreadId: string | null;
  /** The project the route currently shows, or null. */
  activeProjectId: string | null;
  /** True on phone-width viewports and coarse pointers. */
  isCompactViewport: boolean;
  /**
   * Call after the user opens a thread. It closes the mobile sidebar drawer.
   */
  onNavigate: () => void;
  /**
   * Compatibility value for the former sidebar search field. BB now searches
   * threads in the quick palette, so the host always supplies "".
   *
   * @deprecated The quick palette owns thread search. Ignore this value.
   */
  searchQuery: string;
  /**
   * BB's thread list bound to this sidebar instance. Render it to delegate
   * conditionally without re-entering plugin replacement resolution.
   */
  Original: ComponentType;
}
```

### This slot is exclusive

Every other `app.slots.*` member is additive. This one is not: two thread
lists cannot share one scroll area. The rules:

1. Automatic is the default. It activates the first registered provider in
   deterministic slot order; disabling or removing it reveals the next.
2. The user can choose Automatic, pin the built-in list, or pin a provider in
   **Settings → Appearance → Sidebar**.
3. The choice is client-local, in `localStorage` under
   `bb.sidebar.threadListProvider`, next to the other sidebar layout
   preferences. A device with a plugin disabled falls back cleanly.
4. If an explicitly chosen provider disappears — the plugin is uninstalled,
   disabled, or fails to interpret — the host renders the built-in list and
   keeps the preference. If the plugin comes back, so does its list.
5. If the component throws, the host does **not** show the usual "plugin
   crashed" chip. A chip in place of the whole sidebar leaves the user
   stranded. The host renders the built-in list instead, plus one toast that
   names the plugin. `PluginSlotMount` gains this fallback mode.

---

## 3. Reading threads

A plugin frontend has no thread data today. `useRpc` reaches only the
plugin's own backend, which is the wrong shape for a sidebar: a sidebar must
paint instantly and update live.

So the host exposes its own cache.

```ts
experimental_useSidebarThreads(): PluginSidebarThreadsState;
```

```ts
interface PluginSidebarThreadsState {
  status: "loading" | "ready" | "error";
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
}
```

This hook reads the same `sidebar-bootstrap` query the built-in list reads,
and it subscribes to the same realtime channels. It adds no request. A
plugin list is exactly as live as the built-in one.

```ts
interface PluginSidebarThread {
  id: string;
  projectId: string;
  /** Null while a thread is still unnamed; pair with `titleFallback`. */
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  sectionId: string | null;

  /** Terminal-ish lifecycle state, e.g. "idle", "running", "error". */
  status: PluginSidebarThreadStatus;
  /** The agent is blocked on the user: approval or a question. */
  hasPendingInteraction: boolean;
  /** Live work counts. Zero for everything means nothing is running. */
  activity: {
    workflows: number;
    backgroundAgents: number;
    backgroundCommands: number;
    planMode: number;
    goals: number;
  };
  /**
   * The one status the host would paint for this thread, already resolved
   * through bb's precedence. The plugin draws it however it likes.
   */
  indicator: PluginSidebarThreadIndicator;
  /**
   * The host's accessible label for that indicator, e.g. "Thread needs user
   * input". Null when `indicator` is "none". Use it for `aria-label` so
   * screen-reader text stays consistent across sidebars.
   */
  indicatorLabel: string | null;

  isUnread: boolean;
  isPinned: boolean;
  hasUnsubmittedDraft: boolean;

  environment: {
    id: string;
    name: string | null;
    branchName: string | null;
    workspaceDisplayKind: PluginSidebarWorkspaceKind;
  } | null;

  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  lastReadAt: number | null;
  latestAttentionAt: number;
}
```

```ts
type PluginSidebarThreadIndicator =
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "plan-mode"
  | "goal"
  | "runtime"
  | "draft"
  | "unread-success"
  | "none";
```

`PluginSidebarThread` is a deliberate copy of the fields a sidebar needs, not
a re-export of the internal `ThreadListEntry`. `ThreadListEntry` changes
whenever the app needs a field; a plugin contract must not.

`indicator` is the important one. It is `resolveThreadListIndicator` run by
the host. A plugin gets bb's precedence for free — attention before work,
plan and goal before the spinner — and cannot drift from it.

---

## 4. Acting on threads

```ts
experimental_useSidebarThreadActions(): PluginSidebarThreadActions;
```

```ts
interface PluginSidebarThreadActions {
  /** Navigate to a thread. `split: true` opens it in the side pane. */
  open(threadId: string, options?: { split?: boolean }): void;
  /** Go to the new-thread screen, optionally scoped to a project. */
  openNewThread(options?: { projectId?: string; focusPrompt?: boolean }): void;

  setPinned(threadId: string, pinned: boolean): Promise<void>;
  setRead(threadId: string, read: boolean): Promise<void>;
  rename(threadId: string, title: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  delete(threadId: string): Promise<void>;
}
```

Each method routes to the mutation the built-in list already uses, so
optimistic cache updates, toasts, and undo behave identically. A rejected
promise carries the host's error; the plugin decides whether to toast.

---

## 5. No host components

The SDK deliberately ships almost no components (plugin design §5.5), and this
API adds none.

Status icons are data: `indicator`, `indicatorLabel`, and `activity`. The
context menu is the plugin's too — every item bb's own menu offers (open, open
in split, pin, mark read, rename, archive, request delete) is on
`experimental_useSidebarThreadActions`, so a replaced sidebar can rebuild it,
reorder it, or replace it with something else entirely.

That is the point of replacing the list: a sidebar that cannot choose its own
glyphs and its own menu is not really replaced.

The trade is real and worth stating. A plugin menu will not automatically pick
up a thread action bb adds later, and it can drift from bb's labels and
ordering. `docs/api_to_audit.md` tracks that as an open question.

---

## 6. Splits

A sidebar row is a drag source for the split area. Drag it out of the sidebar
and drop it on a pane edge to split, or on a pane center to replace. This is
real behavior with pointer math, hit-testing, a cursor ghost, and a drop
overlay. A plugin must not reimplement it, and does not have to.

```ts
experimental_useSidebarThreadSplit(threadId: string): PluginSidebarThreadSplit;
```

```ts
interface PluginSidebarThreadSplit {
  /**
   * Spread onto the row's interactive element. Contains the pointer handler
   * that starts a split drag. Empty when splits are unavailable, so spreading
   * it is always safe.
   */
  splitProps: { onPointerDown?: PointerEventHandler<HTMLElement> };
  /**
   * False on compact viewports and when the user disabled splits. Gate any
   * "Open in split" affordance you draw on it.
   */
  isAvailable: boolean;
  /**
   * Where this thread currently sits in the split layout, or null when it is
   * not open in one. Use it to draw a pane mini-map, a tint, or nothing.
   * `rect` values are fractions from 0 to 1 of the split area.
   */
  layout: {
    panes: readonly {
      paneId: string;
      rect: { x: number; y: number; width: number; height: number };
      /** This pane holds the thread the row represents. */
      isMe: boolean;
      isFocused: boolean;
    }[];
  } | null;
}
```

The plugin supplies the element. The host supplies every rule:

- **The gesture only engages when the pointer leaves the sidebar** toward the
  main area. A short drag inside the sidebar is never stolen, so a plugin that
  brings its own drag-to-reorder keeps working. On engage the host cancels any
  active dnd-kit sensor, so the two never fight.
- **Edge drops split, center drops replace.** The host hit-tests panes and
  paints the drop zones.
- **A thread already open focuses its pane** instead of opening twice.
- **At the pane cap the host coerces a split into a replace.**
- **The URL follows the drop**, pushing or replacing history to match a
  sidebar click.

To open in a split from a click or a menu item, use the action hook rather
than a second entry point:

```ts
actions.open(thread.id, { split: event.metaKey || event.ctrlKey });
```

That runs the same placement rules as a drag: right split by default, focus
if already open, replace at the cap, plain navigation when splits are off.

`layout` is data on purpose. bb draws a small pane mini-map in its own rows;
your plugin can draw that, a border tint, or nothing at all.

### What the host does not give you

Drag to **reorder**, and drag a thread **into a section or project**, stay
host-internal. They are bound to bb's own section model, which a replaced list
may not even have. A plugin that wants ordering brings its own drag library
and stores its own order. The split drag will not interfere, because it only
engages once the pointer leaves the sidebar.

---

## 7. A second slot: the thread header

A replaced sidebar often hides something the old sidebar showed. A flat
inbox-style list hides child threads, because it has no place to nest them. Those children still need a home, and the thread header is it.

bb already has a backend version of this. `bb.ui.registerThreadAction` puts a
host-rendered button in the thread header and runs `run` on the server. That
is right for "do a thing". It cannot draw a live cluster of child threads.

So this slot is the frontend sibling. Same region, different rendering model:
the plugin supplies a component instead of a title and a `run`.

```ts
app.slots.experimental_threadHeaderAction(
  registration: PluginThreadHeaderActionRegistration,
): void;
```

```ts
interface PluginThreadHeaderActionRegistration {
  /** Unique within the plugin; letters, digits, `-`, `_`. */
  id: string;
  /** Accessible name for the region the host wraps around your component. */
  title: string;
  component: ComponentType<PluginThreadHeaderActionProps>;
}
```

```ts
interface PluginThreadHeaderActionProps {
  /** The thread this header belongs to. Never null: the slot is not
      rendered on the compose screen or on non-thread routes. */
  threadId: string;
  projectId: string;
  /** True on phone-width viewports and coarse pointers. Collapse to an
      icon-sized control when it is true. */
  isCompactViewport: boolean;
}
```

### Rules the host keeps

- **Placement.** The component renders at the left end of the header's action
  row, before the workspace button, the git actions, the panel toggle, the
  maximize button, and the close button. It sits in the same slot
  `bb.ui.registerThreadAction` buttons use today.
- **One row, fixed height.** The header is a 48px chrome row, and its controls
  are 28px. Render one inline control that fits that box. The host wraps your
  component in a `shrink-0` flex item and does not scroll it.
- **Once per pane.** A split layout renders one header per pane, so your
  component mounts once per visible thread, each with its own `threadId`.
  Keep per-thread state in the component, never in a module-level singleton.
- **Containment.** A throw collapses this one action to nothing and leaves the
  rest of the header working. Unlike the thread-list slot, there is nothing to
  fall back to, so the header simply loses the control.

### Popovers

The header clips nothing, but it is a short row. Anything taller than 28px
must be a portalled popover, not an inline panel. `bb plugin build` shims the
portal-owning packages to the host's singletons, so a vendored Radix or
`vaul` popover portals correctly and stacks above the thread content.

### Example: the subagents chip

```tsx
import {
  definePluginApp,
  useBbNavigate,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function SubagentsChip({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const navigate = useBbNavigate();

  // Children come from the same hook the sidebar uses. No new data API.
  const children = threads.filter((t) => t.parentThreadId === threadId);
  if (children.length === 0) return null;

  const needsYou = children.some((c) => c.hasPendingInteraction);

  return (
    <Popover>
      <PopoverTrigger className="flex h-7 items-center gap-2 rounded-full border border-border px-2">
        <AgentDiscs threads={children} />
        {isCompactViewport ? null : (
          <span className="text-xs">
            {needsYou ? "Needs you" : `${children.length} subagents`}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1">
        {children.map((child) => (
          <button
            key={child.id}
            onClick={() => navigate.toThread(child.id)}
            className="flex w-full items-center gap-2 rounded-md p-2 hover:bg-accent"
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {child.title ?? child.titleFallback ?? "Untitled"}
            </span>
            <StatusIcon indicator={child.indicator} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "subagents",
    title: "Subagents",
    component: SubagentsChip,
  });
});
```

Note what this example does **not** need: no new data hook, no backend, no
host change beyond the slot. `parentThreadId` and `indicator` are already on
`PluginSidebarThread`, and `useBbNavigate().toThread` already exists.

### What is not on a child thread

`PluginSidebarThread` carries `parentThreadId`, `originKind` (`"fork"`), and
`originPluginId` — a side chat is the side-chat plugin's fork. There is no agent type, no
tool count, and no progress figure. A row can show the title, the origin, the
status, and the time. Anything richer needs the plugin's own backend.

Also note the vocabulary. bb's in-turn subagents are activity on the parent
thread, counted in `activity.backgroundAgents`. They are not child threads.
This slot lists child threads: forks (side chats among them) and other
plugin-spawned threads.
The two sets overlap but are not the same, so label the chip carefully.

---

## 8. Keyboard support is a DOM contract

bb's thread shortcuts already work by DOM query, not by React state.
`getSidebarThreadShortcutTargets` collects
`[data-sidebar-thread-shortcut-target]` elements and reads
`dataset.sidebarThreadId`.

So a plugin gets bb's surface-specific numbered thread shortcuts,
`thread.next`, and `thread.previous` by putting two attributes on each row's
anchor:

```tsx
<a
  href={href}
  data-sidebar-thread-shortcut-target=""
  data-sidebar-thread-id={thread.id}
>
```

The host walks the DOM in visual order, so the plugin's order is the
shortcut order. This needs no new API. It does need documentation, because a
plugin that omits the attributes silently breaks nine shortcuts.

---

## 9. A complete minimal example

```tsx
import {
  definePluginApp,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { Loader2Icon, MessageCircleQuestionIcon } from "lucide-react";

function Row({
  thread,
  isActive,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  onNavigate: () => void;
}) {
  const actions = useSidebarThreadActions();
  // Per row, exactly as bb's own ThreadRow does it.
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);

  return (
    <li>
      <a
        {...splitProps}
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        aria-label={thread.indicatorLabel ?? undefined}
        onClick={(event) => {
          event.preventDefault();
          actions.open(thread.id, {
            split: event.metaKey || event.ctrlKey,
          });
          onNavigate();
        }}
        className={cn(
          "flex items-center gap-2 rounded-md px-2 py-1",
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent",
          // This thread sits in another pane: tint it, the way you like.
          !isActive && layout && "bg-sidebar-accent/50",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {thread.title ?? thread.titleFallback ?? "Untitled"}
        </span>
        {/* Your icons, your rules — `indicator` is just a string. */}
        {thread.indicator === "runtime" ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : thread.indicator === "waiting-for-input" ? (
          <MessageCircleQuestionIcon className="size-3.5" />
        ) : null}
      </a>
    </li>
  );
}

function NewestFirstList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { status, threads } = useSidebarThreads();
  if (status === "loading") return null;

  const ordered = [...threads].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <ul className="flex flex-col gap-px p-2">
      {ordered.map((thread) => (
        <Row
          key={thread.id}
          thread={thread}
          isActive={thread.id === activeThreadId}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "newest-first",
    title: "Newest first",
    description: "One flat list, newest thread on top.",
    component: NewestFirstList,
  });
});
```

That is a working sidebar in about eighty lines. It stays live, it draws its
own status icons, its rows drag out to split panes, they answer the numbered
thread shortcuts, and right-click still opens bb's full menu.

---

## 10. What this API does not give you

- **No thread content.** Titles and status only. For messages, use
  `ThreadChat` or the plugin's own backend through `bb.sdk`.
- **No pull-request or diff data.** The built-in rows do not carry it either.
  A plugin that wants it fetches it from its backend through `bb.sdk`, and
  caches it there.
- **No new persisted thread fields.** A plugin that needs per-thread state —
  settled, snoozed, starred — stores it in its own database through
  `bb.storage.database()` and serves it over `bb.rpc`. This keeps plugin
  concepts out of bb's schema and out of the host-daemon protocol.
- **No components at all.** `indicator`, `indicatorLabel`, and `activity` are
  data, and so is the action list: plugins draw their own icons and build their
  own context menus.
- **No drag to reorder, and no drag into a section.** Those stay host-internal.
  Bring your own drag library; the split drag will not fight it.
- **No control of the footer, the nav rows, or the window chrome.**

---

## 11. Draft entries for `api_to_audit.md`

Add these when the API lands.

### `app.slots.experimental_threadList` (`@get-bb/plugin-sdk/app`)

**What it does.** Replaces the sidebar's scrolling thread list with a plugin
component. Exclusive: Automatic activates the first available provider, while
the user can pin BB or one provider in client-local Settings. A crash or a
missing explicitly selected plugin falls back to the built-in list.

**Audit before stabilizing.**

1. **Arbitration.** Confirm a client-local single choice is right, versus a
   per-project or per-workspace choice, and what a synced setting would mean.
2. **Fallback.** Confirm the silent fallback to the built-in list is
   discoverable enough, and that one toast is the right signal.
3. **Region boundary.** The plugin claims the scroll area and nothing else.
   Confirm no real sidebar needs more, and that handing the shared regions
   down as props — letting a plugin place them, at the risk of dropping them —
   stays the wrong trade.
4. **Search compatibility.** Confirm released plugins no longer need the
   required deprecated `searchQuery` field before removing it in a deliberate
   breaking change. Until then, the host supplies `""`.
5. **Accessibility.** Confirm the host can still guarantee list semantics,
   focus order, and the mobile close behavior when a plugin owns the markup.

### `experimental_useSidebarThreads` / `experimental_useSidebarThreadActions`

**What it does.** Read-live and act on the host's sidebar thread cache from a
plugin component.

**Audit before stabilizing.**

1. **DTO scope.** Confirm every `PluginSidebarThread` field earns its place,
   and that the copy stays worth its maintenance over `ThreadListEntry`.
2. **Indicator coupling.** `indicator` freezes bb's precedence into the
   contract. Confirm new indicator kinds can ship without breaking plugins,
   and that plugins handle an unknown kind by drawing nothing.
3. **Scale.** Confirm one array of every thread is right at ten thousand
   threads, versus a paged or windowed read.
4. **Action surface.** Confirm the seven actions are complete, and decide
   whether bulk actions and undo belong here.
5. **Permission.** Decide whether `delete` and `archive` need any plugin
   permission gate beyond installation trust.

### `experimental_useSidebarThreadSplit`

**What it does.** Makes a plugin's row a drag source for the split area, and
reports where that thread sits in the split layout.

**Audit before stabilizing.**

1. **Prop-getter shape.** Confirm a spreadable `splitProps` bag is right,
   versus a ref callback or a host-rendered wrapper element.
2. **Gesture ownership.** The host cancels dnd-kit sensors on engage by
   dispatching Escape. Confirm that stays correct when a plugin brings a
   different drag library, or replace it with an explicit cancel hook.
3. **Layout leak.** `layout.panes` exposes bb's pane geometry. Confirm the
   fraction-based rect stays stable as the split model evolves.
4. **Per-row hook cost.** One hook per visible row reads the split atom.
   Confirm this holds with hundreds of rendered rows.
5. **Coverage.** Decide whether non-thread rows a plugin might draw — a
   project, a saved view — also need a split source.

### `app.slots.experimental_threadHeaderAction`

**What it does.** Renders a plugin component in the thread header's action
row, once per visible pane. The frontend sibling of the existing backend
`bb.ui.registerThreadAction`.

**Audit before stabilizing.**

1. **Two APIs, one region.** `bb.ui.registerThreadAction` and this slot now
   share a row. Confirm the ordering rule between them, and whether the two
   should merge behind one registration.
2. **Budget.** The row is short and already holds git actions, the panel
   toggle, maximize, and close. Decide a cap, or an overflow behavior, before
   three plugins each add a control.
3. **Compact viewport.** `isCompactViewport` asks every plugin to collapse
   itself. Confirm that beats a host-owned overflow menu.
4. **Per-pane mounting.** Confirm plugins handle mounting once per pane, and
   that a popover opened in one pane cannot leak into another.
5. **Other headers.** Decide whether the compose screen, plugin panels, and
   the workspace header need the same slot, or stay host-only.
