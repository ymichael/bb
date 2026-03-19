# QA Pass Levels

Use these names consistently across QA surfaces.

## Smoke

Use when you need the fastest signal that a surface is alive and the highest-value happy paths still work.

## Core

Use as the default pass for a surface. This should cover the main contract and the most important edge cases for that subsystem.

## Recovery

Use for restart, reconnection, worker-loss, concurrency, or other failure-path behavior. Only add this level for surfaces that really need it.

## Writing Guidance

- Prefer small named passes over giant umbrella checklists.
- Prefer invariant-oriented scenarios over bug-story-only scenarios.
- If a pass grows too broad, split it deliberately by ownership instead of adding another unrelated checklist section.
