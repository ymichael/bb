# Add a local project

Status: **2026-09-05: 1 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## User goal and source

Select a folder on a connected machine and use it as a project.

- `apps/app/src/views/RootComposeEmptyWelcome.tsx`: initial New project entry.
- `apps/app/src/hooks/useQuickCreateProject.tsx`: name derived from the path,
  local source creation, and selecting the project in root compose.
- `apps/app/src/components/dialogs/ProjectPathDialog.tsx`: folder navigation
  and direct path input.
- `apps/app/src/components/dialogs/RemotePathBrowser.tsx`: Edit path,
  Project path, and Go to path controls.
- `apps/cli/src/commands/project.ts`: agent-facing project inspection.

## Prerequisites

Run the main skill's doctor. Create a synthetic Git folder:

```bash
mkdir "$BB_VERIFY_RUN/fixture"
git -C "$BB_VERIFY_RUN/fixture" init -b main
```

An empty repository is enough for the local-mode journey. No commits, remote,
or worktree creation are required. Use a fresh folder for each repeated pass.

## Reach and drive

1. On a fresh app home, click **New project — Create one from a local folder**.
   Once projects exist, use the compose Project picker and its **New project**
   option. Snapshot first to locate that entry in the current layout.
2. In **Add project**, click **Edit path**. Fill `[aria-label="Project path"]`
   with the resolved fixture path; click **Go to path**.
3. Wait for the breadcrumbs and **Project name: fixture** to reflect the
   target. The folder listing updates asynchronously. Capture this state.
4. Click **Add project** inside that dialog. Wait for it to close and for
   the prompt textbox and **Project: fixture** button to appear.
5. Read `node apps/cli/dist/index.js project list --json`. Match the source path
   exactly; record its returned project ID. Reload the page and check the
   project remains available in the picker.

## Observable success

The UI selects the new project. `GET /api/v1/projects` returns one matching
project with a `local_path` source, the selected host ID, the exact fixture
path, and a default source. Persist the selected fields with screenshots of
the action and outcome. Repeated runs must not accidentally inspect an older
same-named project; identify it by source path and returned ID.

## Gotchas

Do not use **Automatically import my projects**: it reads real recent repos.
The folder picker can initially display the host's home directory; do not
commit a screenshot of unrelated folders. Do not press Add while it still
shows the previous path. An empty folder listing is valid for this fixture.
