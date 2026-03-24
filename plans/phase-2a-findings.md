# Phase 2a Findings: CLI Contract Mismatches

Discovered during `apps/cli` cutover to new contracts (`@bb/domain`, `@bb/server-contract`).

## Missing routes in `@bb/server-contract`

| Route (old) | Route (new, per architecture) | Used by CLI command | Status |
|---|---|---|---|
| `/threads/:id/git-diff` | `/threads/:id/diff` | `bb thread show --git-diff` | Not in contract |
| `/threads/:id/merge-base-branches` | `/threads/:id/diff/branches` | `bb thread show --merge-base-branches` | Not in contract |
| `/threads/:id/output` | `/threads/:id/output` | `bb thread output` | Not in contract |

Removed: `bb server health` (command deleted), `bb project files` (command deleted), `bb thread sessions` (command deleted).

## Missing fields on domain types

| Type | Missing field | CLI usage | Notes |
|---|---|---|---|
| `Project` | `rootPath` | `bb project show/list/create/update`, `bb status`, `bb thread show` | Moved to `ProjectSource`. CLI needs either a denormalized field on Project or a way to resolve the primary source path. |
| `Thread` | `titleFallback` | `bb thread delete`, `bb manager list`, `bb status` | Removed from domain. CLI now falls back to `thread.id` or `null`. |
| `Thread` | `attachedEnvironment` | `bb status`, `bb thread show`, `bb environment demote` | Removed. CLI now uses `thread.environmentId` directly. Environment details (path, label) no longer available without a separate fetch. |
| `Thread` | `primaryCheckout` | `bb environment demote`, `bb environment promote-status` | Removed. No way to determine which environment is currently promoted. Needs a new route or field. |
| `Thread` | `workStatus` (inline on list response) | `bb thread list --include-work-status` | No `includeWorkStatus` query param on `/threads` route. Work status columns show "-" as placeholder. |

## Missing query parameters

| Route | Parameter | CLI usage |
|---|---|---|
| `GET /threads` | `includeWorkStatus` | `bb thread list --include-work-status` |
| `GET /threads/:id/timeline` | `includeToolGroupMessages` | `bb thread log` (removed, using empty query now) |

## Schema mismatches

| Area | CLI expects | Contract provides | Resolution |
|---|---|---|---|
| `CreateThreadRequest.providerId` | Optional (CLI allows omitting, server picks default) | Required (`z.string().min(1)`) | CLI now passes `""` as fallback. Contract should make `providerId` optional with server-side default resolution. |
| `CreateProjectRequest` | `{ name, rootPath }` | `{ name, hostId, sourcePath }` | CLI updated to require `--host` flag. This is a UX regression — consider auto-detecting the local host ID. |
| `UpdateProjectRequest` | `{ name?, rootPath?, projectInstructions?, defaultProviderId? }` | `{ name? }` | CLI options reduced to `--name` only. Other project settings need new routes or expanded schema. |
| Thread statuses | 7 values including `provisioned`, `provisioning_failed` | 5 values: `created`, `provisioning`, `idle`, `active`, `error` | CLI updated. Tests for removed statuses deleted. |
| Environment action request | `operation` discriminator field | `action` discriminator field | Fixed. |
| Environment action values | `promote_primary`, `demote_primary` | `promote`, `demote` | Fixed. |
| Environment action response | `CommitEnvironmentOperationResponse` with `operation` field | `CommitActionResponse` with `action` field | Fixed. |
| Promote/demote response | `{ ok, promoted/demoted, message }` | `{ ok, action, message }` | Fixed. |

## Commands temporarily disabled

These commands compile but print an error and exit because they depend on routes or fields not in the contract:

- `bb thread show --git-diff` — prints warning, skips
- `bb thread show --merge-base-branches` — prints warning, skips
- `bb thread output` — exits with error
- `bb environment promote-status` — exits with error
- `bb environment demote` (without explicit env ID) — exits with error when falling back to project-level resolution
