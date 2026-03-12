# Goal

Make daemon/env-agent QA fast, reliable, trustworthy, and maintainable after the lifecycle rewrite lands.

# Scope

- Improve QA ergonomics for manual and scripted end-to-end passes.
- Improve observability for session/liveness state during restart and worker-loss scenarios.
- Reduce reliance on ad hoc shell parsing and direct SQLite inspection for common checks.
- Define canonical lifecycle invariants so QA asserts durable semantics instead of fragile timing details.
- Add a path to keep the standalone QA matrix aligned with real lifecycle behavior as the architecture evolves.
- Standardize failure artifacts so a failed run is easy to triage without re-running it interactively.

# Implementation Steps

1. Define the QA quality bar and lifecycle invariants.
   - document the core lifecycle invariants that must always hold
   - examples: one active live session per thread, restart convergence, expected idle/finalized session semantics, recoverability after missing worker
   - define target runtime and intended usage for each QA tier
   - define success metrics: common-path runs without SQLite, flaky-rate target, and expected failure-triage inputs

2. Add machine-readable CLI output for the core inspection commands used in QA.
   - `bb daemon health --json`
   - `bb project list --json`
   - `bb thread show --json`
   - `bb thread status --json`
   - `bb thread log --json`
   - `bb thread output --json`
   - classify each command as stable operator-facing output vs debug-oriented output

3. Add CLI wait primitives for common lifecycle polling.
   - `bb thread wait <id> --status <status> --timeout <seconds>`
   - `bb thread wait <id> --event <normalized-event-type> --timeout <seconds>`
   - return stable exit codes for timeout vs invalid request vs success
   - prefer waiting on invariant-friendly state transitions over arbitrary sleeps

4. Add daemon/CLI inspection for env-agent session state.
   - `bb thread sessions <id> --json`
   - include session id, status, close reason, control endpoint, last heartbeat, lease expiry
   - optionally add `bb daemon sessions --active`
   - keep low-level fields clearly marked as debug-oriented if they are not intended as a long-term operator contract

5. Add targeted QA helpers and standard failure artifact capture.
   - a helper to print the active thread/worktree/session summary
   - a helper to print the current daemon log path
   - a helper to capture a concise failure bundle for one thread
   - failure bundles should include relevant CLI/API output, daemon logs, scenario metadata, and timestamps; SQLite snapshots should be optional for deeper debugging rather than required for the common path

6. Add a checked-in QA harness for the standalone daemon matrix.
   - encode the scenarios from `qa/daemon/standalone-daemon-qa.md`
   - verify API output, durable invariants, and daemon logs together
   - support both local and worktree flows
   - support hard worker-loss simulation, not only graceful shutdown
   - emit structured artifacts for failures and scenario summaries

7. Add deterministic fault-injection or controlled simulation for recovery-heavy cases where possible.
   - cover hard missing-worker restart, delayed heartbeat, stale lease/session, and repeated reconnect/recovery flows
   - prefer durable invariants and eventual-state checks over exact timing expectations
   - keep the minimal provider-backed matrix small and high-value if some cases remain inherently timing-sensitive

8. Split QA into explicit tiers with cadence and blocking policy.
   - smoke pass: start/follow-up/stop/basic restart; fast enough for frequent local use and PR gating if stable
   - lifecycle stress pass: immediate follow-ups, queued work, restart/liveness, provisioning edge cases; best suited for nightly or pre-release runs
   - regression pass: previously discovered bugs with stable repros; must be easy to extend after incidents
   - document target runtime, trigger conditions, and whether each tier is blocking or advisory

9. Keep the QA docs and harness aligned with architecture semantics.
   - update the doc whenever worker lifecycle semantics change
   - explicitly separate “expected live session during run” from “session state after final idle”
   - remove stale assumptions quickly so future passes do not test the wrong thing
   - require doc + invariant + harness updates together when lifecycle behavior changes

# Validation

- Run the standalone QA matrix using only the CLI/API surfaces intended for operators or supported debugging flows, without shell parsing of human-readable output.
- Verify the harness can reproduce:
  - immediate follow-up after idle
  - surviving restart
  - hard missing-worker restart
  - idle restart with fresh session
  - worktree promote/demote
- Verify at least one recovery-heavy scenario is reproducible in a controlled, low-flake way.
- Verify failures produce a self-contained artifact bundle sufficient for triage without re-running interactively.
- Verify a new engineer can run the documented pass without needing direct SQLite knowledge for the common path.
- Verify the QA tiers have clear runtime/cadence expectations and can be adopted incrementally.

# Open Questions/Risks

- How much CLI surface do we want to expose for low-level env-agent session data versus keeping that daemon/API-only?
- Do we want a dedicated QA harness under `scripts/`, as an end-to-end test target under the daemon package, or as its own workspace package/app?
- Which failure modes require true provider-backed coverage versus deterministic simulation or fault injection?
- Some restart/liveness scenarios are inherently timing-sensitive with the real provider; the harness should prefer durable invariants over exact timing expectations.
- QA surfaces that expose deep lifecycle/session internals may create long-term support burden if we do not clearly separate stable contracts from debug-oriented tooling.
