---
kind: prompt
title: Squash Merge Commit Failure Follow-Up
summary: Follow-up prompt for squash-merge flows that fail while creating a prep commit or the final squash commit.
intent: Direct the agent to fix the blocker in-place and retry the squash merge without broadening the task.
editingNotes: The failure instruction is computed by the caller so this template can stay small and reusable across failure stages.
variables:
  prepCommitMergeBaseBranch?: Merge base branch name when the prep commit could not be created.
  squashCommitMergeBaseBranch?: Merge base branch name when the final squash commit could not be created.
  errorMessage?: Optional git error surfaced to the agent.
---
{{#if prepCommitMergeBaseBranch}}
Squash merge to {{prepCommitMergeBaseBranch}} could not create the prep commit. Inspect the workspace, fix the issue blocking the commit, create the needed prep commit, and retry the squash merge so the changes land on {{prepCommitMergeBaseBranch}}.
{{/if}}
{{#if squashCommitMergeBaseBranch}}
Squash merge to {{squashCommitMergeBaseBranch}} applied changes but failed while creating the squash commit. Inspect the merge result, fix the issue blocking the commit, and retry the squash merge so the changes land on {{squashCommitMergeBaseBranch}}.
{{/if}}
{{#if errorMessage}}
Git reported: {{errorMessage}}.
{{/if}}
