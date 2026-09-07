# Releasing bb-app

This runbook is for agents preparing and publishing the `bb-app` npm package.
Official plugins bundle into the app during packaging and ship with this same
release; see
[official-plugin-release-process.md](official-plugin-release-process.md).
It assumes the manual GitHub Actions publish workflow and npm Trusted
Publishing are configured. Until then, local `npm publish` is an emergency
fallback only.

A full release has **two** outputs that ship from the same release commit: the
`bb-app` npm package (`publish-bb-app.yml`) and the desktop app
(`build-desktop.yml`). They are published by independent workflows — publishing
npm does not publish the desktop app. Because the versions are locked together,
a normal release must run both. Do not consider a release complete until the
desktop app is published at the same version (see "Publish The Desktop App").

The automated nightly channel is the exception to the manual stable flow. The
scheduled path in `publish-bb-app.yml` derives a unique next-patch prerelease,
publishes it under npm's `nightly` dist-tag, then builds the separately
installable `bb Nightly` app for macOS and Linux and publishes both at
`desktop-nightly`. It does not commit the generated version or move either
stable `latest` pointer. Each platform job derives the nightly version from the
run ID, so the two jobs agree without sharing state. If the
`npm-release` GitHub environment requires approval, scheduled runs will wait
for that approval; remove the reviewer gate only if fully unattended nightly
publishing is intended.

The same channel can be exercised manually:

```bash
gh workflow run publish-bb-app.yml \
  --ref main \
  -f npm_tag=nightly \
  -f allow_prerelease_latest=false \
  -f dry_run=true
```

Set `dry_run=false` to publish both npm and the signed desktop nightly.

A stable release refreshes the nightly channel too. A nightly version is the
next patch above the version on `main`, so a new `latest` release moves ahead of
the newest nightly. To prevent a nightly channel that is older than `latest`, a
non-dry `npm_tag=latest` run adds a `publish-nightly` job. That job derives
`<next patch>-nightly.<run id>.<attempt>` from the release commit, publishes it
under the `nightly` dist-tag, and the same desktop jobs then rebuild and move
the `desktop-nightly` release. The nightly jobs run after the stable publish
succeeds, so a nightly failure cannot affect the release that already shipped.

## Release Policy

- Publish only from `main`.
- Publish only a version that exists in `packages/bb-app/package.json`.
- Keep `packages/bb-app/package.json` and `apps/desktop/package.json` versions
  locked together. The desktop app displays the same release version and CI
  rejects mismatches.
- Do not ask for an npm OTP during the normal release path.
- Do not run `npm publish` locally unless the user explicitly asks for the
  emergency fallback.
- Do not move the `latest` npm dist-tag unless the release request or current
  release policy explicitly says to.
- Always report the exact Git commit, npm version, dist-tags, validation, and
  workflow run status.

## Inputs

Before changing files, resolve these inputs from the user request:

| Input                   | Default  | Notes                                                             |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| Package                 | `bb-app` | This runbook does not publish other packages.                     |
| Version bump            | `patch`  | Example: `0.0.1` to `0.0.2`.                                      |
| npm dist-tag            | `latest` | This is the tag plain `npx bb-app` uses.                          |
| Allow prerelease latest | `false`  | Set to `true` only for an explicit prerelease-on-latest decision. |
| Publish dry run         | `false`  | Use `true` only when testing the workflow itself.                 |
| Source branch           | `main`   | Release commit must land on `main` before publishing.             |

If any input is unclear, ask before bumping the version.

## Prepare The Release Commit

1. Refresh the release worktree onto the canonical `main` branch.

   ```bash
   git fetch origin main
   git rebase origin/main
   ```

2. Check the current npm state.

   ```bash
   npm view bb-app version dist-tags versions --json
   ```

3. Bump the lockstep release versions.

   For the normal stable loop:

   ```bash
   node scripts/bump-version.mjs --patch
   ```

   When promoting from a prerelease to the first stable version, set the exact
   version instead:

   ```bash
   node scripts/bump-version.mjs 0.0.1
   ```

   This updates `packages/bb-app/package.json` and
   `apps/desktop/package.json`. Do not run `npm version` directly in
   `packages/bb-app`; CI enforces these versions in lockstep.

4. Update the release notes. Add the new version's section to the repo-root
   `CHANGELOG.md`, and add its entry (ship date and headline) to
   `RELEASE_META` in the repo-root `changelog-metadata.ts`. The marketing site's
   `/changelog` page and the optional in-app Updates preview consume these
   shared files, so both changes must land before the release is published —
   redeploy `@bb/web` after the release commit lands so the site shows the new
   version.

5. Make any release documentation updates requested by the user.

6. Run validation.

   ```bash
   node .github/workflows/check-version-lockstep.mjs
   pnpm exec turbo run typecheck test --filter=@bb/app --filter=@bb/config --filter=@bb/server --filter=bb-app
   pnpm exec turbo run smoke:tarball --filter=bb-app --force
   git diff --check
   ```

7. Commit the release change.

   ```bash
   git add README.md docs packages/bb-app/package.json packages/bb-app/README.md apps/desktop/package.json
   git commit -m "Prepare bb-app <version>"
   ```

   Adjust the `git add` paths to exactly the files changed.

## Land On Main

The publish workflow must run from `main`, so the release commit must be on
`main` before publishing.

Preferred paths:

- If the agent has permission to update local `main`, fast-forward or merge the
  release commit into local `main`, then push if the user has authorized pushes.
- If the agent cannot update/push `main`, stop and report the release commit SHA
  and validation. Ask the user to merge it before publishing.

Do not publish from a feature branch just because validation passed.

## Trigger The Publish Workflow

After the release commit is on pushed `main`, trigger the workflow:

```bash
gh workflow run publish-bb-app.yml \
  --ref main \
  -f npm_tag=latest \
  -f allow_prerelease_latest=false \
  -f dry_run=false
```

This run publishes the release and then republishes the nightly channel from the
same commit, so the run also builds the `bb Nightly` desktop app. Expect the run
to take longer than the npm publish alone.

Use prerelease dist-tags such as `alpha` only when the user explicitly asks for
a separate prerelease channel. npm Trusted Publishing authenticates
`npm publish`, not post-publish tag edits, so the OIDC-only workflow can set one
tag per release.

If the `npm-release` GitHub environment requires approval, tell the user the
workflow is waiting for approval. The agent may monitor the run, but the human
approval is the release control point.

## Verify The Release

After the workflow succeeds, verify the chosen dist-tag and the registry tag
map:

```bash
npm_tag=latest
npm view "bb-app@$npm_tag" version
npm view bb-app version dist-tags versions --json
npx --yes "bb-app@$npm_tag" --help
```

Report:

- version published
- Git commit published
- npm `latest` and any non-latest dist-tags
- workflow run URL
- validation commands and result
- any follow-up risks

## Publish The Desktop App

The npm publish does not build or publish the desktop app. The desktop release
is a separate workflow. It builds the signed and notarized macOS app and the
Linux x64 AppImage in parallel jobs, then one publish job creates the immutable
`desktop-v<version>` GitHub release and moves the `desktop-latest` release with
both auto-update feeds: `desktop-version.json` for macOS and
`desktop-version-linux.json` for Linux. Run it from the same pushed `main`
commit, at the same version, for every stable release.

A failure in either platform job stops the publish job, so no release can ship
one platform's binaries against the other platform's stale feed.

```bash
gh workflow run build-desktop.yml \
  --ref main \
  -f publish=true \
  -f release_channel=stable
```

- `release_channel=stable` is required to update `desktop-latest`; `qa` builds
  artifacts without moving the public feed.
- Only a non-prerelease version is published. The workflow refuses to publish a
  prerelease (`X.Y.Z-...`) to `desktop-latest`.
- macOS signing/notarization secrets must be configured, or the workflow
  withholds the unsigned `.dmg`/`.zip` and publishes both version feeds plus the
  Linux AppImage. Linux has no notarization equivalent, so it never waits on the
  Apple secrets.
- The `desktop-v<version>` release is immutable: if it already exists the
  workflow fails. Bump to a new version rather than re-running the same one.
- The immutable `desktop-v<version>` release owns GitHub's repository-wide
  **Latest** designation. The moving `desktop-latest` release remains opted out;
  it exists only to provide stable download and auto-update URLs.

If the `npm-release`-style environment or branch protection gates the run, tell
the user and let the human approval be the release control point.

## Verify The Desktop Release

After the desktop workflow succeeds, confirm the published version and feed:

```bash
gh release view desktop-latest --json tagName,assets \
  -q '{tag:.tagName,assets:[.assets[].name]}'
gh release list --limit 10 --json tagName,isLatest \
  -q '.[] | select(.isLatest) | .tagName'
curl -fsSL https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version.json
```

Confirm `desktop-version.json` reports the released version and that the
`desktop-v<version>` release exists with the expected `.dmg`/`.zip` assets and
is the release reported as GitHub's **Latest**.

Add to the report from "Verify The Release":

- desktop version published and whether signed binaries were uploaded
- desktop workflow run URL

## Publishing The Plugin SDK

`@get-bb/plugin-sdk` rides the same release train as `bb-app`. The
`publish-plugin-sdk` job in `publish-bb-app.yml` runs on the same nightly cron
and `workflow_dispatch` triggers, but depends on nothing and is depended on by
nothing: a failure there cannot hold back the npm or desktop release.

The SDK version is **settled in the repo before any build**, never computed at
publish time. It lives in `packages/domain/src/plugin-sdk-version.ts`
(`PLUGIN_SDK_VERSION`) and is mirrored in `packages/plugin-sdk/package.json`.
Both must be bumped together, so move them with the script rather than by hand:

```bash
node scripts/bump-plugin-sdk.mjs --patch   # or --minor, --major, or an explicit version
```

The script writes both files atomically and refuses to run when they already
disagree. The job is publish-if-missing: it reads the local
version, asks npm whether that exact version exists, and either logs
"already published, skipping" or publishes. Every run is therefore idempotent —
most runs publish nothing.

Because a published version is never republished, an already-released version's
published content must never change underneath it. `check-npm-version-guard.mjs`
enforces that on every PR from the `checks` job in `ci.yml`:

| Registry state                              | Result                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Package or version absent (404)             | Pass — the publish job will ship this version.                       |
| Version published, packed package identical | Pass.                                                                |
| Version published, packed package differs   | Fail — run `node scripts/bump-plugin-sdk.mjs --patch`.               |
| Registry unreachable, or local pack failed  | Exit 2; CI logs a warning and continues (infrastructure, not a bug). |

The comparison covers the whole package, not just the declarations: a
runtime-only change (different `dist/` output, an edited exports entry, a
widened peer range) leaves `bundled-types/` identical, and publish-if-missing
would then never ship it. The guard builds the SDK through turbo, runs
`npm pack` to get exactly what publish would upload, and diffs that against the
published tarball for the current version:

- every packed file — `bundled-types/*`, `dist/*`, `README.md` — normalizing
  line endings and end-of-file whitespace
- the manifest fields consumers resolve against: `exports`, `files`, `main`,
  `peerDependencies`, `peerDependenciesMeta`, `publishConfig`, `repository`,
  `types` (compared by value, so key order is not drift)

Comparing `dist/` content is safe because the esbuild bundles are reproducible:
they embed no timestamps, paths, or hashes, so repeated builds of the same
commit are byte-identical. Run the guard locally the same way CI does:

```bash
node packages/plugin-sdk/scripts/check-npm-version-guard.mjs
```

### One-Time Bootstrap

npm trusted publishing cannot create a package that does not exist yet, so the
first release is manual:

1. Publish `@get-bb/plugin-sdk` once by hand from `packages/plugin-sdk` with
   normal npm authentication (`npm publish`; `publishConfig.access` is already
   `public`).
2. On GitHub, restrict the `npm-release` environment to `main` (Settings →
   Environments → `npm-release` → deployment branches → selected branches,
   `main` only). `workflow_dispatch` accepts any branch, and the environment is
   what npm's trusted publisher trusts: without a branch policy, a run from any
   branch could request the same OIDC identity. The in-file "Require main
   branch" step is a convenience check that a workflow edit could remove; the
   environment policy is the control that holds.
3. On npmjs.com, add a trusted publisher for the package pointing at this
   repository, the workflow file `.github/workflows/publish-bb-app.yml`, and the
   `npm-release` environment — the same values `bb-app` uses.

Until all three steps are done, the `publish-plugin-sdk` job fails at
`npm publish`. That failure is expected and isolated; the bb-app and desktop
jobs are unaffected.

## Failure Handling

- If the version already exists on npm, stop. Bump to the next version in a new
  commit and rerun validation.
- If validation fails, stop. Fix the issue before triggering the workflow.
- If Trusted Publishing fails, check the npm trusted publisher config: owner,
  repo, workflow filename, and environment must exactly match the workflow.
- If the workflow succeeds but tags are stale, wait and re-query before changing
  anything manually.
- If local emergency publish is unavoidable, use `npm publish --tag <tag>` from
  `packages/bb-app` only after explicit user approval and record the OTP-based
  path as a deviation.
- If a legacy prerelease tag should stop resolving to an old build, remove it
  with `npm dist-tag rm bb-app <tag>` using explicit user approval and normal
  npm authentication.
- If the desktop workflow fails because `desktop-v<version>` already exists, do
  not delete the immutable release. Bump to the next version, re-run the npm
  publish, then re-run the desktop workflow.
- If the desktop workflow withholds the macOS binaries (feeds and the Linux
  AppImage still publish), the macOS signing secrets are missing or incomplete.
  Fix the secrets and re-run; do not hand-upload unsigned macOS binaries to
  `desktop-latest`.
