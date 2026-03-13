---
kind: prompt
title: Commit Message Generator
summary: Prompt for generating one conventional commit line from a git diff snapshot.
intent: Produce a single concise conventional commit subject and nothing else.
editingNotes: The JSON-only return contract is consumed programmatically. Keep the output format strict.
variables:
  diffDescription: Human-readable description of the diff snapshot being summarized.
  shortstat: Git shortstat summary for the diff.
  files: Git name-status output for changed files.
  patch: Trimmed patch excerpt for extra context.
---
Write a concise git commit message for {{diffDescription}}.
Rules:
- Return ONLY JSON: {"message":"..."}
- Use conventional commit style (feat|fix|refactor|test|docs|chore|perf|build|ci|style).
- Prefer specific types like feat/fix/refactor/test/docs/perf over chore.
- Use chore only for housekeeping (deps, tooling, CI, formatting, repo maintenance).
- Use imperative mood, max 72 characters.
- Single line only, no body.

Shortstat:
{{shortstat}}

Files (name-status):
{{files}}

Patch excerpt:
{{patch}}
