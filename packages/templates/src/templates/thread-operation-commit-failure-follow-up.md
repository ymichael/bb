---
kind: prompt
title: Commit Failure Follow-Up
summary: Follow-up prompt for retrying a commit after git rejects the first attempt.
intent: Keep the retry focused on diagnosing the blocker, preserving any exact commit message requirement, and trying again.
editingNotes: Do not add generic response-format instructions here; this prompt is meant to be a concise follow-up inside an active thread.
variables:
  exactCommitMessage?: Optional exact commit message requirement.
  errorMessage?: Optional git error surfaced to the agent.
---
Commit in this thread workspace failed. Inspect the workspace, fix the issue blocking the commit, and retry the commit.
{{#if exactCommitMessage}}
Use this commit message exactly: "{{exactCommitMessage}}".
{{/if}}{{#if errorMessage}}
Git reported: {{errorMessage}}.
{{/if}}
