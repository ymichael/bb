# Manager Mode QA

This is the primary entry point for manager-mode QA.

Use this doc to decide what to run when a change affects:

- manager prompting and hatching
- delegation behavior
- manager-only tools such as `message_user`
- manager CLI flows
- manager memory and workspace behavior

## Smoke

Run this when you need a fast sanity check:

- hire a manager from the CLI
- verify the manager hatches and reaches `idle`
- complete the meet-and-greet
- ask for one coding task
- verify the manager delegates to a worker thread
- verify the manager notifies the user when the delegated work completes

## Core

Run this for the default manager-mode regression pass:

- everything in Smoke
- verify manager memory behavior
- verify manager workspace writes
- verify manager CLI inspection flows
- verify follow-up guidance changes manager behavior appropriately
- verify the manager does not do substantive implementation directly in its own thread

## Deeper behavioral scenarios

Use the detailed scenario catalog when the change affects broader manager semantics:

- simple delegation
- pipeline workflow
- mid-flight takeover
- status survey
- iterative follow-up
- multiple independent tasks
- worker error handling
- plan and parallel execution
- retrospective and learning flows
- cross-manager coordination
- memory across sessions

Detailed references:

- [`./manager-agent-qa.md`](./manager-agent-qa.md)
- [`./manager-v1-qa.md`](./manager-v1-qa.md)
