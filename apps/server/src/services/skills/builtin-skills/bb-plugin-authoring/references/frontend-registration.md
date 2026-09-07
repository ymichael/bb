# Frontend registration and major surfaces

## Frontend (`bb.app` entry)

`app.tsx` default-exports `definePluginApp` from `@get-bb/plugin-sdk/app`.
React and the SDK are **never bundled** — `bb plugin build` shims them to
the host's shared runtime, so the bundle only works inside bb.

```tsx
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  useSettings,
  useBbContext,
  useBbNavigate,
  experimental_FileLink as FileLink,
  UrlLink as UrlLink,
  useComposer,
  useComposerView,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner"; // shimmed to the host toaster
import { Button } from "@/components/ui/button"; // vendored source YOU own
import { Dialog, DialogContent } from "@/components/ui/dialog";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "editor-enhancement",
    mount({ pluginId, generation, signal }) {
      const onKeyDown = (event: KeyboardEvent) => {
        // Ordinary trusted, same-origin DOM behavior.
      };
      document.addEventListener("keydown", onKeyDown, { signal });
      return () => document.removeEventListener("keydown", onKeyDown);
    },
  });
  app.slots.homepageSection({
    id: "issues",
    title: "Open issues",
    component: IssuesSection,
  });
  app.slots.settingsSection({
    id: "settings",
    title: "Connection",
    description: "Configure the remote service used by this plugin.",
    component: SettingsSection,
  });
  app.slots.experimental_appOverlay({
    id: "floating-status",
    component: FloatingStatus,
  });
  app.slots.navPanel({
    id: "board",
    title: "Board",
    icon: "Columns",
    path: "board",
    component: Board,
    fixedTabs: [
      {
        panelId: "board",
        id: "navigation",
        title: "Navigation",
        icon: "PanelRight",
        component: BoardNavigation,
        layout: "flush",
      },
    ],
    experimental_sidebarAccessory: OpenIssueCount,
  });
  app.slots.threadPanelAction({
    id: "issue",
    title: "Open issue",
    component: IssuePanel,
    run: async ({ threadId, openPanel }) => {
      openPanel({ title: `Issue for ${threadId}` });
    },
  });
  app.slots.experimental_newThreadPanelAction({
    id: "template",
    title: "Apply template",
    component: TemplatePanel,
    run: ({ projectId, openPanel }) => {
      openPanel({ title: `Template for ${projectId ?? "projectless"}` });
    },
  });
  app.composer.customize({
    id: "prompt-tools",
    actions: [{ id: "improve", component: ImprovePromptAction }],
    plusMenu: [
      {
        id: "append-checklist",
        label: "Append checklist",
        run: ({ composer }) =>
          composer.updateText(
            (current) => `${current}\n\n- Verify behavior\n- Run checks`,
          ),
      },
    ],
    banners: [{ id: "workflow", component: WorkflowBanner }],
    richText: {
      effects: [
        {
          id: "todo",
          className: "plugin-todo-highlight",
          match: (text) =>
            Array.from(text.matchAll(/\bTODO\b/g), (match) => ({
              from: match.index,
              to: match.index + match[0].length,
            })),
        },
      ],
    },
  });
  app.slots.pendingInteraction({
    id: "credentials",
    component: CredentialForm,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "remote",
    label: "Remote access",
    icon: "Smartphone",
    onActivate: ({ openPluginDetails }) => openPluginDetails(),
  });
  app.slots.experimental_sidebarNavigation({
    id: "compact",
    title: "Compact navigation",
    component: CompactSidebarNavigation,
  });
  app.slots.messageDirective({ id: "inline-vis", component: InlineVis });
  app.slots.experimental_threadList({
    id: "inbox",
    title: "Inbox",
    description: "One flat list, newest thread on top.",
    component: InboxList,
  });
});
```

### A control in the thread header

`app.slots.experimental_threadHeaderAction` renders a component in the thread
header's action row. Use it for live plugin state.

```tsx
app.slots.experimental_threadHeaderAction({
  id: "subagents",
  title: "Subagents",
  component: ({ threadId, projectId, isCompactViewport }) => { ... },
});
```

The row is a 48px chrome row with 28px controls. Render one inline control.
Put taller content in a portalled popover. The host limits the layout box, but
it does not clip painted overflow. `title`
names the host's wrapper region — your icon-only button still needs its own
accessible name. A split layout renders one header
per pane, so your component mounts once per visible thread — keep per-thread
state in the component, never in a module-level singleton.

A common pairing with a replaced sidebar: hide child threads from the list and
surface them here instead, filtering `experimental_useSidebarThreads()` by
`parentThreadId === threadId`.

### Replacing the sidebar navigation

`app.slots.experimental_sidebarNavigation` replaces the navigation controls
above the thread list. The component receives `items`, `activeItemId`, and
`isCompactViewport`. The items represent New thread, Search threads,
Extensions, and plugin panels. BB keeps the drawer, thread list, footer,
resize handle, and hidden-body shortcut policy.

Each item has an `id`, `label`, semantic `icon`, host `action`, disabled state,
shortcut metadata, and `experimental_splitProps`. Spread the split props onto
the interactive element. Call
`experimental_activate(item.id, { openInSplit })` for activation. Search opens
the host quick palette. The former inline sidebar search field and query state
are not part of this API.

The component also receives `experimental_Original`. Render it to delegate to
BB without another replacement lookup. BB restores the original controls if
the selected replacement is unavailable or crashes. Users can select
Automatic, BB, or one plugin under Settings → Appearance → Navigation.

### Replacing the sidebar thread list

`app.slots.experimental_threadList` is the one **exclusive** slot: only one
list fills the sidebar's scroll area. Registering activates the replacement
while the plugin is enabled. If multiple plugins register one, the first in
deterministic slot order is active by default; removing it reveals the next.
The user can pin BB's list or a specific provider under
**Settings → Appearance → Sidebar**. The choice is per client.

Your component gets the scrolling list and nothing else. The New-thread button,
the search action, the plugin nav rows, and the footer stay host-rendered —
other plugins live in two of those, so a replaced list must not remove them.
Put your own controls at the top of your scroll area instead.

If the chosen plugin is disabled, uninstalled, or its component throws, bb
renders its own list again (plus a toast on a crash), so the sidebar is never
empty.

The component receives:

```ts
interface PluginThreadListProps {
  activeThreadId: string | null;
  activeProjectId: string | null;
  isCompactViewport: boolean;
  /** Closes the mobile drawer. Always call it after opening a thread. */
  onNavigate: () => void;
  /** Deprecated compatibility value for the removed sidebar search field.
      The host always supplies "". */
  searchQuery: string;
  /** BB's bound thread list. Render it to delegate conditionally without
      re-entering plugin replacement resolution. */
  Original: ComponentType;
}
```

**Reading and acting on threads.** Two hooks back a replaced list:

```tsx
const { status, threads, projects } = experimental_useSidebarThreads();
const actions = experimental_useSidebarThreadActions();

// threads: PluginSidebarThread[] — id, projectId, title, titleFallback,
// parentThreadId, sectionId, originKind, originPluginId, providerId,
// hasPendingInteraction, activity, isUnread/isPinned/isArchived,
// environment { id, name, branchName, workspaceDisplayKind }, host { id, name },
// createdAt, updatedAt, lastReadAt, latestAttentionAt, and
// `indicator` (bb's resolved status kind) + `indicatorLabel` (its a11y string).
// Draw your own glyph for `indicator`; the SDK ships no status component.
// Treat an unknown indicator value as "none" — bb adds kinds over time.

// Pull requests are per row and opt-in — a lookup hits the git host, so it is
// deliberately NOT on the thread payload every sidebar loads:
const { pullRequest } = experimental_useSidebarThreadPullRequest(thread.id);
// → { isLoading, pullRequest: { number, title, url, state, attention } | null }

actions.open(id, { split: true }); // bb's split placement rules
actions.openNewThread({ projectId, focusPrompt: true });
actions.setPinned(id, true);
actions.setRead(id, false);
actions.rename(id, "New title"); // silent; for inline editing
actions.archive(id); // archives children too, closes their panes
actions.requestDelete(id); // opens bb's delete confirmation
```

Destructive actions deliberately route through the host's own flow, so there
is no silent `delete`: deletion is recursive, and only bb can show the
confirmation that counts the child threads.

Unit-test a list with `renderSlot(...)` from `@get-bb/plugin-sdk/testing/app`:
seed rows with the `sidebarThreads` option and assert against
`inspection.sidebarActionCalls`.

**Splits.** Rows can drag out to the split area:

```tsx
const { splitProps, isAvailable, layout } =
  experimental_useSidebarThreadSplit(thread.id);

<a {...splitProps} onClick={...}>
  {title}
  {/* layout is data: draw a mini-map, a tint, or nothing */}
</a>;
```

The host owns the gesture rules, including the one that matters if your list
has its own drag-to-reorder: a split drag engages only once the pointer leaves
the sidebar.

**Your row, your menu.** This API ships no components. Build your own context
menu from `experimental_useSidebarThreadActions` — it exposes everything bb's
own menu does, including `requestDelete`, which opens bb's confirmation.

**Keyboard support is a DOM contract.** bb's thread shortcuts find rows by
query selector, not by React state. Put both attributes on each row's anchor or
the surface-specific numbered shortcuts, `thread.next`, and `thread.previous`
silently stop working:

```tsx
<a data-sidebar-thread-shortcut-target="" data-sidebar-thread-id={thread.id}>
```

### The provider directory

`experimental_useProviders()` returns `{ status, providers }` — every
registered agent provider in picker order, as the same `ProviderInfo` the
host's composer reads (`id`, `pluginId`, `displayName`, `family`, `icon`,
`logoUrl`, `available`, `capabilities`, `maintenance`, `extensionKinds`,
`composerActions`, and the declared `strings`, `reasoningLevels`,
`serviceTiers`). It reads the host's own cached roster, so
it costs no extra request. Use it whenever a surface shows a thread's or
automation's provider: never vendor provider names or copy in a plugin.

```tsx
const { providers } = experimental_useProviders();
const name =
  providers.find((provider) => provider.id === thread.providerId)
    ?.displayName ?? thread.providerId;
```

`status` is `"loading"` until the roster arrives and `"error"` when the request
failed; `providers` is empty in both cases, so fall back to the id. The
backend counterpart is `bb.sdk.providers.list()`. Keep the hook in the plugin
entry (`app.tsx`) and pass names down as props, so view components stay pure
and testable outside the plugin runtime.
