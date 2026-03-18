# Goal

Surface environment information consistently in the CLI (`bb thread show`, `bb status`) using the same display logic the UI uses, so agents and users can see where a thread runs and get the environment ID needed for spawning into the same environment.

# Scope

In scope:

- Extract environment display logic from the UI into a shared utility in `@bb/core`
- Add environment info to `bb thread show` human output
- Add environment info to `bb status` human output
- Include environment ID in both commands' `--json` output (already there via the Thread object, but should be prominent)

Out of scope:

- Changing how environments are provisioned or stored
- Adding new environment CLI commands
- Changing the UI's rendering (it should consume the shared utility too, but that's a follow-on)

# Implementation Steps

## 1. Extract environment display logic into `@bb/core`

The UI has display logic spread across `ThreadDetailView.tsx`:
- `formatThreadEnvironmentLabel()` — produces labels like "Primary", "Worktree (branch-name)", "Docker", "Local (/path)"
- `formatAttachedEnvironmentSuffix()` — extracts the relative worktree path for display
- `getThreadEnvironmentDisplay()` — combines label with worktree open path

Create a shared utility in `@bb/core` (e.g., `src/environment-display.ts`) that takes an `EnvironmentRecord` and optional `projectRootPath`, and returns a structured display object:

```typescript
export interface EnvironmentDisplayInfo {
  /** Human-readable label: "Primary", "Worktree (feature-branch)", "Docker", etc. */
  label: string;
  /** The environment kind for programmatic use */
  kind: "primary" | "worktree" | "docker" | "local" | "unknown";
  /** The environment ID (for use with --environment flag) */
  id: string;
  /** The filesystem path, if available */
  path?: string;
  /** Whether bb manages this environment's lifecycle */
  managed: boolean;
}

export function formatEnvironmentDisplay(
  environment: EnvironmentRecord,
  projectRootPath?: string,
): EnvironmentDisplayInfo;
```

The label logic should match what the UI currently does:
- If descriptor path equals project root → "Primary"
- If properties.location is "docker" → "Docker"
- If properties.workspaceKind is "worktree" → "Worktree" (with relative path suffix if available)
- If properties.location is "localhost" → "Local" (with path if different from project root)
- Fallback → "Unknown"

## 2. Update `bb thread show` to display environment info

In the `printThreadStatus` function in `apps/cli/src/commands/thread.ts`:

After the existing thread metadata (Status, Project, Parent, etc.), add an Environment section:

```
Thread thr_abc123
Status idle
Project proj_def456
Environment Worktree (feature-branch)
  ID: env_ghi789
  Path: /Users/me/projects/my-app/.bb/worktrees/thr_abc123
```

Use the shared `formatEnvironmentDisplay()` to produce the label. Show:
- The label on the main Environment line
- The environment ID (agents need this for `bb thread spawn --environment`)
- The path (when available)

The `--json` output already includes `attachedEnvironment` on the Thread object — no change needed there.

## 3. Update `bb status` to display environment info

In `apps/cli/src/commands/status.ts`, the thread section should include environment info when available:

```
Thread: thr_abc123
  Type: standard
  Status: active
  Title: Implement settings page
  Parent: thr_def456
  Environment: Worktree (feature-branch)
  Environment ID: env_ghi789
```

The environment ID is the key piece for agents — it's what they pass to `--environment` when spawning review threads into the same worktree.

Update the `StatusPayload` interface to include environment display info in the `--json` output.

## 4. (Follow-on) Update the UI to use the shared utility

The UI currently has its own copy of this logic in `ThreadDetailView.tsx`. As a follow-on, replace it with the shared utility from `@bb/core`. This isn't blocking for the CLI work but keeps things DRY.

# Validation

- `bb thread show <id>` displays environment label, ID, and path in human output
- `bb thread show <id> --json` includes `attachedEnvironment` (already does)
- `bb status` displays environment info for the current thread
- `bb status --json` includes environment display info
- Labels match what the UI shows for the same thread
- Typecheck passes for `@bb/core`, `@bb/cli`, and `@bb/server`

# Design Principle

The shared utility returns the same structured information for both CLI and UI. Each surface presents it appropriately for its medium:

- **CLI:** Show full paths (appropriate for terminal context where users copy-paste paths). Show environment ID prominently (agents need it for `--environment`).
- **UI:** Show relative path suffixes or abbreviated labels. Offer "open" buttons instead of raw paths. Environment ID available on hover or in detail panel.

Both surfaces consume the same `EnvironmentDisplayInfo` — they just render different fields.

# Open Questions/Risks

- Should `bb thread list --include-work-status` also show environment info per thread? Probably not in the table view (too wide), but the `--json` output already includes it.
