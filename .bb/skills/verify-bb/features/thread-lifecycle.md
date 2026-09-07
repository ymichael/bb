# Run and organize a thread

Status: **2026-09-05: 1 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## User goal and source

Send a conversation to an agent, receive its answer, and organize the thread.

- `apps/app/src/views/RootComposeView.tsx`: initial thread submission.
- `apps/app/src/hooks/mutations/thread-runtime-mutations.ts`: runtime calls.
- `apps/app/src/components/thread/ThreadActionsMenu.tsx`: rename and archive.
- `apps/app/src/components/thread/ThreadActionsProvider.tsx`: action handlers.
- `apps/cli/src/commands/thread/show.ts`: thread state and final output.

## Prerequisites

Complete the local-project recipe. Choose **Work locally**, using the synthetic
folder. Inspect the provider picker and use an installed, authenticated
provider. A short real turn uses that provider's quota. If none is usable,
mark this journey blocked; do not stub the provider or claim a complete turn
from a created thread row.

## Reach and drive

1. Click **New thread** and select the fixture project if necessary. Fill the
   compose `[role="textbox"]` with:

   ```text
   Reply exactly: BB verification complete. Do not use tools or change files.
   ```

2. Capture the filled prompt and click **Submit (Enter)**. Wait for the URL
   to contain `/projects/` and `/threads/`. Record both returned IDs.
3. Wait for a separate assistant response, **BB verification complete.**
   Confirm with `node apps/cli/dist/index.js thread output "$BB_VERIFY_THREAD_ID" --json`
   and `node apps/cli/dist/index.js thread show "$BB_VERIFY_THREAD_ID" --json`.
   Set `BB_VERIFY_THREAD_ID` from the URL; do not reuse a previous run's ID.
   Require `status === "idle"` and `runtime.displayStatus === "idle"`. Poll for up to two minutes;
   inspect the actual error or provider prerequisite if it does not finish.
4. Reload the thread. Require the assistant response to remain visible.
5. Open `main [aria-label="Thread actions"]`, select **Rename**, fill the
   **Thread name** textbox with `Verification smoke`, and click **Rename thread**.
   Wait for the dialog to close before opening another menu.
6. Read `GET /api/v1/threads/<returned-thread-id>` and require
   `title === "Verification smoke"`. Open Thread actions and select **Archive**.
7. Archiving may navigate away from the thread. Reopen its saved URL when that
   happens. Require **Thread is archived**, the visible **Unarchive** button, and a
   non-null `archivedAt` from the thread API. Capture the state.
8. Click the in-thread **Unarchive** button. Require `archivedAt === null`,
   the follow-up textbox, and the thread's return to the sidebar.

## Observable success

The final output equals the requested phrase; the same thread ID persists
through reload, rename, archive, and unarchive. Save selected API fields
(`id`, `status`, `runtime.displayStatus`, `title`, `archivedAt`) and the CLI final output
with UI evidence. The thread DTO has no `activeTurnId` field; an omitted
JSON property does not prove that a turn ended. Check `git status --porcelain` in the fixture stays empty.

## Gotchas

The prompt and initial title contain the expected phrase too. Searching the
whole page for that phrase is insufficient; verify the separate assistant
message and the output API. Menus and dialogs animate: wait for closure before
the next action. The sidebar and main view both have Thread actions buttons;
scope to `main`. Preserve provider errors as blocked evidence instead of
silently switching to a mock. This recipe does not exercise tools, steering,
cancellation, or reconnect.
