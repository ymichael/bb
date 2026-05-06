# Timeline Row Typed Kinds

Two follow-ups carved out of a title-emphasis pass on `plans/timeline-rows.md`. Both share the same shape: replace pre-composed `title: string` strings with structured discriminators so the renderer alone owns spec wording.

## Motivation

Today, approval rows and the "operation" bucket inside system rows carry pre-composed strings from the server / projection (`"Waiting for approval to grant Bash"`, `"Thread assigned to manager"`). The renderer can't reliably split verb + subject because the strings vary in shape, so we fall back to single-segment muted titles. That diverges from `plans/timeline-rows.md` which prescribes `[shimmer]<verb>[/shimmer]: [em]<subject>[/em]` for these states.

The spec wording belongs in the renderer (one place). The data model should carry **semantics** — a closed discriminator + structured payload — and the renderer maps each `(kind, lifecycle)` tuple to its segments. No more wording in projection messages or event payloads.

## Two parts

Part 1 is a closed system; Part 2 isn't. Treat them as two changes.

---

## Part 1 — Approval rows (closed-system refactor)

In code, "approval" covers two distinct origins, both currently flattened into `TimelineApprovalWorkRow` with a single `title: string`:

- File-edit approval (from `EventProjectionFileEditMessage` with empty `changes` and a non-null `approvalStatus`) — built at `build-thread-timeline.ts:378-395`.
- Permission-grant lifecycle (from `EventProjectionPermissionGrantLifecycleMessage`, originally `system/permissionGrant/lifecycle` events) — built at `build-thread-timeline.ts:459-470`.

Both are closed enumerations. The data is already mostly structured (`approvalTarget`, `approvalStatus`, `subject` on the event). The only thing that's pre-composed is the title.

### Target shape

`TimelineApprovalWorkRow` becomes a discriminated union on `approvalKind`:

```ts
| {
    kind: "work";
    workKind: "approval";
    approvalKind: "file-edit";
    lifecycle: "waiting" | "denied";
    // existing fields: callId, target, …
  }
| {
    kind: "work";
    workKind: "approval";
    approvalKind: "permission-grant";
    lifecycle:
      | "pending"
      | "resolving"
      | "granted"
      | "denied"
      | "interrupted"
      | "expired";
    toolName: string | null;
    // existing fields: interactionId, target, …
  }
```

Drop `title: string` entirely.

### Projection layer

- `EventProjectionPermissionGrantLifecycleMessage` (`event-projection-message.ts:279-288`) drops `title` and gains `lifecycle` (already there as `status`, just rename to align with the row's vocabulary if helpful) and inherits `subject.toolName` from the event.
- `parse-operation-message.ts:340-358` stops setting `title: decoded.message`; passes through structured fields.
- `event-projection-state.ts` updates accordingly.

### Server emit-side

- `apps/server/src/services/interactions/pending-interaction-timeline.ts:34-57`: delete `permissionGrantLifecycleMessage`. The function is the only producer of the pre-composed message; dropping it is the visible win of this refactor.
- `systemPermissionGrantLifecycleEventDataSchema` (`packages/domain/src/thread-events.ts:168-178`): drop the `message: string` field. (It's only ever read by the projection. No other consumer.) Keep the structured `subject` and `status`.
- Update event emit calls in the same file to stop passing `message`.

### Renderer

`mapApprovalTitle` (`packages/thread-view/src/timeline-row-title.ts:654-664`) becomes a switch on `approvalKind` × `lifecycle`. Each branch produces verb + em(subject) per `plans/timeline-rows.md` lines 416-572:

| approvalKind | lifecycle | verb (shimmer when active) | subject (em) |
| --- | --- | --- | --- |
| permission-grant | pending | "Waiting for permission" | `toolName ?? "permissions"` |
| permission-grant | resolving | "Delivering permission" | `toolName ?? "permissions"` |
| permission-grant | granted | "Permission granted" | `toolName ?? "permissions"` |
| permission-grant | denied | "Permission granted" | `toolName ?? "permissions"` (+ `(denied)` decoration) |
| permission-grant | interrupted | "Permission granted" | `toolName ?? "permissions"` (+ `(interrupted)`) |
| permission-grant | expired | "Permission granted" | `toolName ?? "permissions"` (+ `(expired)`) |
| file-edit | waiting | "Waiting for approval to edit" | "files" |
| file-edit | denied | "Permission denied:" | "file changes" |

CLI plain text falls out of `renderTitlePlain` as today.

### Touch list

- `packages/domain/src/thread-events.ts` — drop `message` from `systemPermissionGrantLifecycleEventDataSchema`.
- `apps/server/src/services/interactions/pending-interaction-timeline.ts` — delete `permissionGrantLifecycleMessage`; stop emitting `message`.
- `packages/thread-view/src/event-projection-message.ts` — replace `title` with `lifecycle` on permission-grant projection message.
- `packages/thread-view/src/parse-operation-message.ts` — produce the new structured projection message.
- `packages/thread-view/src/event-projection-state.ts` — propagate.
- `packages/server-contract/src/thread-timeline.ts` — `timelineApprovalWorkRowSchema` becomes a discriminated union.
- `packages/thread-view/src/build-thread-timeline.ts` — emit the new row shape for both file-edit and permission-grant cases.
- `packages/thread-view/src/timeline-row-title.ts` — rewrite `mapApprovalTitle`.
- `packages/ui-core/fixtures/thread-timeline-rows.ts` — fixture helpers updated.
- Tests across `thread-view` and `ui-core` — update to the new row shape; add coverage for each `(approvalKind, lifecycle)` cell in the table.

### Validation

- `pnpm exec turbo run typecheck` is clean across the workspace.
- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core --filter=@bb/server` is clean.
- Manually exercise each lifecycle in dev: trigger a permission grant, accept/deny/expire it; trigger a file-edit approval, accept/deny it. Verify the title in the timeline matches `plans/timeline-rows.md` for each state.
- The pre-composed `message` string is gone from `system/permissionGrant/lifecycle` event payloads — confirm by tailing `~/.bb-dev/bb.db` events (`SELECT data FROM events WHERE type = 'system/permissionGrant/lifecycle' ORDER BY sequence DESC LIMIT 5;`).

### Exit criteria

- `permissionGrantLifecycleMessage` does not exist in the codebase.
- Grep for `"Waiting for approval"`, `"Permission granted"`, `"Permission denied"` etc. across `apps/server` and `packages/thread-view/src/parse-operation-message.ts` returns zero hits — wording lives only in `mapApprovalTitle`.
- All `(approvalKind, lifecycle)` cells in the table render with the correct verb + em subject in dev and in tests.

---

## Part 2 — System rows (narrow the operation bucket)

System rows are not a closed system — new system events get added freely and the schema needs to absorb them generically. So the goal here is more modest: lift the *known* operation sub-types up to the row level so the renderer can branch on them, while keeping a generic fallback for anything we don't yet have a spec for.

### Today

`TimelineSystemRow` (`packages/server-contract/src/thread-timeline.ts:122-128`):

```ts
{
  kind: "system";
  systemKind: "debug" | "error" | "operation" | "reconnect";
  title: string;
  detail: string | null;
  status: TimelineRowStatus | null;
}
```

Inside `"operation"`, a richer `opType` discriminator exists on the projection message (`event-projection-message.ts:190-200`) but is not exposed on the row:

- compaction
- manager-assignment (`opType: "operation"`)
- thread-provisioning
- thread-interrupted
- provider-unhandled
- warning / deprecation
- turn-diff
- plan-updated (declared, not currently emitted)

The spec only diverges for manager-assignment today (`plans/timeline-rows.md:519-526`). Compaction already matches; provider/system error is fixed by #10. The other sub-types don't have a written spec.

### Target shape

Add `operationKind` alongside `systemKind: "operation"` so the row carries the discriminator. Keep `title` for now — it stays the fallback for unknown / un-specced kinds and for CLI use.

```ts
{
  kind: "system";
  systemKind: "debug" | "error" | "operation" | "reconnect";
  operationKind?:
    | "compaction"
    | "manager-assignment"
    | "thread-provisioning"
    | "thread-interrupted"
    | "provider-unhandled"
    | "warning"
    | "deprecation"
    | "turn-diff"
    | "plan-updated";
  // when operationKind === "manager-assignment":
  managerAssignment?: {
    action: "assigned" | "released" | "transferred";
    details: string | null;
  };
  title: string;
  detail: string | null;
  status: TimelineRowStatus | null;
}
```

`operationKind` is set whenever `systemKind === "operation"`, derived from `EventProjectionOperationMessage.opType`. For `manager-assignment` we also lift its structured payload (`action` + optional details) onto the row.

### Renderer

`mapSystemTitle` adds typed branches:

- `operationKind === "manager-assignment"` → `[muted]Thread <action>[/muted] [optional][em]<details>[/em][/optional]` per spec line 523.
- Other `operationKind` values → fall through to current single-segment muted title (preserving today's rendering).
- Drop the `Error: ` prefix that #10 already removed.

### Touch list

- `packages/server-contract/src/thread-timeline.ts` — add `operationKind` and the optional `managerAssignment` payload to `timelineSystemRowSchema`.
- `packages/thread-view/src/build-thread-timeline.ts` — derive `operationKind` from `message.opType`; populate `managerAssignment` from `message.threadOperation` when `opType === "operation"`.
- `packages/thread-view/src/timeline-row-title.ts` — narrow `mapSystemTitle` for known kinds; keep generic fallback.
- `packages/ui-core/fixtures/thread-timeline-rows.ts` — fixture helpers gain `operationKind` and `managerAssignment` knobs.
- Tests — add explicit cases for manager-assignment rendering.

### Validation

- `pnpm exec turbo run typecheck` clean.
- `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/ui-core` clean.
- Trigger an ownership change in dev; confirm the resulting timeline row shows `Thread <action> <details>` with em on details.
- Other operation kinds (compaction, provisioning, warnings, etc.) still render unchanged.

### Exit criteria

- `mapSystemTitle` has at least one explicit `operationKind === "manager-assignment"` branch and a generic fallback.
- Manager-assignment timeline rows match `plans/timeline-rows.md:519-526`.
- No regression on compaction / error / debug / provisioning rows.

---

## Sequencing

Part 1 first (it's the bigger, cleaner refactor and removes a server-side wording dependency). Part 2 stacks on top — small additive change once the row-schema patterns are established.

Plans/timeline-rows.md updates:
- After Part 1: confirm the approval section's spec verbiage matches what the renderer now produces; remove the misnamed "system (permission-grant lifecycle)" section since those rows are approval rows in code.
- After Part 2: confirm the manager-assignment section matches.
