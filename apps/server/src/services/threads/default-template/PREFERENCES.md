# User Preferences

This file is the manager's durable memory of how the user wants to be worked with. Edit it as you learn — keep it current.

## Identity

- Preferred name: _(not yet provided — ask when natural)_

## Workflow

- **Delegator workflow**: never do substantive work in the manager thread. Always spawn a child thread for coding, edits, investigations, or multi-step analysis.
- **Fresh main before every spawn**: before every `bb thread spawn`, ensure the local `main` is current with `origin/main` so workers start from the latest base.
  - Run first: `git -C <project-root> fetch origin main && git -C <project-root> pull --ff-only origin main` (works because `main` is typically the checked-out branch).
  - Pass `--base-branch main` to `bb thread spawn` so the worker's worktree branches off the just-pulled commit.
  - Skip this only if the user explicitly tells you the worker should branch off something else (e.g. chaining off another PR's branch).
- **Landing changes**: when a worker finishes work that should be applied to the codebase, ask the user once how they want it landed, then record the answer right here in this bullet under the chosen mode. Two common modes:
  - **Open PRs** — open them automatically and report the URL. Default to `gh pr create --draft`; switch to non-draft if the user prefers. Worker-thread completion notifications should trigger refreshing the open-PR view in `STATUS.html`.
  - **No PRs — local merge, push on request** — merge the worker's branch into the local checkout, but only push to `origin` when the user explicitly says so. Keep branches local; do not open any PR.
  - _Chosen mode:_ _(not yet decided — ask when natural)_

  Adjust `STATUS.html` to match the chosen mode (see next bullet).
- **STATUS.html mode**: if the user opens PRs, `STATUS.html` tracks open PRs in its primary section. If the user does NOT use PRs, replace the `Open PRs` section with two sections instead: **In progress** (branches actively being worked on by workers) and **Ready for review** (branches that are validated and waiting for the user's go-ahead to push or merge). Snippet patterns for both modes live in the HTML comment block at the bottom of `STATUS.html` — copy/paste as needed.
- **STATUS.html refresh**: keep `STATUS.html` (canonical) current — do not also keep a `STATUS.md`. Refresh:
  - periodically via a schedule in `ASYNC.md` (create one when scheduled refreshes are wanted; e.g. a `pr-refresh` schedule under PR mode).
  - after any state-affecting action (worker spawn, branch ready, PR opened, merge, close, push).
  - **after every child thread completion notification** (on any `[bb system] Thread complete/failed/interrupted`), even if the thread didn't obviously touch the tracked state — reconcile the relevant section.
- **STATUS.html styling**: run `bb guide styling` for the bb design tokens, fonts, and a starter `<style>` snippet so the iframe-rendered HTML matches the rest of the app.

## Open questions to resolve when natural

- Preferred name / how to address the user
- Worker defaults (provider / reasoning level / permission mode / preferred model) — ask the user when it comes up; do not assume a default.
- Anything else the user wants surfaced in `STATUS.html` (extra sections, custom info, integrations) — ask once when natural and update the template accordingly.
- Update verbosity preference (terse vs detailed)
- Any specific area of the codebase that's currently the focus
