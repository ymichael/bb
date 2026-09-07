See the open issues and pull requests of your repositories inside bb. Hand one to an agent with one click.

## What you get

- A GitHub panel with Issues and Pull requests tabs across every tracked repository. It has a repository filter and a New issue form.
- Issue details: body, comments, a comment box, and editing of status, assignee, and labels.
- Send agent on an issue, or Review with agent on a pull request. bb starts a thread in the repository's project and links it from the item.
- Mentions. Type `@` or `#` in any composer to attach an issue or pull request. Its title, body, and state go to the agent at send time.

## How it works

The plugin tracks every bb project whose checkout has a GitHub `origin` remote. Add more repositories in the Extra repositories setting as a comma-separated `owner/repo` list. Choose a Default project for repositories that are not attached to a project. A background service refreshes the cache every 5 minutes. Press Refresh in the panel to update now.

## For agents

The `bb github` command lists cached data. Use `bb github repos`, `bb github issues [owner/repo]`, `bb github prs [owner/repo]`, or `bb github sync`.

## Requirements

The GitHub CLI must be installed and signed in with `gh auth login`. See https://cli.github.com for installation. The plugin uses your `gh` session and stores no tokens. Until `gh auth status` passes, the plugin reports that it needs configuration.
