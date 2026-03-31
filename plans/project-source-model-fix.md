# Project Source Model Fix

## Goal

Model project sources as a discriminated union with only valid states:

- `local_path`: `hostId` + `path`
- `github_repo`: `repoUrl`

Remove the current flat shape that allows host-scoped GitHub sources and nullable fields that do not carry their own semantics.

## Work

1. Update the shared domain and public API contracts so `ProjectSource`, create-source requests, and update-source requests encode the new union directly.
2. Update persistence and migrations so `project_sources.host_id` becomes nullable, existing `github_repo` rows are migrated to `NULL` host IDs, and invalid combinations are rejected at the database level.
3. Update server routes and DB helpers to create, read, and return the new source shapes without leaking database-row nullability into domain responses.
4. Update app code that reads project sources so local-path behavior only considers `local_path` entries.
5. Add regression coverage for:
   - creating a `github_repo` source without a host
   - preserving local-path behavior for local sources
   - changing a project path reusing only an existing `local_path` source

## Exit Criteria

- No shared contract type permits a `github_repo` source with `hostId` or `path`.
- No shared contract type permits a `local_path` source without `hostId` and `path`.
- Existing project-source routes accept valid payloads and reject invalid cross-type payloads.
- The “change project path” flow only targets an existing `local_path` source on the local host.
- Database migrations preserve existing rows and normalize `github_repo.hostId` to `NULL`.
- The plan file is deleted once the work is complete.

## Validation

- `pnpm exec turbo run test --filter=@bb/db --force`
- `pnpm exec turbo run test --filter=@bb/server-contract --force`
- `pnpm exec turbo run test --filter=@bb/server --force`
- `pnpm exec turbo run test --filter=@bb/app --force`
