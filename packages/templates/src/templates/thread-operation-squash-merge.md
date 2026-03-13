---
kind: prompt
title: Thread Operation Squash Merge
summary: Instruction prompt for deterministic squash-merge operations from a thread or primary checkout.
intent: Tell the agent how to choose the merge base, whether to create prep commits, how to message the merge, and how to report completion.
editingNotes: Keep the prep-commit and conflict-handling branches explicit. Recovery prompts depend on this operation being narrowly scoped.
variables:
  targetDescription: Human-readable description of the workspace target.
  mergeBaseInstruction: Instruction covering the merge base branch.
  prepCommitInstruction: Instruction covering whether a prep commit may or must be created.
  commitMessageInstruction: Instruction covering the prep commit message when needed.
  squashMessageInstruction: Instruction covering the squash merge message.
  conflictInstruction: Instruction covering conflict handling and reporting.
---
Please squash-merge the changes in {{targetDescription}}.
{{mergeBaseInstruction}}
{{prepCommitInstruction}}
{{commitMessageInstruction}}
{{squashMessageInstruction}}
{{conflictInstruction}}
Please reply with whether the squash merge completed and list any blockers.
