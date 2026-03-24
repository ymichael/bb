# Phase 2b Findings: apps/app Cut-Over to New Contracts

## Resolved

- All type renames applied (SpawnThread→CreateThread, Tell→Send, etc.)
- All route renames applied (tell→send, queue→drafts, operations→actions, etc.)
- All function/hook renames applied
- `ThreadChangeKind` import moved from `@bb/server-contract` to `@bb/domain`
- `steer-if-active` → `auto` send mode
- `projectInstructions` / `ProjectSettingsView` deleted
- SystemRestart*, SystemStatus, ServerRuntimeMode, StatusFooter deleted
- `demotePrimaryIfNeeded` removed from send message
- `includeArchived` → `archived` filter
- `/system/provider` (singular) → removed, use `/system/providers`
- Dead code swept via knip (8 files deleted, 19 files cleaned)
- `ThreadQueuedMessage.input` → `.content`
- Project response now includes sources (no separate route)
- Workspace status moved to `GET /environments/:id/status`
- `isPromoted` dropped from API

## Remaining: 143 type errors

### Mechanical fixes (~35 errors)

| Issue | Errors | Fix |
|---|---|---|
| `provisioned` / `provisioning_failed` in switch statements | 10 | Remove those cases (statuses no longer exist) |
| `titleFallback` references | 8 | Update function signatures to not expect this field |
| `rootPath` on Project | 4 | Use `project.sources` from `ProjectResponse` |
| `workStatus` on Thread | 2 | Remove — now on `GET /environments/:id/status` |
| `queuedMessages` on Thread | 2 | Separate fetch, not inlined on Thread |
| `ThreadStatusShape` mismatches | 6 | Update to match new Thread type shape |
| Various `undefined` vs `null` | ~3 | Fix nullable field access |

### Needs code rework (~44 errors)

| Issue | Errors | What needs to happen |
|---|---|---|
| `attachedEnvironment` on Thread | 14 | App fetches environment separately via `GET /environments/:environmentId`. Thread only has `environmentId`. |
| `primaryCheckout` on Thread | 6 | App derives promoted state by comparing environment `branchName` with primary source branch. No API field. |
| `Environment.properties` (old shape) | 8 | Update to use new Environment fields (`path`, `hostId`, `managed`, `isGitRepo`, `branchName`, `status`) |
| `SystemEnvironmentInfo` | 6 | Replace with `/environments` + `/hosts` queries |

### Needs decision (~10 errors)

| Issue | Errors | Options |
|---|---|---|
| `PromptMentionSuggestion` | 4 | Add file mention type to contract, or remove @-mention feature for now |
| `UploadedPromptAttachment` | 3 | Add attachment type to contract, or remove attachment upload for now |
| `EnvironmentCapabilities` | 3 | Export from `@bb/domain`, or derive from environment properties |
