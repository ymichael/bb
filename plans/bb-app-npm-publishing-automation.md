# bb-app npm Publishing Automation

## Current Status

`bb-app` is published manually from `packages/bb-app` using an alpha dist-tag. The
local safety checks already exist:

- `pnpm exec turbo run typecheck test --filter=bb-app`
- `pnpm exec turbo run smoke:tarball --filter=bb-app --force`
- `npm publish --dry-run --tag alpha`
- `npm publish --tag alpha`

This plan keeps the first automated version intentionally conservative:
publishing remains a human-triggered release action, but CI owns the exact
build, smoke test, and publish steps.

## Recommended Shape

Use a GitHub Actions workflow with `workflow_dispatch` and npm Trusted
Publishing/OIDC.

Why:

- No long-lived npm write token is stored in GitHub.
- The workflow can require a protected GitHub environment approval before
  publishing.
- The version in `packages/bb-app/package.json` remains the release source of
  truth.
- Alpha releases can keep moving quickly without teaching every contributor a
  manual npm publishing sequence.

Avoid fully automatic publish-on-merge for now. This package includes bundled app
and daemon artifacts, so a mistaken publish has a larger blast radius than a
typical small library. Manual dispatch is the right default until the release
path is boring.

## Phase 1: Add Manual Publish Workflow

Create `.github/workflows/publish-bb-app.yml`.

Workflow inputs:

- `npm_tag`: choice of `alpha`, `beta`, or `latest`; default `alpha`.
- Optional `dry_run`: boolean; default `true` for first rollout, flip to
  `false` once the trusted publisher setup has been verified.

Workflow permissions:

- `contents: read`
- `id-token: write`

Job setup:

- Use a GitHub-hosted runner.
- Use Node 24 so the runner satisfies npm Trusted Publishing requirements.
- Enable pnpm through Corepack using the root `packageManager` value.
- Run `pnpm install --frozen-lockfile`.
- Run the same Turbo checks we use locally.

Publish step:

```sh
cd packages/bb-app
npm publish --tag "$NPM_TAG"
```

Keep `--provenance` out if Trusted Publishing is active, because npm Trusted
Publishing automatically emits provenance. Use `--provenance` only if we fall
back to token-based publishing.

Exit criteria:

- `.github/workflows/publish-bb-app.yml` exists and is manually runnable.
- The workflow publishes only `packages/bb-app`, not the monorepo root.
- The workflow requires the existing `bb-app` checks before publishing.
- The workflow supports alpha publishes without touching the `latest` dist-tag.

Validation:

```sh
pnpm exec turbo run typecheck test --filter=bb-app
pnpm exec turbo run smoke:tarball --filter=bb-app --force
```

After merging the workflow, run one GitHub Actions dry run and confirm it reaches
the publish command without making registry changes.

## Phase 2: Configure npm Trusted Publisher

In npm package settings for `bb-app`, add a trusted publisher:

- Provider: GitHub Actions
- Owner/repo: the GitHub repository that owns this codebase
- Workflow filename: `publish-bb-app.yml`
- Environment: the protected release environment name, if one is used

Exit criteria:

- npm accepts publishes from the workflow without `NPM_TOKEN`.
- The workflow logs show OIDC/trusted-publishing auth rather than token auth.
- No npm write token is required in repository or organization secrets.

Validation:

Run the workflow against the next prerelease version, for example
`0.0.1-alpha.2`, with `npm_tag=alpha`. Then verify:

```sh
npm view bb-app@alpha version
npm view bb-app dist-tags --json
npx --yes bb-app@alpha --help
```

## Phase 3: Add Release Guardrails

Add guardrails before the publish step:

- Read `packages/bb-app/package.json` and fail if the version already exists on
  npm.
- Fail if `npm_tag=latest` is used with a prerelease version.
- Fail if `npm_tag=alpha` or `npm_tag=beta` is used with a stable version.
- Print the package contents using `npm pack --dry-run` or the existing tarball
  smoke output.

Exit criteria:

- A duplicate version fails before `npm publish`.
- A prerelease cannot accidentally move `latest`.
- A stable release cannot accidentally publish under `alpha`.
- The workflow output includes enough package-file detail to review what is
  going out.

Validation:

Trigger dry-run workflows for these cases:

- Existing version: expected failure.
- `0.0.1-alpha.N` with `alpha`: expected success.
- `0.0.1-alpha.N` with `latest`: expected failure.
- `0.0.1` with `latest`: expected success once we are ready for stable.

## Phase 4: Decide Version Bump Workflow

Keep version bumps manual until alpha publishing stabilizes. The normal alpha
loop is:

```sh
cd packages/bb-app
npm version prerelease --preid alpha --no-git-tag-version
```

Then commit the version change, merge it, and run the publish workflow.

Later, consider adding one of these:

- A `pnpm release:bb-app -- alpha` script that bumps, validates, and prints the
  workflow command to run.
- Changesets if multiple packages start publishing together.
- semantic-release only if commit-message-driven releases become a team norm.

Exit criteria:

- The chosen version-bump path is documented in the package README or release
  docs.
- The release command does not publish locally; publishing stays in CI.
- The command cannot bump the root package by mistake.

## References

- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- npm publish CLI: https://docs.npmjs.com/cli/v11/commands/npm-publish/
- npm dist-tags: https://docs.npmjs.com/adding-dist-tags-to-packages/
- GitHub Actions npm publishing: https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages
