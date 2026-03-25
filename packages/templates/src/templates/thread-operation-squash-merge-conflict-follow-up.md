---
kind: prompt
title: Squash Merge Conflict Follow-Up
summary: Follow-up prompt for squash merges that stop on conflicts.
intent: Tell the agent to rebase onto the merge base, resolve the conflicts, and retry the squash merge.
editingNotes: Keep this concise and procedural. Conflict file details are optional context and should stay additive.
variables:
  mergeBaseBranch: Merge base branch name shown to the agent.
  conflictFiles?: Optional comma-separated file list.
---
Squash merge into {{mergeBaseBranch}} stopped on conflicts. Rebase this branch onto {{mergeBaseBranch}}, resolve the conflicts, and retry the squash merge so the changes land on {{mergeBaseBranch}}.
{{#if conflictFiles}}
Conflicted files: {{conflictFiles}}.
{{/if}}
