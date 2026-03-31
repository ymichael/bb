# File Surfaces Roadmap

## Goal

Move the current file-related features toward two stable product capabilities:

1. **Blob-backed file delivery**
   - Attachments
   - Published manager workspace files
2. **Source-backed file discovery**
   - Project source file listing for both `local_path` and `github_repo`

The public API should stay stable where possible while the server swaps route internals behind those contracts.

## Current State

### Blob-backed reads today

- **Attachments**
  - Uploaded through `POST /api/v1/projects/:id/attachments`
  - Served through `GET /api/v1/projects/:id/attachments/content`
  - Backed by server-local filesystem in `apps/server/src/services/attachments.ts`
- **Manager workspace**
  - Listed through `GET /api/v1/threads/:id/manager-workspace/files`
  - Read through `GET /api/v1/threads/:id/manager-workspace/content`
  - Authored in a live host-local folder derived from `<session.dataDir>/workspace/<threadId>`
  - Still served from the live host today

### Source-backed listing today

- **Repo workspace files**
  - Listed through `GET /api/v1/projects/:id/files`
  - Only works for `local_path` project sources today
  - Internally proxies to daemon `workspace.list_files`

## Target State

### Blob-backed file delivery

- Attachments remain uploadable and readable through their current public routes.
- Manager workspace files continue to be authored locally by the manager agent in a host-local folder.
- Manager workspace user-facing reads stop depending on the live host.
- Instead, manager workspace files are published into object storage and served from a synced snapshot.
- The app treats attachment URLs and manager-workspace URLs as ordinary file URLs.

### Source-backed file discovery

- `GET /api/v1/projects/:id/files` remains the single user-facing endpoint for project file suggestions.
- The server dispatches internally on project source type:
  - `local_path` -> daemon-backed `workspace.list_files`
  - `github_repo` -> GitHub API-backed implementation
- Prompt composer and other consumers do not care which source type produced the list.

## Design Principles

- Keep **blob-backed delivery** separate from **source-backed discovery**.
- Do not collapse all file features into one generic route family that hides meaningful differences.
- Server owns product policy, route behavior, source dispatch, snapshot selection, and storage configuration.
- Daemon owns host-local filesystem access and optional host-local change detection.
- Manager workspace should have a **write model** and a separate **read model**:
  - write model: live host-local folder
  - read model: published snapshot
- Prefer metadata-first preview flows. Consumers should not need to download arbitrary binary payloads just to learn they are not previewable.

## Completed Pre-Work

The current live manager-workspace path was hardened before this roadmap:

1. `host.read_file` now requires a declared `rootPath`, and the daemon enforces symlink-resolved containment under that root.
2. `GET /threads/:id/manager-workspace/content` and manager preferences reads both use the durable manager workspace root as that bound.
3. The daemon now uses UTF-8 transport only when the file bytes are actually valid UTF-8; otherwise it falls back to base64 and preserves the original bytes.

## Proposed Package Boundary

Introduce **`@bb/blob-storage`** as the first new shared package.

This package should be **storage-only**. It should not know about attachments, manager workspaces, projects, previewability, or route semantics.

### Why this package comes first

- Attachments and published manager workspace are converging on the same storage substrate.
- If storage abstractions start inside `server` first, they are likely to accrete product concepts and become hard to extract cleanly later.
- S3 and R2 are both stable enough that we can commit to a provider-neutral storage interface now.

### Proposed minimal interface

```ts
interface BlobStorage {
  put(args: {
    key: string;
    body: Uint8Array;
    contentType?: string;
    cacheControl?: string;
    metadata?: Record<string, string>;
  }): Promise<{
    etag?: string;
    sizeBytes: number;
  }>;

  get(args: {
    key: string;
    range?: { start: number; end?: number };
  }): Promise<{
    body: Uint8Array;
    contentType?: string;
    cacheControl?: string;
    metadata: Record<string, string>;
    sizeBytes: number;
    etag?: string;
  } | null>;

  head(args: {
    key: string;
  }): Promise<{
    contentType?: string;
    cacheControl?: string;
    metadata: Record<string, string>;
    sizeBytes: number;
    etag?: string;
  } | null>;

  delete(args: {
    key: string;
  }): Promise<void>;
}
```

Optional, but likely useful:

```ts
interface BlobUrlSigner {
  signGet(args: {
    key: string;
    expiresInSeconds: number;
  }): Promise<string>;
}
```

### Explicit non-goals for `@bb/blob-storage`

- No bucket traversal or `list` in the core interface
  - manager workspace should list from a manifest, not from raw object-store prefixes
- No attachment or manager-workspace domain types
- No GitHub client logic
- No MIME preview policy
- No route/auth logic

## Ownership Split

### `@bb/blob-storage`

- Provider-neutral storage interfaces
- Local filesystem implementation
- S3-compatible implementation for S3/R2
- Shared contract tests across implementations

### Server-owned code

- `AttachmentStore`
- `PublishedManagerWorkspaceStore`
- `ManagerWorkspacePublisher`
- `ProjectSourceFileLister`
- Object key naming
- Snapshot manifest persistence
- Route behavior and access policy

### Daemon-owned code

- Host-local bounded file listing and reading primitives
- Optional file change reporting hooks if we later want more immediate manager-workspace publishing

### Maybe later: `@bb/files`

Do **not** introduce this first.

Add `@bb/files` only if we later have enough truly shared file-domain logic to justify it, for example:

- snapshot manifest schemas shared across server and app
- stable file metadata types used by multiple packages
- MIME policy helpers that genuinely need to be shared across app/server/daemon

If that package happens later, it should sit above `@bb/blob-storage`, not replace it.

## Migration Plan

### Phase 0: Remove dead `workspace.read_file` if it stays unused by product code

1. Remove `workspace.read_file` if it stays unused by product code
   - After the manager-workspace migration, this command appears to be dead outside daemon contracts/tests.
   - If no caller needs it, delete it end to end instead of keeping parallel read surfaces around.

Exit condition:
- no product code depends on `workspace.read_file`

### Phase 1: Introduce `@bb/blob-storage`

1. Create `packages/blob-storage`
2. Define the provider-neutral interfaces
3. Add a local-filesystem implementation
4. Add an S3-compatible implementation for S3/R2
5. Add implementation-agnostic contract tests

Exit condition:
- the repo has a storage package whose public API is provider-neutral and does not mention attachments or manager workspaces

### Phase 2: Move attachments onto `@bb/blob-storage`

1. Introduce a server-side `AttachmentStore` backed by `@bb/blob-storage`
2. Keep the current local-filesystem behavior as the default implementation
3. Add an object-storage-backed implementation behind configuration
4. Preserve the current attachment upload/read routes while swapping route internals

Exit condition:
- attachments can be stored either locally or in object storage without route changes

### Phase 3: Introduce a published manager-workspace read model

1. Introduce a server-side `PublishedManagerWorkspaceStore`
2. Define a manifest format for manager workspace snapshots
3. Persist a pointer to the latest published snapshot for each manager thread
4. Keep the live host-local manager workspace as the write path
5. Treat the published snapshot as the read path for `files` and `content`

Preferred behavior:
- the manager keeps writing to disk exactly as it does today
- publication happens on turn completion and/or explicit file change events
- user-facing list/read routes serve the latest completed snapshot

Exit condition:
- manager workspace list/read routes no longer require the host to be online for previously-published content

### Phase 4: Publish manager workspace snapshots into object storage

1. Add a sync/publish pipeline for manager workspace snapshots
2. Upload changed files to object storage
3. Publish a manifest for list/read lookup
4. Decide whether file content routes should proxy bytes or redirect to signed object URLs

Open question:
- persist manifests in DB rows, object storage, or both

Exit condition:
- manager workspace reads come from published storage, not live host reads

### Phase 5: Dispatch project file listing by source type

1. Introduce a server-side `ProjectSourceFileLister`
2. Route `/projects/:id/files` through that abstraction
3. Keep the current `local_path` implementation using daemon `workspace.list_files`
4. Add a `github_repo` implementation using GitHub’s API
5. Preserve the same response shape for prompt-composer consumers

Exit condition:
- `/projects/:id/files` works for both `local_path` and `github_repo` project sources

### Phase 6: Move to metadata-first preview ergonomics

1. Extend blob-backed file list/manifests to include at least:
   - `path`
   - `name`
   - `mimeType`
   - `sizeBytes`
2. Let the app decide previewability before downloading content
3. Restrict full-content fetches to files already known to be previewable
4. Consider partial text preview support for larger text files

Exit condition:
- consumers do not need to download arbitrary binary content just to decide whether preview is possible

## Public API Direction

### Keep stable

- `POST /api/v1/projects/:id/attachments`
- `GET /api/v1/projects/:id/attachments/content`
- `GET /api/v1/threads/:id/manager-workspace/files`
- `GET /api/v1/threads/:id/manager-workspace/content`
- `GET /api/v1/projects/:id/files`

### Internal changes behind those routes

- attachments: filesystem-backed -> `@bb/blob-storage`-backed attachment store
- manager workspace: live host read -> published snapshot read
- project file listing: local-path-only -> source-type dispatcher

## Exit Criteria

- `@bb/blob-storage` exists with a stable provider-neutral interface and at least local + S3-compatible implementations.
- Attachments can be backed by either local filesystem or object storage without changing public routes.
- Manager workspace list/read routes serve published snapshots rather than live host files.
- Manager workspace live writes remain unchanged for the agent.
- `/projects/:id/files` supports both `local_path` and `github_repo`.

## Validation

### `@bb/blob-storage`

- `pnpm exec turbo run typecheck --filter=@bb/blob-storage`
- `pnpm exec turbo run test --filter=@bb/blob-storage`
- contract tests should run against both local and S3-compatible implementations

### Attachments and manager workspace

- attachments: test both local and object-backed implementations against the same route behavior
- manager workspace: test list/read behavior against published snapshots
- manager workspace: test snapshot publication from a host-local write directory into object storage

### Project source listing

- test both `local_path` and `github_repo` through `/projects/:id/files`

## Notes

- Delete this plan once the roadmap is either completed or superseded.
