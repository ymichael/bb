# QA

This folder is the top-level landing page for manual and scripted QA in Beanbag.

When we ask someone to **do a full QA pass**, start here.

## Purpose

Use this folder to:

- find the current QA runbooks
- understand which pass to run for a given change
- record and expand repeatable QA coverage over time
- keep QA guidance centralized instead of scattering it across docs and ad hoc notes

## Current QA Entry Points

### Full daemon/env-agent QA pass

Use the standalone daemon CLI QA guide:

- [`./daemon/standalone-daemon-qa.md`](./daemon/standalone-daemon-qa.md)

This is currently the primary full QA pass for validating:

- daemon startup and restart behavior
- thread lifecycle behavior
- env-agent liveness and recovery
- worktree flows
- CLI behavior against a real running daemon

## QA tiers

The standalone daemon QA guide defines three named tiers. Use these names when requesting a QA pass:

| Tier | Scope | Time | When to use |
|---|---|---|---|
| **Light QA pass** | start + follow-up + steer + worktree basics + provider verification | ~5 min/provider | Every PR, all providers |
| **Extended QA pass** | + stop/follow-up, archive/unarchive, promote/demote, rapid follow-ups | ~15 min/provider | Lifecycle or state changes |
| **Full QA pass** | + all restart/recovery, worker loss, session replacement, shared env | ~30 min | Big daemon/env-agent changes |

See [`./daemon/standalone-daemon-qa.md` § QA Tiers](./daemon/standalone-daemon-qa.md#qa-tiers) for the complete checklist per tier.

## How to use this folder

If you are asked to run a QA pass:

1. Identify the tier: **light**, **extended**, or **full**.
2. Start with the relevant guide linked from this README.
3. Run the entire checklist for that tier, not just the first scenario that seems relevant.
4. Record pass/fail for each case.
5. Keep logs, command output, and any failure artifacts until triage is complete.
6. Note whether the failure is:
   - a product bug
   - a flaky/timing-sensitive test case
   - a stale QA expectation/documentation issue

## QA Principles

Our QA direction is to make passes:

- **reliable**: assert durable lifecycle invariants, not fragile timing details
- **operator-oriented**: prefer supported CLI/API surfaces over shell parsing
- **invariant-friendly**: prefer `bb thread wait` and `bb thread sessions` over ad hoc sleep loops or raw DB checks
- **efficient**: make failures easy to triage without rediscovering the system manually
- **maintainable**: keep docs, invariants, and harness behavior aligned with architecture changes

## Expected evolution of this folder

Over time, this folder should become the home for:

- QA runbooks by subsystem
- smoke / stress / regression pass definitions
- links to automation entrypoints and artifact locations
- guidance for collecting failure bundles
- a changelog of newly added regression scenarios when useful

Current daemon QA docs:

- `qa/daemon/standalone-daemon-qa.md`
- `qa/daemon/smoke.md`
- `qa/daemon/lifecycle-invariants.md`
- `qa/daemon/stress.md`
- `qa/daemon/regressions.md`
- `qa/artifacts/README.md`

## Automation entrypoints

For checked-in daemon/env-agent automation tiers:

- `pnpm qa:daemon:manual-smoke`
- `pnpm qa:daemon:smoke`
- `pnpm qa:daemon:smoke:claude-code`
- `pnpm qa:daemon:smoke:pi`
- `pnpm qa:daemon:stress`
- `pnpm qa:daemon:regression`
- `pnpm qa:daemon:recovery:fake`

Provider coverage split:

- `qa:daemon:manual-smoke`, `qa:daemon:smoke`, `qa:daemon:stress`, and `qa:daemon:regression` use the real Codex provider.
- `qa:daemon:smoke:claude-code` runs the same scripted smoke suite against the Claude Code provider (requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`).
- `qa:daemon:smoke:pi` runs the same suite against the Pi provider (requires `pi` in PATH with auth configured via `~/.pi/agent/auth.json`).
- `qa:daemon:recovery:fake` is the deterministic fake-provider recovery suite for worker-loss and forced-recovery paths that real-provider automation cannot reliably drive.

Use the standalone daemon guide when you need the full direct-binary workflow and exhaustive scenario checklist.

Likely future additions:

- `qa/app/`
- `qa/regressions/`

The daemon/env-agent QA roadmap has been completed; keep this folder updated directly as the source of truth for future QA changes.
