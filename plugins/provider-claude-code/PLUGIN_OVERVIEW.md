Start a thread, pick Claude Code, and let it work in your repository from bb. The plugin drives the Claude Code CLI on the host machine. It streams the agent's work into the bb timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus a plan action in the composer.
- Reasoning levels from Low to Max, plus Ultracode, which turns on multi-agent workflow orchestration.
- Checkpoint forks, manual compaction, and native questions from the agent.
- Claude Code skills and CLAUDE.md files from your home directory and project.
- Health, usage, and install status for Claude Code on each host, with an install or update action.

## Settings

- `Claude Code memory`: let Claude Code read and write its auto-memory.
- `Disable provider subagents`: hide the native Task tool so the agent delegates through bb.
- `Disable Workflow tool`: hide the native Workflow tool.
- `Release idle Claude processes`: close a quiet process after 30 seconds and resume it on the next turn.
- `Claude in Chrome`: start Claude Code with the browser tools.

## Requirements

- Install the Claude Code CLI (`claude`) on the host machine. The plugin can run the installer for you.
- Sign in with `claude` on that machine. bb reads the sign-in state to show account and plan.
- `Claude in Chrome` needs the Chrome extension and a claude.ai login on the host.
