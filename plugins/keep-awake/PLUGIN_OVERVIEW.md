Stop your Mac from going to idle sleep while bb runs long agent work. Enable the plugin once, and bb keeps the selected machines awake for as long as the app is running.

## What you get

- One switch in the plugin settings that turns idle-sleep prevention on or off.
- A choice between all hosts and a list of specific hosts.
- Automatic reconnection. When a host connects again, bb applies the setting again.

## How it works

The plugin runs on each selected host and holds an idle-sleep assertion while bb is running. When bb stops, the assertion stops with it. The display can still turn off. Closing the lid or choosing Sleep still puts the Mac to sleep.

Use the settings page or the CLI to manage the plugin:

- `bb keep-awake status` shows the current state and the host selection.
- `bb keep-awake enable` and `bb keep-awake disable` change the switch.
- `bb keep-awake hosts all` selects every host. `bb keep-awake hosts` followed by one or more host ids selects specific hosts.

Add `--json` to any command for machine-readable output.

## Requirements

Only macOS hosts are supported. On a Linux or Windows host, the plugin does nothing and writes a warning to the log.
