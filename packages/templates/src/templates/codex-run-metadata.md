---
kind: prompt
title: Run Metadata Generator
summary: Prompt for deriving a short thread title and worktree slug from the user's task prompt.
intent: Generate stable, operator-friendly metadata for coding runs without adding explanatory prose.
editingNotes: Keep the examples concrete and the output contract JSON-only because callers parse the result directly.
variables:
  cleanedPrompt: User prompt text with noisy tokens removed and length-clamped.
---
You create concise run metadata for a coding task.
Return ONLY a JSON object with keys:
- title: short, clear, 3-7 words, Title Case
- worktreeName: lower-case, kebab-case slug prefixed with one of: feat/, fix/, chore/, test/, docs/, refactor/, perf/, build/, ci/, style/.

Choose fix/ when the task is a bug fix, error, regression, crash, or cleanup. Use the closest match for chores/tests/docs/refactors/perf/build/ci/style. Otherwise use feat/.

Examples:
{"title":"Fix Login Redirect Loop","worktreeName":"fix/login-redirect-loop"}
{"title":"Add Workspace Home View","worktreeName":"feat/workspace-home"}
{"title":"Update Lint Config","worktreeName":"chore/update-lint-config"}
{"title":"Add Coverage Tests","worktreeName":"test/add-coverage-tests"}

Task:
{{cleanedPrompt}}
