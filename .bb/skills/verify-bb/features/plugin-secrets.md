# Secure credential requests

Status: **2026-09-05: 4 passed, 1 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

bb secret request in a synthetic thread with a disposable dotenv file. Enter only dummy values; do not read real credentials into agent context.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/secrets/package.json`
- `plugins/secrets/src/server.ts`
- `plugins/secrets/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Request and labels | Ask for a dummy variable with a purpose and target file; inspect the card. | User sees the exact requested variable/file/purpose and masked entry field. |
| Reveal, submit, cancel | Toggle reveal on a dummy value, submit it, then cancel another request. | Only submission writes; transcript contains completion metadata and no entered value. |
| Dotenv updates | Use fixtures with unrelated entries and request one dummy update; inspect file mode and known synthetic contents locally. | Target value updates with unrelated entries preserved and file permissions set to 0600. |
| Revision conflict | Modify the fixture file between request and submission. | The first conflict rereads and reconciles unrelated entries, then retries once; a second conflict fails without applying the requested write. |
| Validation | Try empty/multiline/oversize dummy values around the declared single-value boundary. | Invalid input fails visibly and does not write partial data or expose the attempted value in logs. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- On the first optimistic write conflict, the plugin rereads and reconciles current dotenv, preserving intervening unrelated entries, then retries once. A second conflict fails without applying its write. Do not expect every first stale snapshot to be rejected. Source: `plugins/secrets/src/server.ts:230`.
