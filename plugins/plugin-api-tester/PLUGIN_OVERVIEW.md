A workbench for people who build bb plugins. Enable it when you want a placeholder page in the sidebar that confirms plugin loading works in your build.

## What you get

- A Plugin API Tester page in the sidebar with its own URL.
- A short status card that confirms the plugin is active.

## How it works

The plugin registers one full-page panel and nothing else. It adds no agent tools, no CLI commands, and no settings. It is enabled by default in a development build and disabled by default in a release build.

Use it as a smoke test when you change how bb loads bundled plugins. Use the Plugin Guide plugin to browse the full plugin API.

## Requirements

None. The plugin does not contact an external service and does not need an account. Most users can leave it disabled.
