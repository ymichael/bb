# Goal

Migrate Beanbag to a single environment execution path that works for current host-backed environments and future remote environments, starting with a `docker` environment and an environment-agent transport model.

The design must support many environment implementations over time without encoding Docker-specific or E2B-specific assumptions into the daemon, provider runtime, or UI layers.

# Scope

In scope:

- Introduce a universal environment-agent transport model used by all environments
- Remove the current direct daemon-to-provider child-process path
- Refactor environment provisioning so each environment returns an environment-agent connection target instead of owning provider runtime spawning directly
- Preserve current `local` and `worktree` behavior by moving them onto the new path first
- Add a first new remote-capable environment kind: `docker`
- Keep environment contracts extensible for future environments such as E2B or other hosted runtimes

Out of scope for this phase:

- Implementing E2B itself
- Building a production-grade distributed queue or external durable event store
- Redesigning the app UI beyond the minimum environment catalog/status changes needed for the migration
- Solving every remaining environment abstraction leak unrelated to runtime transport

# Implementation Steps

1. Define the new environment-agent contract

- Add a single new package, `packages/environment-agent`
- Keep protocol types, daemon client, and environment-agent server/runtime in this package for v1
- Define closed/internal command and event unions for:
  - environment readiness and health
  - thread start/resume/stop
  - turn start/steer
  - workspace status/diff/commit style operations
  - replay/ack cursors and idempotency keys
- Keep the protocol independent of Docker specifics

2. Refactor environment provisioning around an environment-agent handle

- Change `packages/environment` so environments no longer expose provider runtime spawning as a raw `ChildProcess`
- Introduce a transport-facing handle/result that describes how the daemon connects to the environment agent
- Keep environment responsibilities focused on:
  - provisioning or restoring the workspace
  - lifecycle cleanup
  - exposing environment capabilities and metadata
  - ensuring the environment agent is reachable
- Ensure the new shape still supports many environment kinds in the future

3. Move the daemon and agent-server onto the universal path

- Refactor `packages/agent-server` so it no longer requires a local stdio child process owned by the daemon
- Move provider runtime ownership behind the environment-agent boundary
- Update `apps/daemon` orchestration to:
  - provision an environment
  - connect to its environment agent
  - send start/resume/turn commands through the new client
  - consume sequenced replayable events from the environment agent
- Remove the old direct spawn path instead of keeping both models alive

4. Migrate host-backed environments first

- Convert `local` to the new loopback environment-agent path
- Convert `worktree` to the same path
- Keep their current product behavior, but make them use the same transport semantics as future remote environments
- Add focused tests proving the new path works before introducing Docker

5. Add the `docker` environment

- Add a `docker` environment definition in `packages/environment`
- Provision a per-thread container/workspace
- Start `environment-agent` inside the container
- Connect from the daemon through the same client/protocol used by `local` and `worktree`
- Keep the Docker environment implementation thin by reusing the shared environment-agent protocol and daemon orchestration

6. Add resilience and recovery behavior

- Implement monotonic event sequencing and replay-from-cursor
- Add idempotent command submission and retry-safe semantics
- Ensure environment-agent can buffer outbound events during daemon downtime
- On daemon restart, reconnect and replay missed events so threads catch up automatically

7. Follow-up cleanup

- Remove now-dead direct-spawn code and tests
- Re-audit environment display, environment persistence, and diagnostics flows for assumptions tied to host execution
- Capture any remaining gaps needed for future non-host environments in a follow-up plan or issue

# Validation

- `pnpm --filter @beanbag/environment-agent test`
- `pnpm --filter @beanbag/environment typecheck`
- `pnpm --filter @beanbag/environment test`
- `pnpm --filter @beanbag/agent-server typecheck`
- `pnpm --filter @beanbag/agent-server test`
- `pnpm --filter @beanbag/daemon typecheck`
- `pnpm --filter @beanbag/daemon test`
- Add focused end-to-end or integration tests for:
  - local environment through environment-agent
  - worktree environment through environment-agent
  - reconnect/replay behavior
  - docker environment provisioning and command/event flow

# Open Questions/Risks

- The current `IEnvironment` interface is host-process-centric in a few places. Refactoring it without overfitting to the first transport shape is the highest-risk design step.
- If we push too much provider-specific behavior into `packages/environment-agent`, we may recreate the same coupling in a new place. Keep provider adapter logic reusable and environment-agnostic.
- Durable buffering can start in-memory or on local disk for v1, but the replay contract must be designed as if environments may be interrupted and resumed later.
- Docker is the first remote-ish environment, but not the last. The environment-agent connection target must not assume localhost, Docker-specific networking, or a single deployment model.
