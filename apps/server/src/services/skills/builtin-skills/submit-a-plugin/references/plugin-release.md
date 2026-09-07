# Plugin validation and release

Read this file before you validate or release the submitted plugin.

## Validate the plugin

1. Read package.json.
2. Inspect name, version, engines, and bb.
3. Confirm that bb.name, bb.description, and bb.branding describe the plugin.
4. Calculate the plugin ID with scripts/derive-plugin-id.mjs.
5. Confirm that the ID matches the planned entry.
6. Inspect the Git remote, visibility, worktree state, and release state.
7. For a multi-plugin repository, inspect .bb/plugins.json and find the plugin
   subdirectory.
8. Run focused tests, type checks, and builds with the repository package
   manager.
9. Run bb plugin build from the plugin directory.

The ID algorithm removes the npm scope and a lowercase bb-plugin- prefix. It
converts the remaining value to lowercase, replaces other characters with
hyphens, trims edge hyphens, and rejects an empty result.

For example, @acme/bb-plugin-notes supplies notes.

Do not release a plugin with failed checks or uncommitted release changes.

## Get release approval

Prepare every read-only check and local file before approval. Then show the
user:

- The authenticated account.
- The repository and remote URL.
- The release commit.
- The package name and version.
- The Git tag or npm source.
- Every command that will change remote state.

Get approval for these exact values. Approval for another release does not
apply. Do not push a commit or tag, and do not run npm publish, before approval.

## Select one source

Prefer a Git semantic-version range for a public Git repository. Use npm when
the author already distributes a complete npm package. Use an exact Git ref only
when the author wants a fixed release.

### Git semantic-version release

Use vX.Y.Z for one root plugin. Use <plugin>/vX.Y.Z when a repository releases
several plugins independently. Set tagPrefix to the text before vX.Y.Z for the
second form.

Create a new immutable tag for every release. After approval, create the tag
after the release commit exists:

```sh
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin HEAD
git push origin v1.2.3
```

For a plugin-specific release:

```sh
git tag -a notes/v1.2.3 -m "Release notes v1.2.3"
git push origin HEAD
git push origin notes/v1.2.3
```

Verify the public tag:

```sh
git ls-remote --tags https://github.com/OWNER/REPOSITORY.git
```

Use this source shape:

```json
{
  "git": {
    "url": "https://github.com/OWNER/REPOSITORY.git",
    "range": "^1.2.3"
  }
}
```

Add subdir for a plugin below the repository root. Add tagPrefix for
plugin-specific tags.

### Exact Git release

Use an immutable tag or full commit hash:

```json
{
  "git": {
    "url": "https://github.com/OWNER/REPOSITORY.git",
    "ref": "v1.2.3"
  }
}
```

An exact ref prevents automatic selection of later compatible releases.

### npm release

An npm source must refer to a published package. The package must contain the
prebuilt BB files. A Git install can build source during installation.

1. Run bb plugin build.
2. Run tests and type checks.
3. Run npm pack --dry-run --ignore-scripts.
4. Confirm that the package contains its manifest and required dist files.
5. Confirm the account with npm whoami.
6. After approval, run npm publish --ignore-scripts.
7. Add --access public for a new public scoped package.
8. Confirm publication with npm view PACKAGE@VERSION name version.

Do not republish an existing version. Increase the version and rebuild.

Use this source shape:

```json
{
  "npm": {
    "package": "@acme/bb-plugin-notes",
    "range": "^1.2.3"
  }
}
```

Use tag instead of range only when the author wants to track an npm
distribution tag.
