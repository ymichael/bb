# Phase 7 Manual Pass Log

Date: 2026-03-31
Operator: Codex
Standalone workflow: `pnpm qa:standalone:start` / `pnpm qa:standalone:stop`

## Smoke

Status: passed
Provider: codex
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-KCEHSM/standalone-state.json`
Smoke thread: `thr_64rn6hwxmq`
Worktree thread: `thr_gzwk4z34g5`
Worktree environment: `env_777cv7gt96`

Validated:

- Unmanaged thread reached `idle`, produced output, and accepted a follow-up.
- Managed worktree thread reached `idle` and exposed `isWorktree: true`.
- Archive blocked a follow-up; unarchive restored normal operation.

## Multi-Thread And Shared Environment

Status: passed
Providers: codex, claude-code, pi
Shared/mixed standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-JRAHy4/standalone-state.json`
Thread A: `thr_py978vchmv`
Thread A environment: `env_p64gtcfzza`
Thread B: `thr_uct3zhqeeg`
Thread B environment: `env_p64gtcfzza`
Claude thread: `thr_chrzvw2f3y`
Claude environment: `env_j4j8epwn88`
Pi thread: `thr_q4nwi2d8eg`
Pi environment: `env_deju88f66y`
Promote/demote standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-2OS7hG/standalone-state.json`
Promote thread: `thr_62ggqkd8m9`
Promote environment: `env_z2qj5c5ph9`

Validated:

- Thread A and B implicitly reused the same ready direct-workspace environment.
- Interleaved follow-ups stayed distinct and the shared direct workspace remained clean.
- Archiving one sibling did not break the other.
- Mixed-provider threads completed in separate worktree environments with no observed cross-thread event contamination.
- `bb environment commit`, `bb environment promote`, and `bb environment demote` all succeeded on the managed worktree in a targeted standalone rerun after correcting stale runbook CLI flags.

## Recovery

Status: passed
Provider: codex
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-Fzu9HX/standalone-state.json`
Recovery thread: `thr_5jjummpvqs`
Interrupted status before daemon restart: `active`
Final thread status after recovery: `idle`

Validated:

- The server stayed reachable through both daemon restarts.
- The thread remained inspectable after daemon loss.
- After the mid-turn interruption, the thread resumed from `active` and settled back to `idle` after the daemon reconnected.

## Provider-Specific Pass

Status: passed
Providers: codex, claude-code, pi
Codex standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-QHm0lQ/standalone-state.json`
Codex chat thread: `thr_3gsp5q8bfz`
Codex worktree thread: `thr_pdb9uajj27`
Codex worktree environment: `env_evfc882ykv`
Claude standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-ztAykg/standalone-state.json`
Claude chat thread: `thr_sn97d2xewc`
Claude worktree thread: `thr_agwv5sin9z`
Claude worktree environment: `env_dfka8fuzri`
Pi standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-MSIqLC/standalone-state.json`
Pi chat thread: `thr_u9kpnvbk7s`
Pi worktree thread: `thr_6dw9zf8s92`
Pi worktree environment: `env_sa65cajbhh`

Validated:

- Each provider completed a single-turn hello, uppercase follow-up, active-turn stop, and worktree file-creation flow on a fresh standalone run.
- The provider-specific worktree runs exposed readable environment status and produced `hello.txt` with `hello world` where the workspace path was available.

## Notes

- The QA runbook was updated to match the current CLI surface: explicit `--model` flags on `bb thread spawn`, `bb thread show` without the removed `--recent-events` flag, and `bb environment commit/promote/demote` with `--thread`.
- The shared direct-workspace prompts explicitly said not to modify files so the archive check exercised lifecycle behavior instead of workspace dirtiness.
- One combined provider-specific loop hit a transient Pi stop timeout after earlier provider work; isolated per-provider reruns passed, so no reproducible product bug remained in that path.

## Agent CLI Environment

Date: 2026-04-02
Operator: Codex
Status: passed
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-qttTXW/standalone-state.json`
Server URL: `http://127.0.0.1:50429`
Host daemon port: `50430`
Codex CLI smoke thread: `thr_4bhd5pbbaj`
Codex CLI smoke environment: `env_pvtttduv8x`
Bridge provider thread: `thr_hrs7hrmcgw`
Bridge provider: `claude-code`

Validated:

- The codex thread reached `idle` after executing `bb status --json`, `bb guide`, `env | sort | grep '^BB_'`, and `bb thread update --self --title 'CLI Self Rename Smoke'` from inside the provider shell.
- No `command not found: bb` failure occurred. The thread reported `BB_PROJECT_ID=proj_2v4aicwcy5`, `BB_THREAD_ID=thr_4bhd5pbbaj`, `BB_ENVIRONMENT_ID=env_pvtttduv8x`, `BB_SERVER_URL=http://127.0.0.1:50429`, and `BB_HOST_DAEMON_PORT=50430`.
- The thread title changed to `CLI Self Rename Smoke`, confirming that mutating CLI commands work from the injected thread context.
- A real daemon restart was verified twice:
  - first by manually stopping PID `49755` and starting a fresh daemon session, then sending a follow-up to the same thread
  - again with the repaired standalone restart command, which shut down daemon PID `8819` and produced a fresh connected session (`hses_74jgcwdivb`) in the daemon log before the follow-up completed
- After both restarts, the same thread resumed and still reported the same `BB_*` values, including the same `BB_ENVIRONMENT_ID`.
- The `claude-code` bridge-backed thread also reached `idle` and reported the expected `BB_PROJECT_ID`, `BB_THREAD_ID`, `BB_ENVIRONMENT_ID`, `BB_SERVER_URL`, and `BB_HOST_DAEMON_PORT` values from inside its shell.

Notes:

- `bb thread show --self --json` is not currently supported by the CLI; the codex smoke thread reported `unknown option '--self'`. This did not block verification because `bb thread update --self` worked and the follow-up checks used `bb thread show <thread-id> --json`.
- The standalone restart helper was incorrect at the start of QA because it tried to launch a new daemon without stopping the existing one, which correctly failed on the daemon lock. `tests/qa/src/shared.ts` and `tests/qa/src/standalone/start.ts` were updated so the generated restart command now kills the old daemon PID before starting the replacement process.

## Manager CLI

Date: 2026-04-06
Operator: Codex
Status: passed after critical fixes
Core-flow standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-7ESgJX/standalone-state.json`
Scheduling/routing standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-SpMvKV/standalone-state.json`
Codex manager (core flow): `thr_7a3e6av9a3`
Codex manager (scheduling/routing): `thr_c9gaer9gz4`
Pi manager: `thr_epdnikmy8z`
Implementation child: `thr_srga7hm3jp`
Review child: `thr_igdmm42wi8`
Ownership-transfer thread: `thr_ndw9jbmr64`
Routing backend child: `thr_rq9stzj3gi`
Routing frontend child: `thr_4eangjpzgs`

Validated:

- Codex manager hire immediately hatched, reached `idle`, and exposed the meet-and-greet through `bb thread output`.
- Manager updates now flow through `message_user` end to end; live logs show successful `message_user` tool calls and persisted `system/manager/user_message` events.
- A substantive backend task was delegated to a child thread, followed by a same-environment review thread, then triaged back to the original worker before the final user update.
- Manager completion handling now uses automated managed-thread completion signals. The manager log shows system-driven `client/turn/requested` entries for completion, ownership assigned, and ownership removed.
- Ownership transfer via `bb thread update --parent-thread` and `--clear-parent-thread` triggered manager follow-up turns as expected.
- Provider-routing preferences worked in a live parallel request:
  - backend child used `providerId: codex`
  - frontend child used `providerId: claude-code`
- Pi manager smoke passed with `anthropic/claude-opus-4-6` / `medium`; the Pi manager reached `idle` and produced a visible hatch message.
- Reminder scheduling passed after tightening the manager instructions:
  - `ASYNC.md` contained `cron: "17 0 * * *"`
  - `manager_thread_nudges` contained `thr_c9gaer9gz4|backend-port-cleanup-check|17 0 * * *|America/Los_Angeles|1775546220000`

Critical issues fixed during the pass:

- dynamic `message_user` forwarding used provider thread ids instead of BB thread ids
- manager completion / ownership control messages were not wired on the server
- `bb thread output` dropped manager-visible messages when a later assistant item was empty
- manager reminder generation could produce unsupported date-specific cron in `ASYNC.md`

Residual notes:

- The manager no longer relied on polling loops to detect completion, but live logs still showed a small number of `bb thread show --json` inspections while reviewing completed child results. This did not behave like tight completion polling, but it remains worth watching.

## Pi Manager Parity Rerun

Date: 2026-04-07
Operator: Codex
Status: passed after Pi-specific critical fixes
Pi full-flow standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-ydj2ZY/standalone-state.json`
Pi scheduling-timezone standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-lZ8167/standalone-state.json`
Pi archive standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-leqi3T/standalone-state.json`
Pi full-flow manager: `thr_iini5qeeii`
Pi ownership/scheduling manager: `thr_et5zkcpnx7`
Pi scheduling-timezone manager: `thr_xdd955ybte`
Pi archive manager: `thr_xt5yisgw67`
Backend implementation child: `thr_syvuknesb9`
Initial same-environment review child: `thr_6csnzj8czc`
Fallback same-environment review child: `thr_2bkyfxxjgy`
Routing backend child: `thr_95bwwbe36k`
Routing frontend child: `thr_8v9y6q9z9m`
Routing frontend fallback child: `thr_xdh4m83529`
Ownership-transfer thread: `thr_b7qfaizahx`
Archived helper thread: `thr_ydwh24qkxp`

Validated:

- Pi managers now hatch immediately, send a visible meet-and-greet through `message_user`, and persist routing/update preferences in `PREFERENCES.md`.
- After tightening the worker-model guidance, the Pi manager stopped spawning unsupported Codex models and delegated backend work directly to `gpt-5.3-codex` / `medium`.
- A substantive backend task was delegated, reviewed in the same environment, triaged back to the original worker, and closed out with a final user update.
- Pi multi-thread fan-out worked in a live parallel request:
  - backend child used `providerId: codex`
  - frontend child used `providerId: claude-code`
- When `claude-code` failed because the local OAuth token was expired, the Pi manager recovered by retrying the affected work with codex rather than stalling.
- Ownership transfer via `bb thread update --parent-thread` and `--clear-parent-thread` triggered the expected Pi-manager follow-up turns and user-visible updates.
- Reminder scheduling passed after the local-timezone fix:
  - `ASYNC.md` contained `timezone: America/Los_Angeles`
  - `manager_thread_nudges` rows for `thr_xdd955ybte` used `America/Los_Angeles`
- Archive judgment passed in a focused helper-thread flow: Pi manager `thr_xt5yisgw67` summarized a one-off codex research thread and archived `thr_ydwh24qkxp` afterward.

Critical issues fixed during the Pi rerun:

- Pi managers could guess unsupported worker model ids like `o4-mini` instead of using current CLI-valid defaults
- Pi managers could default reminder-style `ASYNC.md` schedules to `UTC` instead of the local reminder timezone

Residual notes:

- `claude-code` remains blocked by a local expired OAuth token in this environment. Pi managers still routed work to `claude-code` correctly, but the live pass had to rely on codex fallbacks to complete those tasks.
- No tight completion-polling loop was observed in the Pi reruns. Managers still used occasional inspection commands while reviewing child output, but completion itself came from manager system messages rather than repeated polling.

## Full Manual QA Pass

Date: 2026-04-16
Operator: Codex
Status: passed after critical fixes
Standalone workflow: `pnpm qa:standalone:start` / `pnpm qa:standalone:stop`
Primary standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-z2RVe2/standalone-state.json`
Fixed restart/Pi rerun state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-0C0WIF/standalone-state.json`
Resolved models: `codex=gpt-5.4`, `claude-code=haiku`, `pi=openai/gpt-5.4`

Smoke:

- Codex smoke thread: `thr_pesazetcww`
- Codex worktree thread: `thr_6zbc9pc3qe`
- Codex worktree environment: `env_tdrjhktwfx`

Multi-thread and shared environment:

- Thread A: `thr_rekefdkm2k`
- Thread B: `thr_cht9if5nxn`
- Shared direct environment: `env_4ji9ce59ua`
- Claude mixed-provider thread: `thr_i9ft232pzw`
- Claude mixed-provider environment: `env_swzu5w7pwx`
- Pi mixed-provider thread: `thr_4d9pwj4hpu`
- Pi mixed-provider environment: `env_hcphu3pd6k`
- Promote/demote thread: `thr_vjwg24zidc`
- Promote/demote environment: `env_mhqq4xrcuj`

Recovery:

- Recovery smoke thread: `thr_pesazetcww`
- Graceful restart daemon PID: `22493`
- Interrupted restart daemon PID: `22840`
- Thread state after interrupted restart: `idle`
- Fixed restart smoke thread: `thr_z3g63i9i8b`
- Fixed restart daemon PID: `41789`

Provider-specific pass:

- Codex chat thread: `thr_abhfxsvsh4`
- Codex worktree thread: `thr_ajhwrhyp6r`
- Codex worktree environment: `env_nfu772x7ux`
- Claude chat thread: `thr_4pqj6t7mtt`
- Claude worktree thread: `thr_kcsmgijef5`
- Claude worktree environment: `env_a9yr4u9w7j`
- Pi chat thread after fixed restart: `thr_6whmwuw8hv`
- Pi worktree thread after fixed restart: `thr_nfwsugtfyw`
- Pi worktree environment after fixed restart: `env_frcj64ef74`

Validated:

- Standalone health checks passed: server config, hosts, `bb status`, provider list, and provider model discovery.
- Codex smoke reached `idle`, produced output, accepted a follow-up, created a managed worktree file, and exposed environment status/diff routes.
- Archive rejected `bb thread tell` while archived; unarchive restored follow-up operation.
- Thread A and B reused the same direct environment, and alternating follow-ups stayed distinct.
- Archiving Thread A did not block Thread B.
- Mixed-provider worktree threads reached `idle` in separate environments with no observed event cross-contamination.
- `bb environment commit`, `bb environment promote`, and `bb environment demote` succeeded on the managed worktree using the current CLI syntax.
- Graceful daemon restart left the server reachable, host status recovered to `connected`, and the smoke thread accepted a follow-up.
- Mid-turn daemon loss left the thread inspectable; after restart it was `idle` and accepted a `recovery ok` follow-up.
- Codex, Claude Code, and Pi provider-specific chat flows completed hello, uppercase follow-up, active-turn stop, and worktree `hello.txt` creation with readable environment status.
- The fixed restart command reloaded `.env` for the replacement daemon; Pi provider-specific checks passed after that restart.

Critical issues fixed during the pass:

- `qa/manual-runbook.md` hard-coded stale provider model IDs. The runbook now resolves current models through `bb provider models` and uses `CODEX_MODEL`, `CLAUDE_MODEL`, and `PI_MODEL`.
- `qa/manual-runbook.md` still documented removed `--thread` flags for `bb environment commit/promote/demote`; those commands now match the current CLI.
- Bare bridge error notifications from Pi/Claude could leave threads stuck in `provisioning` because no terminal turn event was emitted. Bridge adapters now synthesize a failed turn for thread-scoped bridge errors, with regression coverage in `@bb/agent-runtime`.
- The standalone daemon restart command did not reload the `.env` used by the original daemon, which dropped provider credentials after restart. The generated restart command now sources the env file without embedding secrets in state, with `@bb/qa` regression coverage.

Residual notes:

- The first Codex smoke attempt failed before the runbook model fix because `gpt-5` is rejected for the local ChatGPT-backed Codex account.
- The first Pi provider-specific attempt after the old restart command exposed the stuck-provisioning bug as `thr_9mk73wn3af`; after the bridge-error and restart-env fixes, the targeted Pi rerun passed.
- The mixed Claude worktree thread reached `idle` but returned a generic acknowledgement instead of the exact requested text. The isolated Claude provider-specific pass later returned the exact hello/uppercase responses and created `hello.txt`.
- Host-daemon logs still include expected warnings for unsupported `thread.rename` on `claude-code` and `pi`; these did not block thread completion.
