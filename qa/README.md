# QA

This folder is the source of truth for manual and scripted QA in BB.

The goal of this structure is simple:

- QA instructions should be easy to find and follow
- targeted requests like "run QA for the Pi provider" should map to an obvious place
- cross-cutting requests like "run e2e QA and any relevant QA for the code we touched" should also map cleanly
- new scenarios should have an obvious home so QA can grow without collapsing into one giant runbook

## How QA Is Organized

QA is organized by owning surface:

- `server/`
- `env-daemon/`
- `providers/`
- `cli/`
- `environments/`
- `product/`
- `e2e/`

The rule is:

- if one subsystem owns the invariant, that subsystem owns the QA scenario
- `e2e/` is only for thin assembled-system smoke checks

## Quick Starts

Use these when you want the shortest route from request to action:

| If someone says... | Start here | Minimum useful scripted pass |
|---|---|---|
| "run e2e QA" | `qa/e2e/smoke.md` | `pnpm qa:e2e:smoke` |
| "run QA for the Pi provider" | `qa/providers/core.md` + `qa/providers/pi/README.md` | `pnpm qa:providers:core` + `pnpm qa:providers:smoke:pi` |
| "run CLI smoke QA" | `qa/cli/core.md` | `pnpm qa:cli:smoke` |
| "run env-daemon recovery QA" | `qa/env-daemon/recovery.md` | `pnpm qa:env-daemon:recovery` |
| "run environment QA" | `qa/environments/core.md` | `pnpm qa:environments:core` |
| "run provider smoke" | `qa/providers/smoke.md` | `pnpm qa:providers:smoke` |
| "run provider core QA" | `qa/providers/core.md` | `pnpm qa:providers:core` |
| "run server core QA" | `qa/server/core.md` | `pnpm qa:server:core` |
| "run relevant QA for this change" | identify touched surfaces below | start with the closest scripted pass for each touched surface, then add the manual checklist where the docs call for it |

## What Should I Run For A Change?

Use this table when the change is primarily in one area:

| If you changed... | Run... |
|---|---|
| server routes, thread persistence, restart/shutdown behavior | `server/core` |
| env-daemon supervision, reconnect, multi-session behavior | `env-daemon/core` and `env-daemon/recovery` |
| provider bridge/protocol behavior | `providers/core` plus the relevant provider overlay |
| CLI behavior or operator-facing command flows | `cli/core` |
| environment lifecycle or resume behavior | `environments/core` |
| manager mode or other higher-level product semantics | `product/core` |
| cross-cutting or user-visible flows | relevant surface passes plus `e2e/smoke` |

## Request Translation

Use this table to map informal requests to concrete docs and commands:

| Request | Docs | Minimum useful scripted pass |
|---|---|
| "run QA for the Pi provider" | `providers/core.md` + `providers/pi/README.md` | `pnpm qa:providers:core`, then `pnpm qa:providers:smoke:pi` |
| "run provider QA" | `providers/core.md` | `pnpm qa:providers:core` |
| "run env-daemon QA" | `env-daemon/core.md`, then `env-daemon/recovery.md` if needed | `pnpm qa:env-daemon:core`, then `pnpm qa:env-daemon:recovery` when the change is restart/recovery-heavy |
| "run CLI QA" | `cli/core.md` | `pnpm qa:cli:core` |
| "run environment QA" | `environments/core.md` | `pnpm qa:environments:core` |
| "run e2e QA" | `e2e/smoke.md` | `pnpm qa:e2e:smoke` |
| "run relevant QA for this change" | identify touched surfaces, run each surface's default pass, then add `e2e/smoke.md` if the change is cross-cutting or user-visible | there is not always one exact script; use the surface docs plus the closest scripted pass |

## Default Pass Levels

Keep pass levels lightweight:

- `smoke`: fastest confidence check for a surface
- `core`: default regression pass for a surface
- `recovery`: deeper restart/failure/liveness coverage where needed

Not every surface needs all three.

## Where Do New Scenarios Go?

- Add new scenarios to the owning surface first.
- Add something to `e2e/` only if it is truly a top-level smoke behavior.
- Prefer extending an existing pass over creating a new file.
- If a surface lacks the exact depth or automation you want, add it under that surface instead of bolting it into another runbook.

## Shared Guidance

- Pass-level conventions: [`./shared/pass-levels.md`](./shared/pass-levels.md)
- Standalone setup and relaunch workflow: [`./shared/standalone-workflow.md`](./shared/standalone-workflow.md)
- Current automation and coverage audit: [`./shared/coverage-audit.md`](./shared/coverage-audit.md)
- Artifact capture and retention: [`./artifacts/README.md`](./artifacts/README.md)

## Current Surface Entry Points

- Server: [`./server/README.md`](./server/README.md)
- Env-daemon: [`./env-daemon/README.md`](./env-daemon/README.md)
- Providers: [`./providers/README.md`](./providers/README.md)
- CLI: [`./cli/README.md`](./cli/README.md)
- Environments: [`./environments/README.md`](./environments/README.md)
- Product: [`./product/README.md`](./product/README.md)
- E2E: [`./e2e/README.md`](./e2e/README.md)
