# Claude Code Provider Overlay

Use this overlay after the shared provider pass when the change is Claude Code-specific.

Provider notes:

- requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- current smoke automation entrypoint: `pnpm qa:providers:smoke:claude-code`
- Claude Code does not support rename-oriented checks from the old standalone matrix

Keep shared scenarios in `../core.md`; use this file only for Claude Code-specific setup, exclusions, or regressions.
