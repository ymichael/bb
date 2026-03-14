# Goal

Refine the manager-agent feature so the manager behaves like a credible long-running employee rather than a thin orchestration wrapper. The next phase should improve four things in parallel:

- the quality of the manager's hatching and relationship-building with the user
- the quality of the manager's delegation and CLI usage patterns
- the quality of manager memory, workspace use, and thread lifecycle decisions
- the quality of agent-to-agent coordination primitives and manager-specific UI polish

This plan is intended as a rebuild-quality artifact for the next round of work, not a status report on the current branch.

# Scope

In scope:

- Manager prompt and instruction redesign
- Better hatching / meet-and-greet behavior
- Manager playbook for using the `bb` CLI effectively
- Best-practice examples for delegation, waiting, follow-up, and archival
- Better guidance for manager memory and workspace organization
- Research on how `../swarm` handles manager memory/instructions
- A first-class agent-to-agent messaging primitive
- Audit of manager-relevant CLI happy paths and gaps
- Manager behavior for archiving stale managed threads
- Sidebar polish for collapsed managers and managed-thread status indicators
- A dedicated manager QA doc / refinement matrix in `qa/`

Out of scope:

- Reworking the entire manager feature data model
- Multiple peer managers as a shipped v1 requirement
- Replacing the `bb` CLI with a separate manager-specific control plane
- Rich autonomous planning/memory beyond manager-specific durable files
- Full productization of cross-project multi-manager collaboration

# Implementation Steps

1. Redesign the manager prompt around a stronger operating contract.

- Rewrite the manager instructions so they read like onboarding for a real employee, not just a terse agent role definition.
- Preserve the existing hard boundaries:
  - the manager is the only user-facing agent for managed work
  - user-facing output goes through `message_user`
  - internal orchestration messages are treated as internal context
- Add explicit sections for:
  - how to meet the user
  - how to learn what to call them
  - how to learn how they like to work
  - what kinds of tasks the manager is expected to help with
  - how Beanbag itself works as a system
  - when to delegate vs work directly
  - how to use durable memory and workspace files
- End the prompt with runtime-specific context, not scattered interpolations throughout the document.
- Inline the current `PREFERENCES.md` contents at the bottom of the prompt.
- If `PREFERENCES.md` does not exist, the runtime context should say exactly `(does not exist)`.
- Expand the runtime context so the manager knows what project it belongs to, not just where its workspace is.
- Include at least:
  - project name
  - project id
  - project root path
  - manager thread id
  - manager workspace path
- The manager should not have to rediscover its own project identity through CLI inspection for basic orientation.

2. Teach the manager the Beanbag mental model explicitly.

- Add a dedicated prompt section that explains the core Beanbag concepts the manager should understand even when it is not actively using them.
- This should include at least:
  - project
  - manager thread
  - standard thread
  - managed thread
  - `parentThreadId` as ownership/management
  - worktree vs local environment
  - taking over a thread
  - assigning a thread to the manager
  - promoting a workspace / primary checkout concepts when relevant
  - archiving a thread
- The goal is not to force the manager to use every feature all the time.
- The goal is to make sure the manager can interpret user requests correctly when users talk in Beanbag-native language.
- The Beanbag mental model should connect cleanly to runtime context so the manager understands which project and repo root it is managing.
- Include examples of user requests that rely on this model, such as:
  - "take over this thread"
  - "give this thread back to me"
  - "promote this workspace"
  - "archive that worker"
  - "use the manager on the other project to see how I like to work"
- The manager should understand these as product concepts, not just free-form English.

3. Make hatching feel like meeting a new employee.

- Strengthen the hatching section so the manager opens with a lightweight but credible meet-and-greet.
- The manager should:
  - introduce itself briefly
  - ask what the user prefers to be called
  - ask how the user likes to work with an assistant/manager
  - explain what kinds of things it can help with
  - ask a small number of high-value questions over one or more turns
- The conversation should feel natural and professional, not like a wizard or survey.
- The manager should only create `PREFERENCES.md` once it has durable information worth storing.
- The prompt should include examples of good hatching behavior and examples of overly rigid behavior to avoid.

4. Build a robust manager CLI playbook into the prompt.

- Add a dedicated section in the manager prompt that explains how to use the `bb` CLI effectively.
- Include concrete command examples and high-level walkthroughs, not just isolated command names.
- Cover common patterns such as:
  - spawning a thread for implementation
  - spawning a thread for research
  - checking thread status
  - viewing logs/output
  - sending a follow-up
  - assigning or unassigning a managed thread
  - talking to another manager
  - archiving or deleting a thread when appropriate
- Explain what to do after spawning a thread:
  - do not poll repeatedly
  - wait for completion or timeout signals
  - only follow up if requirements change or the worker asks a question
- The playbook should explain both command mechanics and behavioral expectations.

5. Add best-practice patterns directly to the prompt.

- Add short example patterns for the manager's most common workflows, such as:
  - "delegate coding task and wait"
  - "delegate research task and summarize result"
  - "handoff adopted thread and decide whether to inspect immediately"
  - "receive worker completion, review result, and update user"
  - "archive a temporary research thread after extracting the answer"
- Make it explicit that for most delegated work the manager should:
  - spawn the right thread
  - communicate clear expectations
  - avoid repeated polling
  - wait for the system to notify it when something changes
- Add anti-pattern guidance:
  - do not micromanage active workers
  - do not repeatedly ask for status with no new reason
  - do not leave obviously temporary threads lying around forever
- Add explicit handoff-language examples so the manager understands product concepts like:
  - "take over this thread"
  - "assign this thread to yourself"
  - "take this off my hands"
  - a pasted thread link
  - an `@`-mentioned thread reference
- The prompt should teach that these are ownership-transfer requests in the Beanbag model, not vague conversational suggestions.

6. Improve the manager's memory and workspace guidance.

- Research `../swarm` specifically for:
  - how manager memory is framed
  - what durable files or concepts are encouraged
  - how ongoing preferences and working norms are stored
- Use that research to refine the `bb` manager instructions for:
  - what belongs in `PREFERENCES.md`
  - what belongs in separate notes/reports/artifact files
  - what kinds of transient state should not be written as durable memory
- Add prompt guidance for maintaining a clean workspace:
  - durable preferences
  - reusable notes
  - short-lived task artifacts
  - when to update vs create a new file
- Make the manager's memory/storage behavior a first-class section of the prompt, not a brief afterthought.

7. Add first-class agent-to-agent communication.

- Introduce a dedicated inter-agent messaging tool rather than relying only on shelling out to the CLI.
- The new primitive should support:
  - manager -> agent messages
  - agent -> manager messages
  - eventually manager -> manager messages
- Keep the usage intentionally narrow:
  - for clarifications
  - for escalation
  - for handoffs
  - for cross-manager coordination
- It should remain rare compared with normal worker autonomy, but it should be a clear first-class primitive just like `message_user`.
- The prompt should explain when to use this tool instead of:
  - waiting for completion
  - using raw CLI inspection
  - sending unnecessary follow-ups

8. Audit the `bb` CLI from the manager's perspective.

- Make a list of all manager-motivated CLI jobs the system should support cleanly.
- Use hero use cases to drive this audit, including:
  - hire and talk to a manager
  - inspect manager state and logs
  - list managed threads
  - inspect statuses quickly
  - message a worker
  - talk to another project's manager
  - ask another manager for user working-style context
  - archive/delete stale threads
- From that list, identify where the current CLI is:
  - already good
  - technically possible but awkward
  - missing a command or flag entirely
- Design toward a CLI that feels intentionally manager-friendly rather than "possible if you know enough thread commands."
- Make sure the manager has a clean operational path from natural-language handoff intent to action:
  - inspect thread reference from link or mention
  - identify the target thread id
  - assign or unassign ownership appropriately

9. Add thread archival guidance to the prompt and workflow.

- Teach the manager to actively manage thread clutter.
- Add explicit guidance for when to keep a thread alive:
  - ongoing implementation not yet merged
  - active follow-up work expected
  - a reusable long-running workstream
- Add explicit guidance for when to archive:
  - one-off research threads with captured results
  - temporary execution threads with no remaining value
  - stale managed threads whose work is done and no longer needed
- Include examples so the manager learns the difference between:
  - "keep around because this branch/worktree matters"
  - "archive because the result has already been extracted"

10. Polish collapsed-manager sidebar behavior.

- When a manager is collapsed, still surface enough status to make the sidebar useful.
- Add collapsed-state cues such as:
  - a spinner on the manager row if any managed child is actively working
  - a count of managed child threads beside the manager name when collapsed
- Keep the UI minimal and readable; do not reintroduce heavy tree chrome.
- Preserve the current clarity improvements for managed child rows.

11. Create a dedicated manager refinement QA plan.

- Add a manager-focused QA document under `qa/daemon/` or another appropriate `qa/` path.
- Cover at least:
  - hatching quality
  - preference capture quality
  - manager workspace writing
  - `PREFERENCES.md` creation/update behavior
  - delegation patterns
  - non-polling behavior after delegation
  - inter-agent communication
  - thread archival decisions
  - collapsed sidebar status behavior
  - cross-project manager-to-manager coordination
- Include "hero scenario" scripts, not just raw endpoint checks.
- Include handoff-language scenarios such as:
  - "Can you take over this thread for me?" with a pasted thread URL
  - "Can you take over @thread:... for me?"
  - "I want this thread back" / "I'm taking this over"

# Validation

Validate this refinement phase at three levels.

1. Prompt and behavior QA

- Fresh manager hire:
  - verify the meet-and-greet feels natural and useful
  - verify the manager learns how to address the user
  - verify the manager learns how the user wants to collaborate
- Delegation behavior:
  - verify the manager uses the CLI or tools correctly
  - verify it does not poll workers repeatedly after delegation
  - verify it responds appropriately to completion/timeouts
- Beanbag mental-model behavior:
  - verify the manager correctly interprets requests about thread ownership
  - verify the manager understands workspace/worktree/primary-checkout language well enough to respond coherently
  - verify the manager can explain relevant system concepts back to the user when asked
  - verify the manager clearly knows which project and repo root it belongs to
- Memory behavior:
  - verify `PREFERENCES.md` is created only when it has useful durable information
  - verify workspace artifacts are named and updated sensibly
- Thread lifecycle behavior:
  - verify the manager archives obviously temporary threads
  - verify it keeps important threads alive when appropriate
- Handoff-language behavior:
  - verify the manager understands "take over" as a thread-ownership concept
  - verify pasted thread links and `@`-mentioned thread references both work as handoff cues
  - verify the manager does the correct ownership action rather than merely replying about it

2. CLI validation

- Exercise the manager-relevant CLI happy paths directly:
  - `bb manager hire`
  - `bb manager show`
  - `bb manager status`
  - `bb manager send`
  - `bb manager log`
  - `bb manager delete`
  - manager-oriented `bb thread ...` commands for spawn/list/status/log/tell/update/archive
- Validate at least one cross-project manager-to-manager scenario.

3. UI / product validation

- Verify collapsed managers show useful status without expanding.
- Verify managed-thread hierarchy remains legible.
- Verify thread counts and spinners behave correctly when child threads are active.
- Verify manager timelines, info panels, and workspace tabs still behave correctly after prompt/tooling changes.

# Open Questions/Risks

- How much of the manager CLI playbook should live in the main prompt versus separate reusable prompt fragments?
- Should inter-agent communication be one generic tool or distinct tools for worker-manager and manager-manager messaging?
- How much autonomy should the manager have for archival before users perceive it as losing useful work context?
- If the manager can ask another project's manager for working-style context, what guardrails should exist around cross-project memory sharing?
- Should manager-to-manager communication eventually support structured requests, or is plain message passing enough at first?
- How much `../swarm` memory/instruction structure should be copied directly versus adapted to `bb`'s simpler product model?
- Should pasted Beanbag thread URLs be converted into a structured reference before they reach the manager, or is prompt-level teaching enough for the first refinement pass?
