---
kind: prompt
title: Squash Merge Commit Failure Follow-Up
summary: Follow-up prompt for squash-merge flows that fail while creating a prep commit or the final squash commit.
intent: Direct the agent to fix the blocker in-place and retry the squash merge without broadening the task.
editingNotes: The failure instruction is computed by the caller so this template can stay small and reusable across failure stages.
variables:
  failureInstruction: Stage-specific retry instruction.
  errorMessage: Optional git error surfaced to the agent.
---
{{failureInstruction}}
{{#if errorMessage}}
Git reported: {{errorMessage}}.
{{/if}}
