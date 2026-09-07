Start a thread, pick Pi, and let the Pi coding agent work in your repository from bb. The plugin drives the Pi CLI on the host machine. It streams the agent's work into the bb timeline.

## What you get

- Reasoning levels from None to Max.
- Checkpoint forks and manual compaction.
- Pi skills from your home directory and project, listed next to bb skills.
- Health and install status on each host, with an install or update action.

## How it works

The plugin starts `pi` in RPC mode on the host and loads a small bb extension into it. Pi runs with full permissions in bb threads. bb checks the installed version before each session and shows an update action when it is too old.

## Requirements

- Install the Pi coding agent on the host machine: `npm install -g @earendil-works/pi-coding-agent`. Version 0.84.0 or newer is required.
- Sign in with `pi` on that machine.
- Optional: set `BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` on the host to use a Pi executable that is not on `PATH`.
