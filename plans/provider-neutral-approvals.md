# Provider-Neutral Approvals

## Goal

Make pending approvals provider-neutral in the domain and server. Adapters should
translate provider-specific approval callbacks into bb semantic approval requests,
and translate bb semantic approval resolutions back into provider-specific
responses.

The server, app, CLI, and timeline should reason about what the user is
approving, not which provider protocol callback produced the prompt.

## Current Problem

Pending interaction payload kinds currently mix two concerns:

- the user-facing approval target, such as a command, file change, or permission
  grant
- the provider response protocol, such as Codex command approval, Codex file
  approval, or Claude `canUseTool`

That causes equivalent user decisions to appear as different domain concepts:

- Codex command approval becomes `command_approval`
- Codex file-change approval becomes `file_change_approval`
- Claude `Bash`, `Edit`, and `Write` approvals become generic
  `permission_request`

This leaks provider protocol shape into product semantics and makes UI, CLI,
timeline, validation, and tests handle provider differences that should be
adapter-owned.

## Design Principle

The approval protocol should model a semantic subject by reference, not by
provider-specific payload shape.

For file changes specifically, the approval should not define whether changes
are present, nullable, optional, or missing. That question belongs to the
provider item stream, not the approval request. A file-change approval should
reference the file-change subject by `itemId`; rendering can join that approval
to the corresponding `fileChange` item when available.

This avoids baking Codex's "diff is in `item/started`, not the approval request"
into the domain model while still supporting providers that can derive or emit
file-change details earlier.

## Target Domain Model

Replace provider-shaped pending interaction kinds with a semantic approval
payload.

The provider-agnostic approval layer supports exactly three decisions:

- `allow_once`
- `allow_for_session`
- `deny`

Do not add `cancel` to the provider-agnostic model. If a user wants to stop the
turn, use the existing thread/turn stop lifecycle instead of overloading an
approval response.

Sketch:

```ts
type PendingInteractionPayload = {
  kind: "approval";
  subject: ApprovalSubject;
  reason: string | null;
  availableDecisions: ApprovalDecision[];
};

type ApprovalSubject =
  | {
      kind: "command";
      itemId: string;
      command: string;
      cwd: string | null;
    }
  | {
      kind: "file_change";
      itemId: string;
    }
  | {
      kind: "permission_grant";
      itemId: string;
      toolName: string | null;
      permissions: GrantablePermissionProfile;
    };

type ApprovalDecision =
  | "allow_once"
  | "allow_for_session"
  | "deny";

type PendingInteractionResolution = {
  kind: "approval";
  decision: ApprovalDecision;
  grantedPermissions?: GrantedPermissionProfile;
};
```

Important details:

- `file_change` approval references the file-change item by `itemId`; it does
  not carry `changes: null`.
- File-change details remain owned by the normal `fileChange` item event stream.
- Command approvals may carry command text because command text is the command
  subject identity, and both Codex and Claude expose it at approval time for
  concrete command prompts.
- Permission grants carry explicit permissions because the grant itself is the
  subject being approved.
- Provider-specific concepts such as Codex `acceptForSession` or Claude
  `updatedPermissions` stay in adapter encode/decode logic.
- `cancel` is intentionally not part of the core decision set. Codex command and
  file approvals support it, but Claude permission responses and Codex
  permission grants do not have a clean equivalent. A user-facing "stop/cancel
  turn" action should be modeled as thread lifecycle, not as an approval
  decision.

## Provider Audit

### Summary

The supported provider-neutral decision set is:

- `allow_once`
- `allow_for_session`
- `deny`

`cancel` is deliberately excluded. Provider-specific policy amendment choices
are also excluded from the first provider-neutral subset unless they can be
represented as one of the three semantic decisions without changing user
meaning.

### Codex

Codex exposes three approval request methods through app-server v2:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

Command approval response support:

- `accept` maps cleanly to `allow_once`
- `acceptForSession` maps cleanly to `allow_for_session`
- `decline` maps cleanly to `deny`
- `cancel` exists but is outside the provider-neutral subset
- `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` exist but
  are provider-specific allow variants

File-change approval response support:

- `accept` maps cleanly to `allow_once`
- `acceptForSession` maps cleanly to `allow_for_session`
- `decline` maps cleanly to `deny`
- `cancel` exists but is outside the provider-neutral subset

Permission approval response support:

- permissions with `scope: "turn"` maps to `allow_once`
- permissions with `scope: "session"` maps to `allow_for_session`
- empty permissions with `scope: "turn"` maps to `deny`
- there is no distinct cancel response

Adapter policy:

- Prefer simple Codex decisions when constructing semantic
  `availableDecisions`.
- If Codex omits `decline` but offers `cancel`, the adapter may map semantic
  `deny` to Codex `cancel` as a denial fallback, but should prefer `decline`
  when available.
- If Codex offers only provider-specific allow variants, the adapter should not
  silently pretend those are normal `allow_once` / `allow_for_session` until the
  product meaning is clear. Either omit the allow decision or introduce a
  separate semantic policy-update decision in a later change.

### Claude Code

Claude Code exposes approval through SDK `canUseTool`, not through separate
command/file approval protocol methods.

Claude permission result support:

- `behavior: "allow"` without `updatedPermissions` maps to `allow_once`
- `behavior: "allow"` with session `updatedPermissions` maps to
  `allow_for_session`
- `behavior: "deny"` maps to `deny`
- there is no distinct cancel response

Subject mapping:

- `Bash` with a concrete command maps to `subject.kind = "command"`
- `Edit`, `Write`, and `NotebookEdit` with a concrete file operation map to
  `subject.kind = "file_change"`
- network tools, directory/rule grants, unknown tools, and non-concrete tool
  prompts map to `subject.kind = "permission_grant"`

Adapter policy:

- Offer `allow_for_session` only when the adapter can produce meaningful
  session updates, such as `addDirectories` or `addRules`.
- Do not offer `allow_for_session` when it would encode the same response as
  `allow_once`.
- Map `deny` to Claude `behavior: "deny"`.

### Pi

Pi currently advertises only `full` permission mode in bb and the adapter has no
interactive approval decoder.

Adapter policy:

- Pi is outside the provider-neutral approval layer until it supports restricted
  permission modes and approval callbacks in bb.
- The provider-neutral approval contract should not be shaped around Pi until
  Pi has an approval path to map.

## Adapter Mapping

### Codex

- `item/commandExecution/requestApproval`
  - decode to `approval.subject.kind = "command"`
  - map Codex decisions to semantic decisions
  - encode semantic resolutions back to Codex command approval responses

- `item/fileChange/requestApproval`
  - decode to `approval.subject.kind = "file_change"`
  - use `itemId` to correlate with the `fileChange` item lifecycle
  - encode semantic resolutions back to Codex file-change approval responses

- `item/permissions/requestApproval`
  - decode to `approval.subject.kind = "permission_grant"`
  - encode semantic resolutions back to Codex permissions responses

### Claude Code

- `canUseTool("Bash", input)` with a concrete command
  - decode bridge approval to `approval.subject.kind = "command"`
  - preserve enough adapter-local request context to reply through Claude's
    permission result path

- `canUseTool("Edit" | "Write" | "NotebookEdit", input)` with a concrete file
  operation
  - decode bridge approval to `approval.subject.kind = "file_change"`
  - use the Claude tool-use id as the approval `itemId`
  - rely on the normal translated `fileChange` tool-use event for diff details

- network, directory-only, rule-only, unknown, or non-concrete tool approvals
  - decode to `approval.subject.kind = "permission_grant"`

- encode semantic resolutions back to Claude permission responses:
  - `allow_once` -> `behavior: "allow"`
  - `allow_for_session` -> `behavior: "allow"` with `updatedPermissions` when
    session updates are available
  - `deny` -> `behavior: "deny"`

## Server Responsibilities

The server should remain provider-agnostic:

- store the semantic approval payload
- store routing identity: `providerId`, `providerThreadId`, `providerRequestId`
- validate that submitted decisions are in `payload.availableDecisions`
- validate permission grants are subsets of requested permissions when the
  subject is `permission_grant`
- queue `interactive.resolve` with the semantic resolution

The server should not know that a semantic command approval came from Codex
command approval versus Claude `canUseTool`.

## UI And Timeline Responsibilities

Render approval prompts from `subject.kind`:

- `command`: "Waiting for approval to run X"
- `file_change`: "Waiting for approval to edit files"
- `permission_grant`: "Waiting for approval to grant X"

Timeline projection should join approvals to item rows by `subject.itemId`:

- command approval overlays the matching `commandExecution` row
- file-change approval overlays the matching `fileChange` row
- permission grants without a matching concrete item remain standalone approval
  rows

If the item row has not arrived yet, render a temporary approval row using the
semantic subject. When the item row arrives, projection should merge them into
one canonical row.

## Implementation Phases

Use an integration-test-first implementation loop. Start by changing
[packages/agent-runtime/src/integration.test.ts](/Users/michael/.codex/worktrees/1ac7/bb/packages/agent-runtime/src/integration.test.ts)
to describe the desired provider-neutral behavior, then make the runtime and
adapters satisfy those tests before moving outward to server, app, CLI, and
timeline surfaces.

1. Add or update integration tests in
   [packages/agent-runtime/src/integration.test.ts](/Users/michael/.codex/worktrees/1ac7/bb/packages/agent-runtime/src/integration.test.ts)
   for the provider-neutral contract:
   - Codex command approval decodes as semantic command approval with
     `allow_once`, `allow_for_session`, and `deny` when supported.
   - Claude `Bash` approval decodes as semantic command approval.
   - Codex file-change approval decodes as semantic file-change approval.
   - Claude `Edit` / `Write` approval decodes as semantic file-change approval.
   - Codex and Claude network/directory/rule prompts decode as semantic
     permission-grant approvals.
   - Pi remains outside the approval layer while it supports only `full`
     permission mode.
2. Replace pending interaction domain schemas with semantic approval payload and
   resolution schemas.
3. Update DB serialization tests and helpers for the new payload and resolution
   shapes.
4. Add adapter helpers for constructing semantic `availableDecisions` from each
   provider request.
5. Update Codex interactive request decoding and response encoding.
6. Update Claude bridge request construction and adapter response encoding.
7. Make the new integration tests pass before expanding scope.
8. Update server validation and pending interaction lifecycle tests.
9. Update app pending interaction banner/details to render semantic subjects.
10. Update CLI interaction commands/output to render and resolve semantic
   approvals.
11. Update timeline projection to merge approval lifecycle with matching
   command/file-change rows by `itemId`.
12. Remove old `command_approval`, `file_change_approval`, and
   `permission_request` branches from production code and tests.

## Exit Criteria

- Domain pending interactions expose one semantic approval shape, not
  provider-shaped approval kinds.
- Codex command approvals and Claude `Bash` approvals both render and resolve as
  command approvals.
- Codex file-change approvals and Claude `Edit`/`Write` approvals both render
  and resolve as file-change approvals.
- Permission grants remain explicit for network, directory/rule grants, and
  non-concrete tools.
- The core provider-neutral decision set is limited to `allow_once`,
  `allow_for_session`, and `deny`.
- `allow_for_session` is shown only when it has real provider meaning for that
  request.
- `cancel` is not modeled as an approval decision.
- The server has no provider-specific approval response branching.
- The app and CLI do not need to know whether an approval came from Codex or
  Claude.
- File-change approvals do not encode provider-specific diff availability in
  the approval payload.
- Timeline rows show one canonical lifecycle for approval, running/applying,
  denied, and completed states.

## Validation

### Automated

- `pnpm exec turbo run test --filter=@bb/agent-runtime --force`
- `pnpm exec turbo run typecheck --filter=@bb/domain --filter=@bb/agent-runtime --filter=@bb/server --filter=@bb/core-ui --filter=@bb/ui-core --filter=@bb/app --filter=@bb/cli`
- `pnpm exec turbo run test --filter=@bb/domain`
- `pnpm exec turbo run test --filter=@bb/db`
- `pnpm exec turbo run test --filter=@bb/agent-runtime`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/core-ui`
- `pnpm exec turbo run test --filter=@bb/ui-core`
- `pnpm exec turbo run test --filter=@bb/app`
- `pnpm exec turbo run test --filter=@bb/cli`

### Manual

- Run a Codex readonly command that requires approval and verify the prompt,
  denial, execution, and completion rows form one command lifecycle.
- Run a Claude readonly `Bash` command that requires approval and verify it
  renders like the Codex command approval.
- Run a Codex file edit requiring approval and verify the approval joins the
  file-change row by `itemId`.
- Run a Claude `Edit` or `Write` requiring approval and verify it renders like a
  file-change approval, with diff details coming from the file-change item row.
- Run a network permission request and verify it remains a permission grant
  approval rather than being forced into command or file-change UI.
