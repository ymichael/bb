# Phase 7 Manual Pass Log

Date: 2026-03-25
Operator: Codex
Standalone workflow: `scripts/qa/start-standalone.mjs` / `scripts/qa/stop-standalone.mjs`

## Smoke

Status: passed
Provider: codex
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-i2efMP/standalone-state.json`
Smoke thread: `thr_jvnq48jgp7`
Worktree thread: `thr_bf8p52jgr8`
Worktree environment: `env_24xe9evnx2`

Validated:

- Unmanaged thread reached `idle`, produced output, and accepted a follow-up.
- Managed worktree thread reached `idle` and exposed `isWorktree: true`.
- Archive blocked a follow-up; unarchive restored normal operation.

## Multi-Thread And Shared Environment

Status: passed
Providers: codex, claude-code, pi
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-MvaKeJ/standalone-state.json`
Thread A: `thr_y89dfkcqkb`
Thread A environment: `env_66em8vn5bq`
Thread B: `thr_iz2ph26hie`
Thread B environment: `env_66em8vn5bq`
Claude thread: `thr_he43g5c9em`
Claude environment: `env_mncxpesd7f`
Pi thread: `thr_e4r23vm7xz`
Pi environment: `env_ve7wz6rrrv`
Promote thread: `thr_bvh7295s9e`
Promote environment: `env_m9akffb4v6`

Validated:

- Thread A and B implicitly reused the same ready direct-workspace environment.
- Interleaved follow-ups stayed distinct and the shared direct workspace remained clean.
- Archiving one sibling did not break the other.
- Mixed-provider threads completed in separate worktree environments with no observed cross-thread event contamination.
- `bb environment commit`, `bb environment promote`, and `bb environment demote` all succeeded on the managed worktree.

## Recovery

Status: passed
Provider: codex
Standalone state path: `/var/folders/lr/f3ynv4xj6p77kvx_rz7zgzg00000gn/T/bb-standalone-mBV03E/standalone-state.json`
Recovery thread: `thr_78g9hxajuc`
Interrupted status before daemon restart: `error`
Post-restart state before final recovery turn: `error`

Validated:

- The server stayed reachable through both daemon restarts.
- The thread remained inspectable after daemon loss.
- After the mid-turn interruption, the thread converged to an explicit `error` state, the daemon reconnected, and a short new turn completed successfully.

## Notes

- The shared direct-workspace prompts explicitly said not to modify files so the archive check exercised lifecycle behavior instead of workspace dirtiness.
- Worktree promotion requires a clean primary checkout and an explicit `bb environment commit` on the managed environment before `bb environment promote`.
- During recovery after a mid-turn interruption, the thread may resume `active` work or settle to `idle`/`error`; the runbook now handles both cases.
