# Pi Provider Overlay

Use this overlay after the shared provider pass when the change is Pi-specific.

Provider notes:

- requires `pi` in `PATH`
- auth is typically configured via `~/.pi/agent/auth.json`
- current smoke automation entrypoint: `pnpm qa:providers:smoke:pi`
- Pi does not support rename-oriented checks from the old standalone matrix

Keep shared scenarios in `../core.md`; use this file only for Pi-specific setup, exclusions, or regressions.
