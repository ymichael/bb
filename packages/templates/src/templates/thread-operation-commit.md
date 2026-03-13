---
kind: prompt
title: Thread Operation Commit
summary: Instruction prompt for a deterministic commit operation within a thread or primary checkout.
intent: Tell the agent exactly how to prepare and create at most one commit, then report the result.
editingNotes: Preserve the explicit staging and reply requirements; downstream UI and recovery flows assume this shape.
variables:
  targetDescription: Human-readable description of the workspace target.
  stageInstruction: Instruction covering whether unstaged changes may be included.
  commitMessageInstruction: Instruction covering exact or generated commit message behavior.
---
Please commit the changes in {{targetDescription}}.
Please review git status and the diff before committing.
{{stageInstruction}}
{{commitMessageInstruction}}
Please create at most one commit.
Please reply with whether a commit was created, the commit SHA if present, and any blockers.
