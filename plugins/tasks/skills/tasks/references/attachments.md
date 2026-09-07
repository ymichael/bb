# Task attachments

Read this file when a task needs files or image references.

## Choose the owner

A task key adds a file to the task. A comment ID adds a file to that comment.

For a comment attachment, create the comment as JSON and use its ID:

```sh
comment_id=$(
  bb tasks comment ABC-12 \
    --body "Screenshot of the failing step." \
    --json | jq -r '.comment.id'
)
bb tasks attachment add "$comment_id" --file ./screenshot.png
bb tasks attachment add "$comment_id" --file ./trace.log
```

Use JSON output when another command needs returned attachment data.

## Add and remove files

Use repeatable `--attach <path>` with `bb tasks create` for initial files.

List IDs with `bb tasks attachment list <key>`. Remove a file with
`bb tasks attachment remove <attachment-id>`.

The remove command deletes the row and the stored file. It rejects a referenced
file unless `--remove-references` confirms description cleanup.

## Select a machine

The invoking machine owns `--file`, `--attach`, `--out`, `--description-file`,
and `--body-file` paths. In a thread, this is the thread machine.

Outside a thread, these paths use the server machine. Use
`--machine <id-or-name>` for another enrolled machine.
