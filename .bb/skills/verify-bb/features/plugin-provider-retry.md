# Automatic provider retry

Status: **2026-09-05: 5 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Enable Provider retry; use controlled provider failures and short test reset times. Inspect bb provider-retry --help or plugin commands for current forms.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/provider-retry/package.json`
- `plugins/provider-retry/server.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Transient overload | Trigger a known retryable overload and inspect queued retries across attempts. | Backoff follows configured policy and stops at its attempt limit; original error remains visible. |
| Subscription reset | Trigger a supported limit error with a known reset timestamp. | Retry is scheduled from that reset within the maximum-wait policy, not an arbitrary guessed delay. |
| Send now and cancel | Inspect retry status, manually retry now, then cancel another scheduled attempt. | Exactly one intended follow-up is dispatched; canceled retries never fire. |
| Permanent failures | Exercise unsupported/auth/credit/spend failures from existing provider error fixtures. | Non-retryable errors do not silently generate repeated paid attempts. |
| Maximum wait and recovery | Change supported maximum-wait settings, then restart the test runtime with a pending retry. | Eligibility and persisted retry state follow configuration; success clears stale retry bookkeeping. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.
