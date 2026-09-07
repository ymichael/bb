# Maintenance audit — 2026-09-05

Tested product source: `d53cec4decab33aef509cc620700ea4dd85d4f9e`.
Only verification documentation changed. The maintenance outcome is **blocked**:
this run found useful corrections and product failures, but did not establish
complete live coverage of every recipe.

**348 recipes assessed: 166 passed, 177 partial/blocked and 5 failed.**

The [recipe ledger](validation-2026-09-05.json) records each of the 348 mapped
recipes, its source review, actual observations, evidence identifiers and
remaining subchecks. Its macOS supplement contains 27 overlapping assessments;
these are not 27 additional features. A full pass requires the complete
applicable recipe. Partial coverage is not a pass, and unfinished checks must
not be mistaken for hardware or authorization blockers.

## Scope and evidence

Workers used the requested model at medium reasoning across two Linux hosts
and a Mac. Test clients included Chromium and Electron, the built source CLI,
the SDK, five real provider integrations, and local hosted services with
synthetic accounts. iOS variants were excluded. Android tooling, Safari remote
automation and native accessibility permissions were checked where relevant;
missing prerequisites remain explicit.

Source stores, browser profiles, cloud state and fixtures were owned by this
run. External GitHub access was read-only. The source inventory still matches
all 61 recorded groups. Its six standalone fixture tests pass. These checks
validate inventory/documentation mechanics; they do not replace app execution.

Raw screenshots, requests and logs stay in private worker archives because they
can contain paths, credentials and provider labels. Ledger evidence strings
identify those archives; they are not repository file links. Source locations
and reusable setup/drive instructions remain in the feature pages.

The scale fixture added one synthetic project, 200 threads and 13,120 events
without resetting the database. In a fresh Chromium profile, an unarchived
212-event thread became ready in 1.838 seconds; the largest observed main-thread
long task was 321 ms. Sidebar/timeline scrolling was exercised. This is a
bounded measurement, not a universal performance pass: incremental updates,
pagination integrity and the windowing comparison remain incomplete.

## Confirmed product failures

| Failure | Reproduction and comparison | Source |
| --- | --- | --- |
| Fallback question expires early | A real fallback question remained pending, then aborted after 300,433 ms with `UND_ERR_BODY_TIMEOUT`, before the configured 600,000 ms input timeout. Normal submission and dismissal worked. | `apps/host-daemon/src/server-client.ts:578`; `apps/server/src/services/plugins/plugin-api.ts:607` |
| Monaco Overwrite cannot resolve a conflict | Modify an open fixture externally, attempt Save, then click Overwrite. Two actual UI attempts remained conflicted and preserved external bytes. Overwrite sends `expectedSha256: null`, which the file writer interprets as create-only. | `plugins/monaco-editor/app.tsx:184`; `plugins/monaco-editor/server.ts`; `apps/host-daemon/src/command-handlers/file-write.ts:157` |
| Diff surrounding context fails with mnemonic prefixes | Set `diff.mnemonicPrefix=true` in a disposable repository only. The UI parser rejects `c/… w/…` or `i/… w/…` headers and context requests carry an empty path, returning 400. Explicit-path CLI reads succeed. Setting the fixture-local option false restores UI context. | `packages/host-workspace/src/workspace.ts:2172`; `apps/app/src/components/git-diff/git-diff-parsing.ts:14`; `apps/app/src/components/secondary-panel/git-diff/useDiffFileContentsRequester.ts:51` |
| Absolute image path breaks the timeline thumbnail | Send the same synthetic PNG first with an absolute `--image` path, then with a project-upload token. Both reach the provider. The absolute-path timeline request incorrectly uses the project attachment endpoint and returns 400; the uploaded image renders and opens in a lightbox. | `apps/app/src/lib/user-attachment-images.ts:10`; `apps/app/src/components/thread/timeline/ThreadTimelineSurface.tsx:240` |
| Theme Preview can stall the whole server | Put an unselected 256,001-space `theme.css` in the custom-theme catalog. Core selection rejects the oversized file, but Theme Preview reads and parses it anyway, causing repeated roughly 38-second event-loop stalls and daemon reconnects. Removing only that fixture restored health without restart. In a separate process, the exact parser regex took 39/149/606/2,429 ms on 8/16/32/64 KB brace-free inputs. | `plugins/theme-preview/server.ts:99`; `plugins/theme-preview/server.ts:148`; `plugins/theme-preview/server.ts:340` |

Expected behavior remains in the recipes. This documentation maintenance did
not fix product code or publish issues. Other observations, including hosted
blog timeouts and native menu callback behavior, lacked a sufficiently isolated
reproduction and remain unconfirmed in the ledger.

## Corrections for the next run

- Unset `BB_CLI` and `BB_CLI_REEXEC` in the isolated test shell, then invoke the
  built source CLI directly. Earlier calls silently used the installed client
  against the source server. Key checks were repeated; unrepeated portions
  retain that qualification. Direct Node also preserves literal newline
  arguments that the pnpm script wrapper changed into backslash-plus-n bytes.
- Restore only synthetic project/thread/environment context after the launcher
  environment helper clears it. Scaffold in a fixture directory using an
  absolute source CLI path. Rich-composer newlines require Shift+Enter.
- Separate profiles share server-directed client controls. Serialize `thread
  open` and pane actions, then reset every browser to its own fixture route.
  Scope menu selectors to visible open content and wait for transitions. In
  headless `hover:none` mode, focus a queue row before acting on its controls.
- A fresh source store does not isolate provider-global skill directories or
  the Docs default home vault. Unregister the default Docs vault without disk
  deletion before searching mentions; use only synthetic vaults.
- Follow observed contracts: terminal restart returns a new ID; initial thread
  provisioning may return a null environment ID; `thread show` wraps thread and
  environment; the thread DTO has no `activeTurnId`. Project Rename belongs to
  project actions, source hosts are immutable, and Commit stages all changes.
- The notification center is transient toast history. Unknown routes redirect
  Home. Side chats use source-fork linkage. Docs deletion is immediate; Secrets
  reconciles its first write conflict. Local cloud needs an owned R2 catalog
  fixture and stream checks must distinguish compression from chunk delivery.

## Remaining work

The ledger is the checklist for a continuation. Major prerequisite gaps include
native Safari/accessibility access, Android hardware/tooling, disposable GitHub
write targets, isolated provider-install/skill-home targets, and controlled
quota/authentication/update fixtures. Other gaps are unfinished subchecks such
as complete provider failure/recovery variants, all-operation SDK parity,
manual ordering, pagination, pending-interaction reconnects and performance
boundaries. They remain distinct from the five reproduced product failures.

A setup incident on the second Linux host produced removal messages for older
versions of five provider/developer tools during a login-shell `mise` command.
The attribution to mise versus shell initialization was unresolved. Current
executables and their pre-existing newer-version links were checked healthy;
there was no before-state evidence proving which older versions were in use.
No speculative global restoration was attempted. Subsequent worker commands
avoided mise and login shells. The private incident record retains the details.

## Cleanup and validation

Workers stopped their owned browsers, runtimes and auxiliary services. The
shared source app was stopped after all workers finished; its three ports
were clear. Original plugin membership/enabled states and settings were
checked and restored. Owned fixture themes, the marked dev store and root
fixture repositories were removed; fixture archives and private evidence were
preserved. Remote workers separately verified their owned ports and stores.

The integrated ledger contains exactly one primary result per mapped recipe.
The source inventory, Markdown links and diff whitespace checks pass; the six
inventory-helper tests passed. These are documentation checks, separate from
the live results above.
