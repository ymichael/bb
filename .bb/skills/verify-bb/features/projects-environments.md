# Projects, sources, environments, and Git

Status: **2026-09-05: 4 passed, 1 failed, 10 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

A synthetic Git repo with a committed main branch, a feature branch, an untracked file, and a modified tracked file. Use project actions/settings and the composer Environment picker.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/app/src/views/ProjectSettingsView.tsx`
- `apps/app/src/components/project/ProjectActionsMenu.tsx`
- `apps/cli/src/commands/project.ts`
- `apps/cli/src/commands/environment.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Create and rename projects | Run the local-project recipe, then rename through the project actions menu and reload; compare project show/update. | Project identity remains stable while its name changes. |
| Multiple sources and default source | Add a synthetic source on a second disposable host, change its path/default flag, then remove it with project source operations. Each host permits one source and the source host is immutable. | Sources persist, the intended default is selected, and the remaining source is still usable. |
| Git remote projects | Create a local-path project, then clone a disposable remote onto a second host using project source add --clone and the UI source controls. | Clone/provisioning uses the requested remote and branch; invalid remote errors do not create a usable fake checkout. |
| Recent repository import | On a disposable host home with synthetic recent repos, run the offered import action and inspect project list. | Only discovered candidates are imported; duplicates and missing paths are handled. Do not use real recent repos as fixtures. |
| Local versus managed worktree | Create one thread with Work locally and one with a new worktree and selected base branch. | Environment path, branch, and lifecycle match the selection; edits in the managed worktree do not affect the original checkout. |
| Reuse and switch environments | Select an existing environment for another thread; use environment update for display name/merge-base changes; test path switching separately through the thread environment-directory action after reading help. | Both thread details identify the intended environment; invalid paths fail without silently changing scope. |
| Environment status and branch discovery | Compare Info panel with environment show/status/branches and project branches for the same source. | Branch, dirty state, host, and path agree; disconnected or missing workspaces show an actionable error. |
| Diff views and selected patches | Open Diff with tracked edits, additions, renames, and deletions; use environment diff/diff-files/diff-file/diff-patch. | File lists, old/new contents, line numbers, and selected patches match git diff including untracked changes as supported. |
| Commit | Prepare a fixture containing only changes intended for a commit; invoke the UI/CLI Commit action and inspect git show and the clean diff. | The action stages all workspace changes with git add -A; the resulting commit contains the fixture changes. |
| Pull requests | With a disposable authenticated remote PR, inspect environment pull-request show; exercise ready, draft, and merge only in that test repo. | Forge state agrees with UI/CLI; missing auth/checks/conflicts produce explicit failures. Never run this on a user PR for documentation. |
| Archive environment threads | Create threads in two managed worktree environments and invoke environment archive-threads for one; try a local environment separately. | Only the selected managed environment’s active threads are archived; local environments are rejected with HTTP409. |
| Project attachments and history | Upload/download a synthetic file with project attachment; compare bytes; inspect project history and workspace file/path/content commands. | Returned content and history belong to the chosen project/host; missing files report failure. |
| Execution defaults | Set project defaults for environment/provider/model/permissions, open a new root draft and override one choice before sending. | Resolved defaults populate once, explicit draft choices win, and thread details reflect the actual execution options. |
| Clone destination and folder discovery | Browse an empty test host directory and inspect suggested clone path, path existence and invalid destination feedback. | Folder and clone suggestions target the chosen host; existing paths are not overwritten by a failed clone. |
| Delete project | Delete a disposable project through its confirmation flow, then inspect projects and its threads. | Deletion scope matches the confirmation; cancel leaves all state intact. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- Create a local project, then use its project actions menu → Rename and reload; compare source project show/update. Project settings contains source controls, not Rename. Source: `apps/app/src/components/project/ProjectActionsMenu.tsx:87; apps/cli/src/commands/project.ts:530`.
- Use two disposable hosts: each project permits one source per host. Select host when adding; update path/default with source operations. Move between hosts by adding/removing sources, not by changing a source host. Source: `apps/cli/src/commands/project.ts:574; apps/app/src/views/ProjectSettingsView.tsx:173`.
- Create a project from a local path, then use project source add --clone --remote-url <disposable-remote> --target-path <fresh-path> on a second host. project create does not accept a remote URL. Source: `apps/cli/src/commands/project.ts:487; apps/cli/src/commands/project.ts:574`.
- Await provisioning with thread show; its JSON wraps thread and environment. Initial spawn may have environmentId null. Source: `apps/cli/src/commands/thread/spawn.ts; apps/cli/src/commands/environment.ts:301`.
- Reuse an environment with thread spawn --environment. environment update supports display name and merge-base override only. Test path switching with the supported thread environment-directory action separately. Source: `apps/cli/src/commands/environment.ts:579; apps/cli/src/commands/thread/spawn.ts`.
- Commit all current workspace changes through UI/CLI, inspect git show and clean diff. This action stages git add -A; use a fixture containing only changes intended for this commit. Source: `packages/host-workspace/src/workspace.ts:985; apps/server/src/routes/environments.ts:575; apps/cli/src/commands/environment.ts:641`.
- Create threads in two managed worktree environments; archive one with environment archive-threads. Local environments are rejected with HTTP409. Source: `apps/cli/src/commands/environment.ts:662; apps/server/src/routes/environments.ts`.
