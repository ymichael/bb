# Goal

Audit the `bb` CLI from the perspective of a manager agent and close the gaps between what the backend supports and what the CLI exposes. The manager uses the CLI as its primary interface for coordinating work — missing flags and awkward ergonomics directly degrade manager behavior.

# Scope

In scope:

- Every CLI command a manager might use, mapped to concrete manager operations
- Missing flags where the backend already supports the functionality
- Ergonomic issues that make non-interactive agent use harder
- Prioritized task list for closing the gaps

Out of scope:

- New backend functionality (this is CLI-only)
- UI changes
- New commands that don't have backend support yet

---

# Manager Operations → CLI Mapping

## 1. Spawn a worker thread for a task

**Command:** `bb thread spawn`

The most important manager operation. The manager needs to create a named worker with the right model, give it instructions, and link it as a managed child.

**Currently exposed:**
- `--prompt`, `--project`, `--environment`, `--parent-thread`, `--provider`, `--no-context-parent-thread`, `--json`

**Recently added:**
- `--title` — ~~managers can't name worker threads~~ DONE
- `--model` — ~~managers can't pick the model~~ DONE
- `--service-tier` — can't specify fast/flex tier.
- `--reasoning-level` — can't control reasoning depth (low/medium/high/xhigh).
- `--sandbox-mode` — can't control sandbox access level.
- `--developer-instructions` — can't inject custom system instructions for the worker.

**Priority:** P0 for `--title` and `--model`. P1 for the rest.

---

## 2. Check on a worker thread

**Command:** `bb thread status`

**Currently exposed:** `--json`, `--recent-events`, `--event-mode`, `--include-low-signal`

**Status:** Good. No gaps. Machine-readable output works well.

---

## 3. Get a worker's result

**Command:** `bb thread output`

**Currently exposed:** `--json`

**Status:** Good. No gaps.

---

## 4. List managed threads

**Command:** `bb thread list`

**Currently exposed:** `--project`, `--parent-thread`

**Recently added:**
- `--json` — ~~no machine-readable output~~ DONE

**Still missing:**
- `--include-archived` — can't see archived threads.
- `--include-work-status` — can't get work status inline with the list.

**Priority:** P0 for `--json`. P1 for `--include-archived` and `--include-work-status`.

---

## 5. Send a follow-up to a worker

**Command:** `bb thread tell`

**Currently exposed:** `--json`

**Missing (backend supports these):**
- `--model` — can't change model for this message.
- `--service-tier` — can't specify tier.
- `--reasoning-level` — can't control reasoning.
- `--sandbox-mode` — can't control sandbox.
- `--demote-primary-if-needed` — can't auto-demote.

**Priority:** P2. These are advanced knobs. The default behavior works for most delegation.

---

## 6. Steer an active worker

**Command:** `bb thread steer`

**Currently exposed:** No flags at all.

**Missing:**
- `--json` — inconsistent with `tell`.
- Same model/tier/reasoning/sandbox flags as `tell`.

**Priority:** P2 for `--json`. P2 for the rest.

---

## 7. Rename a thread

**Command:** `bb thread update`

**Currently exposed:** `--json`, `--parent-thread`, `--clear-parent-thread`

**Recently added:**
- `--title` — ~~can't rename threads~~ DONE
- `--merge-base-branch` — can't set merge base via CLI.

**Priority:** P0 for `--title`. P2 for `--merge-base-branch`.

---

## 8. Transfer thread ownership

**Command:** `bb thread update --parent-thread / --clear-parent-thread`

**Status:** Good. Both directions work. No gaps.

---

## 9. Archive / delete a thread

**Commands:** `bb thread archive`, `bb thread delete`

**Status:** Good. Archive is non-interactive. Delete requires `--yes` to skip confirmation, which is appropriate.

---

## 10. Request a commit

**Command:** `bb thread commit`

**Currently exposed:** `--message`, `--staged-only`

**Missing (backend supports):**
- `--auto-archive-on-success` — can't auto-archive after commit.

**Priority:** P1. Useful for manager cleanup workflows.

---

## 11. Request a squash merge

**Command:** `bb thread squash-merge`

**Currently exposed:** `--commit-if-needed`, `--staged-only`, `--commit-message`, `--squash-message`, `--merge-base-branch`

**Missing (backend supports):**
- `--auto-archive-on-success` — can't auto-archive after merge.

**Priority:** P1. Same as commit.

---

## 12. Promote / demote a worktree

**Commands:** `bb thread promote`, `bb thread demote`, `bb thread promote-status`

**Status:** Good. No gaps.

---

## 13. Hire a manager

**Command:** `bb manager hire`

**Currently exposed:** `--project`, `--json`, `--provider`, `--model`, `--title`

**Status:** All flags added. DONE.

---

## 14. Inspect another manager

**Commands:** `bb manager status`, `bb manager threads`, `bb manager log`, `bb manager show`

**Status:** Good. All provide `--json`. Sufficient for cross-manager coordination.

---

## 15. Message another manager

**Command:** `bb manager send`

**Currently exposed:** `--json`

**Status:** Good. Also possible via `bb thread tell`. No gaps.

---

## 16. Show thread details (environment/branch info)

**Command:** `bb thread show`

**Currently exposed:** `--json`

**Gap:** Returns environment path but not the git branch name. A manager inspecting a completed worker can't easily see what branch the work landed on without shelling out to git.

**Priority:** P2. Workaround exists (inspect the worktree path).

---

# Task List

## P0 — Blocks manager quality (DONE)

- [x] Add `--title` to `bb thread spawn`
- [x] Add `--model` to `bb thread spawn`
- [x] Add `--title` to `bb thread update`
- [x] Add `--json` to `bb thread list`
- [x] Add `--provider` to `bb manager hire`
- [x] Add `--model` to `bb manager hire`
- [x] Add `--title` to `bb manager hire`
- [x] Add `bb provider list` and `bb provider models` commands

## P1 — Improves manager workflows

- [ ] Add `--service-tier` to `bb thread spawn`
- [ ] Add `--reasoning-level` to `bb thread spawn`
- [ ] Add `--sandbox-mode` to `bb thread spawn`
- [ ] Add `--developer-instructions` to `bb thread spawn`
- [ ] Add `--include-archived` to `bb thread list`
- [ ] Add `--include-work-status` to `bb thread list`
- [ ] Add `--auto-archive-on-success` to `bb thread commit`
- [ ] Add `--auto-archive-on-success` to `bb thread squash-merge`

## P2 — Nice to have

- [ ] Add `--model`, `--service-tier`, `--reasoning-level`, `--sandbox-mode` to `bb thread tell`
- [ ] Add `--demote-primary-if-needed` to `bb thread tell`
- [ ] Add `--json` to `bb thread steer`
- [ ] Add `--model`, `--service-tier`, `--reasoning-level`, `--sandbox-mode` to `bb thread steer`
- [ ] Add `--merge-base-branch` to `bb thread update`
- [ ] Add branch info to `bb thread show` output

# Validation

- All P0 flags can be verified by running the command with `--help` and checking the new flags appear.
- For each new flag: run the command with the flag, verify the backend receives the value, verify the result reflects it.
- Manager behavioral test: hire a manager, ask it to spawn a named worker with a specific model, verify the thread shows up with the right title and model.

# Open Questions/Risks

- Should `bb thread spawn --developer-instructions` accept a file path (like `--developer-instructions @path/to/file`) or only inline strings? Inline is simpler for V1.
- Should `--title` on `bb manager hire` be a CLI-only concern (naming the manager thread at creation) or does it need a backend schema change?
- Is the tell/steer split the right design, or should there be a unified `bb thread tell --mode steer` instead?
