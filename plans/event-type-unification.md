# Event Type Unification

## Problem

We have three overlapping event type systems that were built piecemeal:

### 1. `ThreadEvent` (persistence layer — `@bb/core/types.ts`)
```ts
type ThreadEventType = CodexServerNotificationMethod | AppThreadEventType;
// e.g. "turn/started" | "item/completed" | "client/thread/start" | "system/error" | ...

interface ThreadEvent {
  id: string;
  threadId: string;
  seq: number;
  type: ThreadEventType;           // raw method string
  data: PersistedThreadEventData;  // loosely typed — either typed data or ProviderEventEnvelope
  createdAt: number;
}
```

- `ThreadEventType` is a union of **codex-specific** method names (from generated `ServerNotification`) + **app-specific** event types (`client/*`, `system/*`)
- `ThreadEventData` is typed per-method for app events but codex events are `ProviderEventEnvelope` (opaque wrapper around raw JSON)
- For claude-code/pi, events are always `ProviderEventEnvelope` — no typed params at all
- `to-ui-messages.ts` has to do massive defensive parsing because the data is loosely typed

### 2. `BbProviderEvent` (adapter translation layer — `@bb/core/provider-event.ts`)
```ts
type BbProviderEvent =
  | { type: "turn/started"; threadId: string; turnId: string }
  | { type: "item/completed"; threadId: string; turnId: string; item: BbProviderEventItem }
  // ... 25 event types, all strongly typed
```

- Strongly typed discriminated union — every field is known
- Provider-agnostic — all adapters translate into this shape
- Only covers **provider events** — no `client/*` or `system/*` events
- Currently used by env-daemon for policy decisions, NOT for persistence or UI

### 3. `AppThreadEventType` events (server-originated — `@bb/core/types.ts`)
```ts
type AppThreadEventType =
  | "client/thread/start"
  | "client/turn/requested"
  | "system/error"
  | "system/provisioning/started"
  // ...
```

- Server creates these for lifecycle tracking (user started a thread, provisioning progress, etc.)
- Typed data per event type
- Not provider events — they come from bb's server logic

## What's wrong

1. **`ThreadEventType` bakes in codex's `ServerNotification` methods** — this means the persistence layer is codex-aware. Claude-code and pi events get stored as opaque `ProviderEventEnvelope` blobs because their methods don't exist in the codex-generated union.

2. **Two type systems for the same events** — `BbProviderEvent` has `{ type: "turn/started"; turnId: string }` while `ThreadEvent` has `{ type: "turn/started"; data: TurnStartedNotification }` with different field names (`turnId` vs `turn.id`). They're describing the same thing in incompatible ways.

3. **`to-ui-messages.ts` can't trust any types** — it reads `ThreadEvent` from the DB and has to guess the shape because provider events are stored as `ProviderEventEnvelope` wrapping raw JSON. It uses `normalizeToken`, `getFirstStringField` with fallbacks, etc.

4. **Naming is inconsistent** — `ThreadEvent` (persisted), `BbProviderEvent` (translated), `BridgeNotification` (wire format, now deleted), `ProviderNotification` (old adapter input), `ProviderSessionNotification` (server controller output). All describe events at different lifecycle stages but the naming doesn't make the relationships clear.

## Proposed solution

### One canonical event type: `ThreadEvent`

`ThreadEvent` is the right name — it's an event that happens on a thread. It should be a strongly typed discriminated union that covers **all** event types: provider events, client events, and system events.

```ts
type ThreadEvent =
  // Provider events (from BbProviderEvent)
  | { type: "turn/started"; threadId: string; turnId: string; ... }
  | { type: "item/completed"; threadId: string; turnId: string; item: ThreadEventItem; ... }
  | ...

  // Client events (user actions)
  | { type: "client/thread/start"; threadId: string; input: PromptInput[]; ... }
  | { type: "client/turn/start"; threadId: string; input: PromptInput[]; ... }
  | ...

  // System events (bb server lifecycle)
  | { type: "system/error"; threadId: string; message: string; ... }
  | { type: "system/provisioning/started"; threadId: string; ... }
  | ...
```

Every event has `type` (discriminant), `threadId`, and typed fields. No `ProviderEventEnvelope`, no opaque `data` blob, no normalization needed.

### Persistence

The DB schema (`@bb/db`) doesn't change — it stores `type: string` and `data: string` (JSON blob). The event repo hydrates rows into typed objects. The layers:

1. **DB row** — `events` table in `@bb/db`. Raw `type` string + `data` JSON text + denormalized columns.
2. **`ThreadEventRow`** — the hydrated DB row (current `ThreadEvent`). Has `id`, `seq`, `createdAt`, `type`, `data`. This is what the event repo returns.
3. **`ThreadEvent`** — the strongly typed discriminated union. What the rest of the app works with.

A decoder in the event repo converts `ThreadEventRow` → `ThreadEvent` by parsing the `data` JSON and matching on `type`. Old events stored as `ProviderEventEnvelope` get decoded through a compatibility layer.

### Naming

| Current | Proposed | Why |
|---------|----------|-----|
| `BbProviderEvent` | `ThreadEvent` (provider subset) | It's a thread event. The "Bb" prefix was to distinguish from the old `ThreadEvent`. Once unified, no prefix needed. |
| `BbProviderEventItem` | `ThreadEventItem` | Same — just a thread event item. |
| `ThreadEvent` (old — the hydrated DB row) | `ThreadEventRow` | It's the row shape from the DB, not the app-level typed event. |
| `AppThreadEventType` | Part of `ThreadEvent` union | Merged into the single union. |
| `ProviderSessionNotification` | Delete | The server reads `ThreadEvent` directly from the env-daemon event envelope. |

### Migration path

1. Rename current `ThreadEvent` → `ThreadEventRow` (the DB row shape)
2. Rename `BbProviderEvent` → `ThreadEvent` (the typed union)
3. Rename `BbProviderEventItem` → `ThreadEventItem`, etc.
4. Add client/system events to the `ThreadEvent` union
5. Add a decoder in the event repo that converts `ThreadEventRow` → `ThreadEvent`
6. Update `to-ui-messages.ts` to consume `ThreadEvent` directly
7. Remove `CodexServerNotificationMethod` from the row type definition
8. Drop the `ProviderEventEnvelope` indirection for new events

### What this unblocks

- `to-ui-messages.ts` becomes a simple `switch (event.type)` — no defensive parsing
- Type safety end-to-end: adapter → env-daemon → server → UI
- No codex types leaked into `@bb/core`
- One vocabulary for events across the entire codebase
