# App UI Components

`components/ui` is the app's local design-system folder. It has one job:
generic UI building blocks that can be driven entirely by props.

The folder should not become a dumping ground for app components. Before moving
or adding a component here, answer the relevant checks below.

## Primitives

Use `components/ui` for generic UI building blocks. A primitive must satisfy all
of these:

- No product data dependencies: no queries, atoms, routing, server calls, or BB
  lifecycle concepts.
- No `@bb/domain` types in its public API.
- Generic local interaction state is okay. Browser persistence, app preferences,
  and product policy belong in app wrappers.
- Replacing it would feel like a design-system change, not a feature change.

Examples: `Button`, `Dialog`, `DropdownMenu`, `Pill`, `DetailCard`,
`ExpandablePanel`, `ThreePaneLayout`.

## Domain Presentation

Use named feature folders for canonical rendering of BB domain concepts. These
components are still pure presentation:

- Props in, JSX out.
- No queries, atoms, routing, storage, or API calls.
- Drivable from fixture data.
- Used by at least two consumers, or clearly on the path to be shared.

Example: `components/thread-timeline`.

## App Code

Keep components outside `components/ui` when they are integration code or
single-consumer feature UI:

- Router, React Query, Jotai, local storage, cookies, or user preference wiring.
- App-specific containers and layout policy.
- Components with no expected reuse outside the app.

Thin app wrappers are expected when a primitive needs app policy. For example,
`components/ui` owns the generic `Toaster`, while the app owns `AppToaster`
because it injects the preferred theme.

## Litmus Test

Before adding code to `components/ui`, ask:

1. Is it a generic design-system primitive?
2. If not, is it a pure BB domain renderer used by multiple consumers?

If both answers are no, keep it in the app.

## Shadcn Provenance

Files derived from shadcn/ui use this one-line header comment:

```ts
/* shadcn/ui-derived */
```

Keep the marker at the top of the file so origin remains greppable even though
shadcn-derived and hand-authored primitives live side by side.

## Stories

Stories are co-located with the component they exercise. Use visual catalogs for
primitives and scenario-driven stories for stateful components. Mock data should
be hand-written and stories must not rely on real network calls, real WebSocket
connections, or real timers.

The Ladle providers decorator seeds app state at the boundary. WebSocket state is
seeded through the Jotai atoms that components already read rather than by
monkey-patching the `useWebSocket` hook.

## Story Coverage

| Batch | Scope                                        | Status   |
| ----- | -------------------------------------------- | -------- |
| B0    | Ladle bootstrap and migrated starter stories | Complete |
| B1    | Controls                                     | Complete |
| B2    | Overlays                                     | Complete |
| B3    | Layout                                       | Complete |
| B4    | Content                                      | Complete |
| B5a   | Sidebar header                               | Complete |
| B5b   | Sidebar menu                                 | Complete |
| B5c   | Sidebar groups and footer                    | Complete |
| B6    | Thread timeline                              | Complete |
| B7    | Replay fixtures                              | Complete |
