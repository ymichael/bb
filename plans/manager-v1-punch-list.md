# Goal

Ship a credible V1 for the manager mode in bb.

# Completed

| # | Item | What shipped |
|---|------|-------------|
| 1 | Multi-manager support | Dropped `primaryManagerThreadId`, hire always creates, multi-manager UI selector, DB migration |
| 2 | Inter-agent messaging | Deferred — CLI (`bb thread tell` / `bb manager send`) covers inter-agent communication for V1 |
| 3 | Manager default provider/model | Defaults to `claude-code` + `claude-opus-4-6` with fallback |
| 4 | Hire manager modal | Name input, provider/model picker with defaults, improved layout |
| 5 | Manager @-mention support | Thread suggestion modes (managers/all), type-aware rendering in mention menu |
| 6 | Prompt quality pass | Hero workflows W1–W10, runtime context (project name/id/root, thread id), sub-templates |
| 7 | Environment reuse | Resolved upstream — `bb thread spawn --environment <env-id>` |
| 8 | Thread lifecycle guidance | Archival guidance in prompt and workflows sub-template |
| 9 | Workflows sub-template | Extracted to `bb-manager-workflows.md` with empty-string guard |
| 10 | CLI command dedup | Documented canonical `bb thread` commands vs `bb manager` shorthands in CLI guide |
| 11 | Heading consistency | Normalized to bare text headings throughout manager instructions |
| 12 | Surface language audit | Type-aware copy in delete/rename/archive modals, toasts, action menus |
| 14 | UI handoff actions | Already implemented — manager selector dropdown + unassign button in info tab |
| 15 | @-mention interaction polish | File suggestion dedup, thread type pills, icon removal |
| — | CLI audit P0s | `--title`, `--model`, `--json` on list, `bb provider` commands |
| — | CLI P1 flags | `--include-archived` on list, `--reasoning-level` on spawn, `--json`/`--model`/`--reasoning-level` on tell/steer |
| — | DB migration | `0004_drop_primary_manager_thread_id.sql` |

# In Progress

| # | Item | Status |
|---|------|--------|
| 13 | Sidebar collapsed-manager cues | Agent working — child count + activity spinner when collapsed |

# Remaining

| # | Item | Notes |
|---|------|-------|
| 16 | Dedicated manager routes eval | Decision item: should manager-specific endpoints move from `/threads/:id/manager-workspace/*` to `/managers/*`? Defer until the current approach proves awkward. |
| 17 | Manager QA scenarios | Write QA doc covering hero workflows W1–W11. Run scenarios against current implementation. Do this last. |

# Related Plans

- `plans/cli-audit.md` — comprehensive CLI command table, design issues, `--json` enforcement proposal, redundancy analysis, and prioritized task list
- `plans/manager-hero-workflows.md` — definitive workflow definitions (W1–W11) driving prompt and CLI work

# Open Questions

- **Notification → turn trigger:** When a managed thread completes, does the system message actually start a new manager turn? If not, W7 (error handling) is reactive only. Needs verification.
- **Workflow preferences:** Should pipeline workflows be stored as structured config or natural language in `PREFERENCES.md`?
- **Route separation:** Defer until the current thread-route approach proves awkward for manager-specific endpoints.
