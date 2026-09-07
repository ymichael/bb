# Docs vaults and editing

Status: **2026-09-05: 7 passed, 2 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Open the Docs panel; bb docs --help. Add a disposable local vault containing Markdown, HTML, a folder, and an image; use a second host only when available.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/docs/package.json`
- `plugins/docs/server.ts`
- `plugins/docs/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Vault management | Add/list a local and a test-host vault, switch active vault, and remove one. | Vault name/root/host remain distinct; removing registration does not delete unrelated disk data. |
| Tree, search, and folders | Expand folders, search by name/content, create nested folders, and reload. | Tree and search resolve the correct vault path and reflect persisted files. |
| Create, edit, autosave | Create a note and edit paragraphs, headings, lists, code, links, tables, images, and frontmatter. | Saved Markdown retains supported content after reopening; UI save state matches disk completion. |
| Rename, move, delete | Rename a note through its H1, move a fixture file, dismiss one context menu with Escape, then delete a disposable file. | Paths and navigation update coherently; dismissing the menu changes nothing. Selecting Delete deletes immediately. Folder rows have no rename/delete menu. |
| HTML and openers | Open a synthetic HTML document and Markdown via file links and Docs routing. | Correct renderer opens at the selected vault/path; errors do not substitute another document. |
| Mentions and thread cards | Mention a note with @ and render a Docs directive; edit after selecting but before sending. | Resolved agent context follows send-time content; card/panel opens the referenced note and autosave reaches that file. |
| CLI read/write | List/read/write/mkdir/move/remove a fixture through bb docs; compare bytes in UI. | CLI and UI operate on the same vault revision and path. |
| Pull, status, push | Pull into a fresh directory, edit locally, inspect status, push, then exercise a remote revision conflict and explicit deletion. | Only intended changes reach the vault; stale writes conflict and deletion requires the documented explicit action. |
| Unavailable vault and invalid path | Disconnect the test host and request missing/out-of-root paths. | Errors identify the unavailable resource; no write escapes the vault root. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Install builtin:docs if absent; its installed ID is simple-notes. Immediately unregister the default Personal vault in the disposable store without deleting disk data, then add only synthetic vaults. Mention search enumerates every registered vault. A source dev store alone does not isolate the default home-directory vault. Source: `plugins/docs/server.ts:13; plugins/docs/server.ts:774; plugins/docs/server.ts:2878`.
- Create one folder name in the UI at the selected folder/root; use CLI mkdir with a nested path for recursive creation. Do not enter a slash-containing name in the New folder dialog. Source: `plugins/docs/app.tsx:1870`.
- Rename an ordinary note by changing its H1; frontmatter titles preserve the filename. Move files by dragging or the deprecated direct CLI. Folder rows have no rename/delete context menu. Escape cancels the file context menu; selecting Delete deletes immediately without a confirmation dialog. Use synthetic fixtures only. Source: `plugins/docs/app.tsx:1708; plugins/docs/app.tsx:1909`.
- Direct write/mkdir/move/remove remain available but deprecated. Prefer pull, edit local files, status, then push; use explicit --vault for direct operations. Source: `plugins/docs/server.ts:2715`.
