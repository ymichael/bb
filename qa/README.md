# QA

This folder is the top-level landing page for manual and scripted QA in Beanbag.

When we ask someone to **do a full QA pass**, start here.

## Purpose

Use this folder to:

- find the current QA runbooks
- understand which pass to run for a given change
- record and expand repeatable QA coverage over time
- keep QA guidance centralized instead of scattering it across docs and ad hoc notes

## Current QA Entry Points

### Full daemon/env-agent QA pass

Use the standalone daemon CLI QA guide:

- [`../docs/standalone-daemon-qa.md`](../docs/standalone-daemon-qa.md)

This is currently the primary full QA pass for validating:

- daemon startup and restart behavior
- thread lifecycle behavior
- env-agent liveness and recovery
- worktree flows
- CLI behavior against a real running daemon

## How to use this folder

If you are asked to run a **full QA pass**:

1. Start with the relevant guide linked from this README.
2. Run the entire required matrix, not just the first scenario that seems relevant.
3. Record pass/fail for each case.
4. Keep logs, command output, and any failure artifacts until triage is complete.
5. Note whether the failure is:
   - a product bug
   - a flaky/timing-sensitive test case
   - a stale QA expectation/documentation issue

## QA Principles

Our QA direction is to make passes:

- **reliable**: assert durable lifecycle invariants, not fragile timing details
- **operator-oriented**: prefer supported CLI/API surfaces over shell parsing
- **efficient**: make failures easy to triage without rediscovering the system manually
- **maintainable**: keep docs, invariants, and harness behavior aligned with architecture changes

## Expected evolution of this folder

Over time, this folder should become the home for:

- QA runbooks by subsystem
- smoke / stress / regression pass definitions
- links to automation entrypoints and artifact locations
- guidance for collecting failure bundles
- a changelog of newly added regression scenarios when useful

Likely future additions:

- `qa/daemon/`
- `qa/app/`
- `qa/regressions/`
- `qa/artifacts/README.md`

## Related planning docs

- [`../plans/qa-roadmap-for-daemon-env-agent.md`](../plans/qa-roadmap-for-daemon-env-agent.md)

That roadmap describes how we intend to improve QA reliability and efficiency beyond the current manual pass.
