# GitHub issues and pull requests

Status: **2026-09-05: 2 passed, 6 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

GitHub panel; bb github --help. Use cached synthetic/read-only fixtures first; live writes need an authorized disposable GitHub repository and authenticated gh.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/github/package.json`
- `plugins/github/server.ts`
- `plugins/github/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Repository discovery | Add a project with a test GitHub origin and configure an extra tracked repo/default project. | Tracked repository membership follows project sources plus explicit configuration without duplicates. |
| Browse and filters | Open issues and PRs, change available filters, select an item and reload its detail. | Rows, counts, selected repo, and detail correspond to the requested filter and cached forge data. |
| Refresh and errors | Trigger manual sync, observe background refresh, then test missing auth and unreachable forge. | Freshness/failures are visible; stale cache is not presented as a successful fresh fetch. |
| Issue creation and editing | In the disposable repo, create an issue and change offered metadata, then verify through gh. Existing issue body/title editing is not exposed. | Forge data matches submitted changes; canceled edits do not write externally. |
| Comments, labels, assignment, state | Add a test comment and change supported labels/assignee/open state. | Only the chosen issue/PR receives changes; permissions/errors remain visible. |
| Delegate and review | Send an issue or PR to a synthetic agent thread using the offered action and project target. | Thread context/linkage identifies the exact item and selected checkout; no automatic merge is implied. |
| Mentions | Resolve GitHub items through @/# mention entry points and send a read-only summarization request. | Agent receives the intended item and current resolved context with a working source link. |
| Agent interface | Compare CLI repos/issues/prs/sync with the panel and registered plugin commands. | Both surfaces use the same tracked cache; an unknown valid repository returns an empty cache, while malformed names are rejected. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Exercise New issue with repository, title and description, then cancel or create only in an authorized disposable repository. Existing issue title/body editing is not exposed by this plugin contract; do not require an unavailable edit action. Source: `plugins/github/server.ts:238`.
- Add a test comment and change supported labels/assignees/state in an authorized disposable repository. Existing-comment editing is not exposed; omit that unavailable substep. Source: `plugins/github/server.ts:167`.
- Compare CLI and panel cache. For an unknown syntactically valid repository, record the current empty-cache response (`Nothing cached...` / `{items:[]}`); malformed names are rejected. Do not claim a dedicated unknown-tracked-repository error. Source: `plugins/github/server.ts:1683`.
