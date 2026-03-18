# Goal

Audit and improve the `bb` CLI so it is well-designed, consistent, and complete enough for agents and users to operate bb entirely from the command line.

**Inclusion rule:** Expose API endpoints that support agent or product workflows. Internal plumbing endpoints (session management, queue dispatch) and UI-only concerns (read/unread state) are excluded unless there's a concrete CLI use case.

# Scope

In scope:

- Command table with current flags and `--json` status
- Redundant command analysis and deprecation proposals
- Missing CLI commands for API endpoints that serve agent workflows
- Missing backend flags not yet exposed in the CLI
- Thread ID argument safety policy
- `--json` enforcement (test is shipped; factory deferred)

Out of scope:

- Implementing all proposed changes (this is the audit; implementation is separate work)
- The `bb environment-agent` command (long-running server, intentionally excluded from `--json`)

---

# Implementation Steps

## 1. Command Table (current state)

All commands now support `--json` (enforced by `apps/cli/src/__tests__/json-flag-enforcement.test.ts`). The table below reflects the current CLI after all P0 work.

### `bb status`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb status` | `--json` | |

### `bb project`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb project list` | `--json` | |
| `bb project show <id>` | `--json` | |
| `bb project create` | `--name` (required), `--root` (required), `--json` | |
| `bb project update <id>` | `--name`, `--root`, `--project-instructions`, `--default-provider`, `--json` | |
| `bb project delete <id>` | `--yes`, `--json` | |
| `bb project files <query>` | `--project`, `--limit`, `--json` | |

### `bb provider`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb provider list` | `--json` | |
| `bb provider models [providerId]` | `--json` | |

### `bb thread`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb thread spawn` | `--prompt`, `--json`, `--project`, `--environment`, `--new-environment`, `--parent-thread`, `--provider`, `--model`, `--reasoning-level`, `--service-tier`, `--sandbox-mode`, `--title`, `--no-context-parent-thread` | |
| `bb thread list` | `--project`, `--parent-thread`, `--include-archived`, `--include-work-status`, `--json` | |
| `bb thread show [id]` | `--json`, `--recent-events`, `--event-mode`, `--include-low-signal`, `--work-status`, `--git-diff`, `--diff-selection`, `--diff-merge-base`, `--merge-base-branches` | Merged `thread status` flags into `show` |
| `bb thread output [id]` | `--json` | |
| `bb thread log [id]` | `--json`, `--format` | `--json` aliases `--format json` |
| `bb thread sessions [id]` | `--json` | |
| `bb thread tell <id> <message>` | `--json`, `--model`, `--reasoning-level`, `--mode` | `--mode steer` replaces old `thread steer`. Missing: `--service-tier`, `--sandbox-mode`, `--demote-primary-if-needed` |
| `bb thread update [id]` | `--json`, `--title`, `--parent-thread`, `--clear-parent-thread`, `--merge-base-branch` | |
| `bb thread wait [id]` | `--status`, `--event`, `--timeout`, `--poll-interval`, `--json` | |
| `bb thread commit <id>` | `--message`, `--staged-only`, `--json` | |
| `bb thread squash-merge <id>` | `--commit-if-needed`, `--staged-only`, `--commit-message`, `--squash-message`, `--merge-base-branch`, `--json` | |
| `bb thread stop <id>` | `--json` | |
| `bb thread archive [id]` | `--force`, `--json` | |
| `bb thread unarchive [id]` | `--json` | |
| `bb thread delete [id]` | `--yes`, `--json` | |
| `bb thread promote <id>` | `--json` | |
| `bb thread demote [id]` | `--project`, `--json` | |
| `bb thread promote-status` | `--project`, `--json` | |

### `bb manager`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb manager hire [projectId]` | `--project`, `--title`, `--provider`, `--model`, `--json` | Dual positional/flag for project ID |
| `bb manager list [projectId]` | `--project`, `--json` | Dual positional/flag for project ID |
| `bb manager status <id>` | `--json` | Manager-specific: shows manager + managed threads |
| `bb manager delete <id>` | `--yes`, `--json` | |

### `bb daemon`

| Command | Flags | Notes |
|---------|-------|-------|
| `bb daemon health` | `--json` | |
| `bb daemon restart` | `--force`, `--json` | |

## 2. Redundancy analysis

### `thread show` vs `thread status` — DONE

Merged into `bb thread show` with all of `status`'s event flags. Hidden `thread status` alias removed.

### `thread tell` vs `thread steer` — DONE

`--mode steer` added to `tell`. Hidden `thread steer` alias removed.

### `manager threads` / `manager send` / `manager log` — DONE

All three removed. The canonical `bb thread` commands (`thread list --parent-thread`, `thread tell`, `thread log`) are the only path. Templates and QA docs updated.

## 3. Thread ID argument safety policy

Current state is inconsistent. Some commands require explicit `<id>`, others default to `BB_THREAD_ID` via `[id]`.

**Policy:**
- **Read-only inspection** (`show`, `status`, `output`, `log`, `sessions`, `wait`, `promote-status`): env fallback allowed (`[id]`).
- **Non-destructive messaging** (`tell`, `steer`): env fallback allowed. These are the most common agent operations and agents run with `BB_THREAD_ID` set.
- **Repo-mutating operations** (`commit`, `squash-merge`, `promote`): env fallback allowed — these always operate on the calling thread's own worktree, so ambient context is correct.
- **Destructive/irreversible operations** (`delete`): require explicit `<id>`. Too dangerous to default from env.
- **Lifecycle operations** (`archive`, `unarchive`, `stop`): require explicit `<id>`. These change thread state in ways that could be surprising if the wrong thread is targeted.
- **Update operations** (`update`): env fallback allowed — the flags make the intent explicit.

**Current violations:**
- `archive [id]`, `unarchive [id]`, `delete [id]` currently default to env. `delete` should require explicit ID. `archive`/`unarchive` should also require explicit ID per the policy above.
- `tell <id>`, `steer <id>`, `commit <id>`, `stop <id>`, `promote <id>` currently require explicit ID. `tell`/`steer`/`commit`/`squash-merge`/`promote` could allow env fallback.

## 4. Missing CLI commands for agent workflows

| API Endpoint | Proposed CLI | Status | Rationale |
|-------------|-------------|--------|-----------|
| `GET /threads/:id/work-status` | `bb thread show --work-status` | DONE | Collapsed into `thread show` flag |
| `GET /threads/:id/git-diff` | `bb thread show --git-diff` | DONE | Collapsed into `thread show` flag |
| `GET /projects/:id` | `bb project show <id>` | DONE | |
| `PATCH /projects/:id` | `bb project update <id>` | DONE | |
| `DELETE /projects/:id` | `bb project delete <id>` | DONE | |
| `GET /threads/:id/merge-base-branches` | `bb thread show --merge-base-branches` | DONE | Collapsed into `thread show` flag |
| `GET /system/status` | — | Won't do | `daemon health --json` covers this; not worth a separate command |
| `GET /threads/:id/default-execution-options` | — | Won't do | Internal plumbing, not an agent workflow |
| `GET /projects/:id/workspace-status` | — | Won't do | Subsumed by `thread work-status` per-thread |
| `GET /system/environments` | — | Won't do | Environment types are fixed (`local`, `worktree`, `docker`); no discovery needed |
| `GET /environments` / `GET /environments/:id` | — | Won't do | Environment records are implementation details; agents use `thread show --json` to get attached environment |
| `POST /threads/:id/read` / `unread` | — | Won't do | UI-only read state, no CLI use case |
| `POST /threads/:id/queue` | — | Won't do | Internal queue dispatch, agents use `thread tell` |

## 5. Missing backend flags

| Command | Missing Flag | Backend Field | Status |
|---------|-------------|---------------|--------|
| `thread spawn` | `--service-tier` | `serviceTier` | DONE |
| `thread spawn` | `--sandbox-mode` | `sandboxMode` | DONE |
| `thread spawn` | `--developer-instructions` | `developerInstructions` | Won't do — internal plumbing |
| `thread tell` | `--service-tier` | `serviceTier` | Won't do — agents rarely change mid-conversation |
| `thread tell` | `--sandbox-mode` | `sandboxMode` | Won't do — agents rarely change mid-conversation |
| `thread tell` | `--demote-primary-if-needed` | `demotePrimaryIfNeeded` | Won't do — niche |
| `thread update` | `--merge-base-branch` | `mergeBaseBranch` | DONE |
| `thread list` | `--include-work-status` | `includeWorkStatus` | DONE |

## 6. `--json` enforcement

**Done.** All commands now support `--json`. Enforced by introspection test at `apps/cli/src/__tests__/json-flag-enforcement.test.ts` that walks the Commander.js command tree and fails if any leaf command (except `environment-agent`) is missing `--json`.

Note: `bb thread log` has special `--json` semantics (alias for `--format json`). This is intentional and documented. The enforcement test checks for the flag's existence, not its behavior.

# Validation

- `--json` enforcement: test exists and passes (`apps/cli/src/__tests__/json-flag-enforcement.test.ts`)
- For new commands: add tests in `apps/cli/src/__tests__/command-output.test.ts` covering both human and JSON output modes
- For flag additions: verify via `--help` and with actual API calls
- For deprecations: deprecated commands have been removed (P2 cleanup); CLI guide and workflow templates updated
- Package-scoped validation: `pnpm exec turbo run typecheck --filter=@bb/cli` and `pnpm exec turbo run test --filter=@bb/cli`

# Open Questions/Risks

- `archive` and `unarchive` currently default to `BB_THREAD_ID`. The thread ID safety policy says destructive/lifecycle ops should require explicit ID, but changing this would break existing agent workflows. Low priority to fix.
