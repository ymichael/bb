# WSL2 Manual Validation

## Scope

This follow-up plan tracks the only remaining Linux/WSL2 compatibility work that
cannot be completed from this macOS workspace: manual validation on Ubuntu in
WSL2.

All product-path code changes for macOS, Linux, and WSL2 are already in the
branch. Native Windows PowerShell/CMD support is explicitly out of scope.

## Exit Criteria

- `bb` install, build, typecheck, and test complete inside Ubuntu on WSL2.
- The host daemon starts and remains connected from Ubuntu on WSL2.
- `pnpm bb:dev` works from a WSL2 shell against the dev server.
- Local-path project create and update work with WSL-style absolute paths.
- Managed workspace provisioning succeeds with `.bb-env-setup.sh`.
- Mounted-path behavior under `/mnt/c/...` is validated and any observed caveat
  is captured in [`docs/platform-support.md`](../docs/platform-support.md).

## Validation Steps

Run the following from an Ubuntu WSL2 shell:

1. Install toolchain dependencies inside WSL2: Node.js, pnpm, Git, and the
   provider CLIs used for validation.
2. From the repository root, run:
   - `pnpm install --frozen-lockfile`
   - `pnpm exec turbo run build`
   - `pnpm exec turbo run typecheck`
   - `pnpm exec turbo run test`
3. Start the dev stack:
   - `pnpm dev`
   - in a second WSL2 shell, run `pnpm bb:dev status`
4. Verify host-daemon behavior:
   - confirm the daemon is connected in the app or via `pnpm bb:dev status`
   - use the app local-path flow with a WSL path such as `/home/<user>/repo`
   - update that project path through the same dialog
5. Verify setup-hook provisioning:
   - create or use a repository with `.bb-env-setup.sh`
   - start a managed clone/worktree thread
   - confirm the setup hook runs successfully
6. Validate mounted-path behavior:
   - repeat local-path create/update with a mounted path such as
     `/mnt/c/Users/<user>/repo`
   - note any filesystem performance or file-watching caveats

## Completion

Delete this plan once the WSL2 validation pass is complete or superseded.
