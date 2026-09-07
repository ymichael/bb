# Exact API lookup and distribution

## Looking up the exact API

This skill is a guide, not the contract. For an exact signature or a symbol it
does not cover:

1. **`bb plugin types`**, run in the plugin directory (or given its path),
   syncs that plugin's SDK surface to the running bb — no server needed. For a
   plugin that depends on the npm package it repins the exact
   `@get-bb/plugin-sdk` devDependency to this bb's SDK version and brings the
   runtime-shimmed packages' type-only devDependencies (sonner, vaul, the
   portal radix families, ...) to the versions this bb ships — adding any an
   app plugin is missing and moving one out of `dependencies` (run
   `npm install` after); for an older plugin that still vendors `types/*.d.ts`
   it rewrites those declarations. Either way a cloned or older plugin can be
   thousands of lines behind. `--check` compares declared files and package
   pins without writing. Build and dev refresh legacy declarations and warn
   about stale package pins; they do not repin installed packages or lockfiles.
2. **Read the bundled declarations** — the authoritative surface, ~13,000
   lines of readable declarations with doc comments:
   - plugins scaffolded by a current bb depend on the npm package, so after
     `npm install` read
     `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`
     (`bb-plugin-sdk-app.d.ts` for frontend symbols and
     `bb-plugin-sdk-host.d.ts` for the host entry);
   - plugins scaffolded before that still carry the root declaration in
     `types/bb-plugin-sdk.d.ts` (plus `types/bb-plugin-sdk-app.d.ts` for an
     app), which the plugin's `tsconfig.json` maps
     `@get-bb/plugin-sdk` onto. Read whichever the plugin in front of you has.
     That layout still works for existing entries, but migrate before adding
     `bb.host` so the `/host` and `/testing/host` subpaths are present; `bb
plugin migrate` converts such a plugin to the npm package (it prints the plan
     and asks first, and needs `--yes` when stdin is not a terminal). Never
     migrate a plugin the user did not ask you to migrate.
3. **`git clone --depth 1 https://github.com/get-bb/bb`** for host behavior or
   a reference implementation: `packages/plugin-sdk/src/`,
   `apps/server/src/services/plugins/`, `plugins/`.

Never answer an API question from a generated bundle. The app bundle is
minified. Server and host bundles have source maps, but the declarations and
source files remain the contract.

## Distributing a plugin

Users can install third-party plugins directly from a local path, npm package,
or Git repository:

```sh
bb plugin install ./bb-plugin-notes
bb plugin install npm:bb-plugin-notes@^1.0.0
bb plugin install https://github.com/acme/bb-plugin-notes
bb plugin install git:https://github.com/acme/bb-plugin-notes.git@main
bb plugin install git:https://github.com/acme/bb-plugin-notes.git@^1.2.0
```

A bare HTTP(S) repository URL tracks its default branch. Use the `git:` form
with an explicit branch, tag, or commit when that tracking intent matters.
Install and update run third-party code with full trust. Interactive commands
show the resolved source and ask for confirmation. Pass `--yes` only after the
user confirms that exact source and version.

### Releasing a git plugin with semver tags

Tag each release `vX.Y.Z` and users can install a range instead of a ref:
bb reads the repository's tags, installs the highest release the range allows,
and `bb plugin update` moves them to later releases in the same range.
Prereleases stay out unless the range names one. Give each plugin of a
multi-plugin repository its own tag prefix — `notes/v1.2.3` — and users add
`--tag-prefix notes/`.

bb records the tag it installed together with the commit that tag pointed at,
and refuses the plugin if that tag is ever moved to another commit. Publish a
fix as a new version rather than retagging.

### Several plugins in one repository

Keep each plugin in its own directory with its own `package.json`, then index
the directories in a `.bb/plugins.json` collection manifest at the repository
root:

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "plugins": [
    { "name": "notes", "source": "./plugins/notes" },
    { "name": "status", "source": "./plugins/status" }
  ]
}
```

Each `source` is a repository-relative directory that starts with `./`. The
file is an index only — it never overrides a plugin's identity, branding,
entry points, or engine ranges. Users install one plugin at a time:

```sh
bb plugin install git:https://github.com/acme/bb-plugins.git@main --plugin notes
bb plugin install git:https://github.com/acme/bb-plugins.git@main --subdirectory plugins/notes
bb plugin install path:. --plugin notes
```

`--subdirectory` works without a collection manifest; `--plugin` resolves an
entry name from it. If the repository is not itself a plugin, an install with
neither flag fails and lists the entry names.

### Publishing your own marketplace

A marketplace is one `marketplace.json` file. It lists plugins with their
store branding and their npm or git source; it never hosts plugin code, and
installing an entry runs the same install pipeline a direct install runs.

```json
{
  "$schema": "https://getbb.app/schemas/marketplace.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "displayName": "Acme Plugins",
  "description": "Plugins the Acme team maintains.",
  "plugins": [
    {
      "id": "notes",
      "displayName": "Notes",
      "description": "Keep notes beside a thread.",
      "icon": { "url": "./icons/notes.svg" },
      "tags": ["notes", "interface"],
      "author": { "name": "Acme", "github": "acme", "url": "https://acme.dev" },
      "source": {
        "git": {
          "url": "https://github.com/acme/bb-plugins.git",
          "subdir": "plugins/notes",
          "range": "^1.0.0",
          "tagPrefix": "notes/"
        }
      }
    }
  ]
}
```

The schema is strict: an unknown field rejects the whole document, and the
last catalog bb validated keeps serving. `name` is the marketplace's identity
and must be unique on the user's machine; `bb-community` is reserved.
Compatibility belongs in each plugin package manifest. Icons are `.svg`,
`.png`, or `.webp`, either an absolute https URL or a path relative to the
manifest — bb fetches and validates them server-side and serves them from its
own origin.

Host it three ways, and users add whichever fits:

```sh
bb marketplace add https://plugins.acme.dev/marketplace.json
bb marketplace add git:github.com/acme/bb-marketplace@main
bb marketplace add path:/work/acme-marketplace
bb marketplace list
bb marketplace refresh acme-plugins
bb marketplace remove acme-plugins
```

`list` shows configured catalogs. `refresh` updates discovery metadata and
icons without installing code. `remove` forgets the catalog, while installed
plugins continue as direct installs.

An https marketplace is re-read with a conditional request; a git one is
cloned into a throwaway checkout each refresh, with `marketplace.json` and any
relative icons read from the repository root. Prefer git tag ranges over
pinned refs so a release reaches users without a catalog change. Before
installing from a marketplace that is not `bb-community`, bb resolves and shows
the true source — including the exact release tag and commit a range lands
on — so keep your listed URL, subdirectory, and range honest.

BB's own official plugins are separate: inclusion in the `bb-community`
marketplace is a BB release decision, not part of the plugin authoring
workflow, and the bundled official plugins ship inside the app itself and
install from that local copy with no network fetch.

### Store listing text

A store listing has two text fields. The short `bb.description` in
package.json is the one-sentence hook. It appears on every browse card and as
the lead paragraph on the detail page. Keep it under about 140 characters.
State the outcome the user gets.

`PLUGIN_OVERVIEW.md` beside package.json holds the long-form description. The
detail page shows it in an Overview section under the lead paragraph, in the
app and on the public getbb.app marketplace. `bb plugin new` scaffolds one, the
BB Community marketplace requires one, and a plugin that is only installed from
a local path or a private source still reads better with one.

The file is the same claim as `bb.description` at length: the same outcome, the
same surfaces, no capability the short text does not imply. Treat the two as
one text in two lengths. Whenever you change `bb.description`, or add or remove
a surface, update this file in the same change so the lead paragraph and the
Overview section never disagree.

The `submit-a-plugin` skill copies the file into the marketplace repository as
`overview/<plugin-id>.md` and references it from the entry with
`"overview": "./overview/<plugin-id>.md"`. A bundled BB plugin uses the same
file, and the bb-official generator folds it into the built catalog.

Follow these rules. Marketplace CI rejects a file that breaks one.

- UTF-8 text with a maximum of 4000 characters. Aim for 700 to 1800.
- Headings, paragraphs, emphasis, strong text, strikethrough, inline code,
  code blocks, blockquotes, lists, thematic breaks, and links only.
- No raw HTML, images, tables, footnotes, or task lists. Put images in
  screenshots instead.
- Each link is an absolute https URL. The store opens it in the browser.
- Use `##` headings for sections. The page renders each heading as a small
  uppercase label. Do not start with a `#` title, and do not repeat the short
  description as the first sentence.

Lead with the outcome, then sections such as What you get, How it works, and
Requirements. Name every cost: an external service, an account, a separate
install, or a limited operating system. Name agent surfaces with their exact
tool or `bb` command names in inline code.
