---
name: maintain-verification-skill
description: Audit an existing verification skill and feature map against source and the running app, then repair proven documentation or harness drift. Use for "maintain the verification skill", "audit the verify skill", or "refresh the verification feature map".
---

# Maintain a verification skill

Keep a repository's `.bb/skills/verify-<app>/` usable by the next agent.

## Locate and scope

Read repository instructions and the target verification skill. If several
apps are plausible and the request does not identify one, ask which. If none
exists, report that and point to `create-verification-skill`; do not invent an
audit target. A request to explain maintenance does not authorize running it.

Edit only the verification skill directory, its feature map, and its owned
helpers. Report product regressions separately. Do not rewrite the expected
behavior to match a broken app. Preserve only explicitly requested feature subsets and real product boundaries.

## Read source

Check the index against its feature files. Read each feature's source entry
points and compare its recipe with current routes, labels, CLI flags, defaults,
and persistence behavior. Record a concrete source citation for each suspected
drift and one concise live recipe per feature. Reconcile the feature inventory
against current routes, commands, settings, plugins, platform clients, and
action menus. Document omitted features even when their live prerequisites are
unavailable. Preserve an explicitly requested subset, but do not infer a scope
limit from gaps left by an earlier generator.

Work directly unless delegation is authorized. When source review is
delegated, keep browser driving with one owner and reconcile findings before
editing. Concurrent reviewers must not manipulate a shared app session.

## Drive the app

Follow the skill's launch and isolation rules. Run doctor before driving and
after unexpected behavior. Reset a stuck UI to a known state; do not repeatedly
click into a broken session. Exercise every mapped feature through its actual
user entry point, even when source review finds no drift.

Record the initial state, action, observable outcome, and relevant side effect.
Use fresh isolated sessions when the launch model requires them. Preserve
evidence outside disposable runtime state, including failed-attempt evidence.
Clean up residue from failed attempts before proceeding.

When a prerequisite is missing, record what was attempted and the prerequisite.
Source inspection is not a live pass. Do not claim whole-product coverage from
a feature map that deliberately covers only a subset.

## Reconcile

- Wrong documentation: correct it using source and live evidence.
- Working behavior the harness cannot drive: repair the harness, then run the
  repaired recipe before accepting it.
- Broken product behavior: report the regression and evidence; keep the
  expected behavior intact.
- Missing prerequisite: mark coverage blocked and say what enables a retry.

Retry a failed setup or drive once after correcting its observed cause; stop
that feature if it remains blocked and continue independent coverage.

## Finish

Run final cleanup after all rechecks. Confirm owned processes and browser
sessions stopped and evidence remains. Review the diff and report one outcome:

- **clean:** every mapped feature has source and live coverage; no corrections.
- **changed:** all mapped features have coverage and proven corrections are
  ready to commit.
- **blocked:** coverage or verification of a correction could not finish.
  Report completed coverage and any useful partial corrections explicitly.

Keep transient run details outside the repo. A checked-in validation summary,
when requested, names the tested source commit and scope and excludes secrets,
personal data, and machine-specific paths. Commit or publish only within the
user's authorization. Do not create an automation merely because an audit ran.

Adapted from [pstack](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md).
The upstream MIT license is included in `LICENSE`.
