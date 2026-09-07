---
name: create-verification-skill
description: Create a repo-local verification skill and exhaustive feature map for driving a real app through its UI, CLI, or API. Use for "create a verification skill", "make a verify skill for this repo", or "document how agents can verify this app".
---

# Create a verification skill

Generate `.bb/skills/verify-<app>/SKILL.md` for an agent arriving cold in the
repository. Adapt the recipe to the actual app and prove it by running it.

## Discover

Read repository instructions, startup scripts, routes, existing tests, and QA
docs. Establish the user surfaces, launch command, readiness signal, required
runtime, authentication, fixtures, automation harness, and observable side
effects. Prefer the repository's harness. For browser interaction without an
existing project harness, use `dev-browser@next`. Install it with
`npm install -g dev-browser@next`, then read `dev-browser --help`. It provides
Puppeteer scripts, named pages, `page.snapshot()`, and snapshot-ref selectors.
If it reports missing Chrome, run `dev-browser install`. Record the installed
version with the evidence; the `next` tag can change.

Inspect an existing verification skill before creating another. Extend it when
it already owns the same app. Ask only for decisions the repository cannot
answer. Do not execute this workflow for a request that only asks what a skill
does or asks to verify one existing feature.

Establish isolation before launch: ports, database, host connections, browser
profile, and process ownership. Use synthetic data. Do not copy a live store or
reuse the user's logged-in app. Respect project rules for imported data and
network-facing plugins. A new data-directory name alone does not prove that a
launcher will not import existing data.

Check the real startup path. Resolve routine local setup failures within the
task's scope. Report product defects and unavailable prerequisites precisely;
do not change product behavior merely to make verification pass.

## Generate

Write the skill with valid BB frontmatter and these sections:

- **Launch:** exact commands, runtime, readiness check, target discovery, and
  isolation. Derive ports and IDs from real output instead of guessed values.
- **Doctor:** a read-only check of instance identity, process ownership,
  build/source revision, API health, and any feature-specific prerequisite.
- **Drive:** documented harness commands and stable selectors from the real
  app. Include how CLI/API calls target the same instance as the browser.
- **Evidence:** capture the starting state, user action, resulting state, and
  relevant persisted side effect. Record the source commit, environment,
  command, and result. Keep evidence outside disposable runtime state.
- **Cleanup:** stop only processes and browser sessions this run owns. Verify
  they stopped and evidence survives. Handle failed attempts too.

Create an exhaustive feature inventory by default. Reconcile UI routes,
navigation and action menus, CLI commands, settings, installed or bundled
plugins, platform clients, and public agent interfaces. Group related features
into files, but give each distinct capability its own driving recipe and
observable success condition. Do not use a fixed feature count or treat the
easiest working paths as the product's boundary. A starter subset is appropriate
only when the user explicitly requests one.

Write `features/README.md` as the index. Each feature file includes the user
goal, source entry points, prerequisites, how to reach it, driving recipes,
observable success, and gotchas. Include unavailable and platform-specific
features with their prerequisites; inability to run them does not justify
omitting their documentation. Explicitly classify compatibility aliases,
developer-only surfaces, and out-of-repository extensions.

Cross-check the map against a reproducible source inventory. Track newly added
routes, commands, settings, and plugins so later audits expose missing coverage.
Source coverage is not proof of behavior; keep inventory completeness separate
from live verification status.

Any helper must be executable, documented, and tested. Avoid adding a wrapper
when an existing command already does the job. Never commit credentials,
personal data, machine-specific runtime state, or raw unreviewed transcripts.

## Prove

Read and follow the generated instructions: launch, doctor, drive at least one
mapped feature through its real entry point, capture evidence, and clean up.
Use UI input for UI claims; API setup or database inspection can supplement it,
but internal setters and mocked routes cannot prove the user journey.

Record each feature as live-verified, source-only, or blocked, with the reason
and evidence. A browser check in Chromium does not verify Safari or a native
app. Fix recipe errors and retry within a bounded scope. Confirm evidence
still exists after cleanup. An unexecuted skill is a draft.

## Finish

Report the generated skill, live coverage, limitations, and evidence location.
Point to `maintain-verification-skill` for upkeep; do not schedule it implicitly.
Commit the generated files when requested. Push, publish, or open a PR only
when the user's request authorizes that action.

Adapted from [pstack](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md).
The upstream MIT license is included in `LICENSE`.
