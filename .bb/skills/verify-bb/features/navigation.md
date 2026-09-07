# Navigation, search, and thread organization

Status: **2026-09-05: 6 passed, 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Two synthetic projects and several threads, including unread, pinned, archived, and child threads. Open the web app sidebar and quick palette.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/app/src/lib/app-command-metadata.ts`
- `apps/app/src/components/sidebar/ProjectList.tsx`
- `apps/cli/src/commands/thread/organization.ts`
- `apps/app/src/components/notifications/NotificationCenter.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Home and projectless compose | Open / with and without a selected project; create a projectless draft, switch project, then return. | Draft and project selection follow their scopes; no accidental thread starts. |
| Search threads and message contents | Use Search threads in the quick palette; query a unique title and a different string found only in a message. Compare bb thread search `<query>`. | Matching thread/message opens the correct thread and preserves search scope. |
| Previous, next, and numbered jumps | Invoke the named keyboard actions over a filtered sidebar; repeat at both ends and with an input focused. | Navigation uses visible thread order and does not steal normal typing. |
| Pin, unpin, and pinned order | Pin two threads via Thread actions; reorder them; reload; unpin one. Compare thread pin/unpin/reorder-pinned and thread list. | Saved order and pin state agree across UI and CLI; unpin preserves the thread. |
| Read and unread | Mark a finished thread unread, open it, then mark read explicitly. Compare thread read/unread. | Unread indicators and notification eligibility follow the saved read state. |
| Sections | Create, rename, assign threads to, reorder, collapse, and delete a section. Use bb thread section --help for CLI forms. | Assignments and collapsed/order preferences persist; deleting a section does not delete its threads. |
| Grouping, sorting, display options | Use Sidebar display options for each offered grouping and sorting mode; change project order with bb project reorder; reload. | Every thread remains reachable exactly once in its applicable group; order persists. |
| Parents and children | Spawn a child of a synthetic parent; inspect thread list --parent-thread and the child links. Archive only the chosen family through the relevant action. | Parent relationships and visibility match the requested scope; unrelated threads survive. |
| Archived views and deletion | Open global and project archived routes; restore a synthetic thread; delete a disposable thread and cancel a second deletion. | Restore clears archival state; confirmed delete removes only the target; cancellation is inert. |
| Notification center | Generate a local toast, then open Show all notifications; copy and dismiss individual notifications, clear all, hide the center, and reload. | The in-memory toast history supports copy/dismiss/clear; it resets on reload and has no thread-inbox read/link contract. |
| History and route recovery | Navigate app → Settings → Extensions → Back to app, then browser back/forward; reload a deep link and an unknown route. | The intended prior thread and route are restored; unknown paths redirect Home; test missing-resource feedback separately with a well-formed missing thread URL. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- Root compose uses one new-thread draft across project selections. Enter multiline text with Shift+Enter; do not pass literal newlines to dev-browser fill() on the rich editor because they can submit. Source: `apps/app/src/hooks/usePromptDraftStorage.ts:17`.
- Ctrl+K opens thread search. For command actions use Ctrl+Shift+P and preserve the leading > when filling the command search field; removing > switches to thread search. Source: `apps/server/src/services/system/app-keybindings.ts:145`.
- On Linux web, previous/next use Ctrl+Shift+[ and Ctrl+Shift+]; numbered jumps use Ctrl+Shift+1…9. Scope visible sidebar order and await the resulting route. Serialize CLI open/pane commands across all connected profiles. Source: `apps/server/src/services/system/app-keybindings.ts:153`.
- Select Sidebar display options → Manually before creating or organizing sections. By project and By machine do not expose the same manual section controls. Section create/rename/delete are global, while collapsed/order preferences are client-local; inspect source for the supported drag interaction. Source: `apps/app/src/components/sidebar/ProjectList.tsx:575`.
- Both global and project archived routes redirect to /settings/archived. Use its project filter when project-scoped archived results are required; the legacy project URL does not preserve a project filter. Source: `apps/app/src/App.tsx:228`.
- Open >Show all notifications after generating a local toast. Verify Copy notification, Dismiss notification, Clear all, and Hide notifications. This center stores an in-memory toast history; it does not supply a thread-inbox read/link contract and does not persist across reload. Source: `apps/app/src/components/notifications/NotificationCenter.tsx:78`.
- Unknown route paths redirect to Home (/); separately test a well-formed missing thread deep link for visible missing-resource feedback. Do not expect every unknown path to fail visibly. Source: `apps/app/src/views/SplitWorkspaceRoute.tsx:78`.
