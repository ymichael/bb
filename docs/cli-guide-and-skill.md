# CLI, Guide, And Skill

Keep the discoverable surfaces in sync whenever you add or change a `bb` CLI command, flag, or a user-facing configuration knob (env var, `.bb/` workspace file, settings field):

- Update the in-CLI guide templates under `packages/templates/src/templates/bb-guide-*.md`, turbo regenerates `packages/templates/src/generated/templates.generated.ts` (not committed) before every build, typecheck, and test task.
- For core commands, update the bb-cli skill at `apps/server/src/services/skills/builtin-skills/bb-cli/SKILL.md` or its relevant reference. For plugin commands and settings, update the owning plugin's `skills/<name>/SKILL.md` or supporting reference, including built-in plugins. Keep plugin-specific behavior out of the core CLI skill. Configuration knobs also belong in `docs/configuration.md`.
- Match the existing chapter/section style; keep entries concise and accurate against the implementation.
