---
kind: instruction
title: bb Guide - Manager Templates
summary: Manager storage template reference.
intent: Explain how manager-templates seed new manager thread storage.
editingNotes: Keep this factual against manager-storage-templates.ts and the manager hire API/CLI.
---
Manager templates

Manager templates are named bundles of starter files for manager thread
storage. When bb starts a new manager thread, the server resolves a template
and copies that template's top-level regular files into the new manager's
thread storage before the host daemon receives the initial `thread.start`
command. This is how a fresh manager can boot with starter `PREFERENCES.md`,
`STATUS.html`, `ASYNC.md`, or other storage files.

Directory layout:

```text
~/.bb/manager-templates/
  active
  default/
    STATUS.html
  sawyer-next/
    PREFERENCES.md
    STATUS.html
```

In production, the default root is `~/.bb/manager-templates/`. In source
development, the default root is `~/.bb-dev/manager-templates/`. If
`BB_DATA_DIR` is set, use `$BB_DATA_DIR/manager-templates/`.

`active` is a plain text file. bb reads the first line, trims it, and uses it
as the template name. Missing or empty `active` means `default`. An invalid
name logs a warning and falls back to `default`. Template names must be one
directory name: 1-128 characters, no `/` or `\`, and not `.` or `..`.

Each subdirectory is a template set. The directory name is the template name.

What gets seeded:

bb copies every top-level regular file from the selected template directory
into `<dataDir>/thread-storage/<manager-thread-id>/`. There is no filename
allowlist: `PREFERENCES.md`, `STATUS.html`, `STATUS.md`, and `ASYNC.md` are
conventions, not the only files allowed. Subdirectories and symlinks are
ignored. Dotfiles are copied if they are regular files. Existing destination
files are left as-is; seeding does not overwrite, delete, or refresh files.

If `default/` is missing, bb uses a bundled fallback template containing only
`STATUS.html`. If `default/` exists but is empty, no bundled files are mixed
in. If a selected non-default template is missing, bb logs a warning and skips
storage seeding.

When it runs:

Seeding happens while building the manager `thread.start` command, normally
after `POST /api/v1/projects/:id/managers` or `bb manager hire` creates the
manager and the environment is ready. It happens before the host daemon starts
the provider thread. The copy operation is safe to run more than once because
existing files are skipped; it is not a refresh mechanism for managers that
already have storage.

Selecting a template:

For one manager, pass a template name at hire time:

```bash
bb manager hire --template sawyer-next
```

`--template` overrides the `active` pointer for that manager creation only.

For future managers by default, edit the active pointer:

```bash
mkdir -p ~/.bb/manager-templates
printf 'sawyer-next\n' > ~/.bb/manager-templates/active
```

Use `~/.bb-dev/manager-templates` in source development, or
`$BB_DATA_DIR/manager-templates` when `BB_DATA_DIR` is set. There is no
dedicated CLI command today for changing the global active template.

Creating a template:

```bash
DATA_DIR="${BB_DATA_DIR:-$HOME/.bb-dev}"
mkdir -p "$DATA_DIR/manager-templates/sawyer-next"
cp "$DATA_DIR/manager-templates/default/STATUS.html" \
  "$DATA_DIR/manager-templates/sawyer-next/STATUS.html"
$EDITOR "$DATA_DIR/manager-templates/sawyer-next/PREFERENCES.md"
printf 'sawyer-next\n' > "$DATA_DIR/manager-templates/active"
```

For packaged production bb, use `DATA_DIR="${BB_DATA_DIR:-$HOME/.bb}"`.

Promoting current preferences:

Managers see their storage path in runtime context. To save the current
manager's `PREFERENCES.md` to the default template:

```bash
DATA_DIR="${BB_DATA_DIR:-$HOME/.bb-dev}"
THREAD_STORAGE="/absolute/path/from-manager-runtime-context"
mkdir -p "$DATA_DIR/manager-templates/default"
cp "$THREAD_STORAGE/PREFERENCES.md" \
  "$DATA_DIR/manager-templates/default/PREFERENCES.md"
printf 'default\n' > "$DATA_DIR/manager-templates/active"
```

For packaged production bb, use `DATA_DIR="${BB_DATA_DIR:-$HOME/.bb}"`.
Copy `STATUS.html`, `STATUS.md`, or `ASYNC.md` into the same template
directory when those starter files should be shared too.

Limitations and gotchas:

- There is no dedicated CLI or UI for changing `active`.
- Template file contents are not schema-validated before copying.
- Only top-level regular files are copied; template subdirectories are ignored.
- Existing thread storage files are never overwritten by seeding.
- A user-authored `default/` directory fully replaces the bundled fallback,
  even if it is empty.
- Missing selected non-default templates skip seeding instead of falling back
  to `default`.

Related guides:

  bb guide overview
  bb guide managers
  bb guide styling
  bb guide async
