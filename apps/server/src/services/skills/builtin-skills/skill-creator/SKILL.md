---
name: skill-creator
description: "Create or improve BB skills, including their triggers, instructions, and supporting resources."
---

# Skill creator

Create skills that add useful domain knowledge and trigger only for relevant tasks.
User skills live at `~/.bb/skills/<name>/SKILL.md`. Edit built-in and plugin
skills at their source, not in generated runtime copies.

## Contract

Start `SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-name
description: Briefly state the capability and when it applies.
---
```

The directory and name must match. Names use lowercase letters, numbers, and
single hyphens, with at most 64 characters. Descriptions have a 1024-character
limit; use a short, discriminating sentence rather than filling that limit.
Preserve supported metadata and invocation settings when editing.

BB loads names and descriptions for discovery, the body when a skill is used,
and supporting files when needed. New threads discover revisions; existing
threads may retain the version they started with.

## Write for the task

- Keep the purpose, essential constraints, completion criteria, and reference
  routing in the entrypoint. A short skill needs no extra files.
- Move substantial mode-specific procedures and examples into `references/`.
  State when to read each file; do not require loading every reference.
- Use `scripts/` for repeated deterministic work and `assets/` for output
  templates or resources. Reuse existing resources before adding new ones.
- Describe outcomes and decision boundaries. Reserve rigid steps for fragile
  operations where order matters; avoid generic advice, repeated repository
  rules, keyword catchalls, and model-specific scaffolding.
- Preserve the user's scope and existing authorization. Continue through
  authorized implementation and verification; ask only for missing decisions.
  A skill being loaded does not itself authorize external writes or new work.
- Keep real safety and product constraints explicit. Explain a constraint when
  its reason helps the agent apply it correctly.

## Verify and finish

Check frontmatter, resource paths, scripts affected by the edit, and whether
realistic requests select the right skill. Include near misses when changing
triggers. Preserve working behavior rather than optimizing word count alone.

For substantial workflow or boundary changes, use
[references/evaluation.md](references/evaluation.md) for fresh-thread tests
against the previous skill or no-skill baseline. A wording edit does not require
full workflow execution. Keep evaluations isolated from live external actions.

Finish after relevant checks pass and demonstrated failures are corrected.
Report the changes and any limits of the validation; do not keep testing without
new evidence that another run would help.
