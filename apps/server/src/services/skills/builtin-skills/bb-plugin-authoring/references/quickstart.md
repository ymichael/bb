# Plugin quickstart

## Quickstart

```
bb plugin new hello            # scaffolds ./bb-plugin-hello: a todo list with a sidebar page, `bb hello` CLI, and a skill
cd bb-plugin-hello
bb plugin install .            # registers the directory in place (--yes to skip the prompt)
bb plugin dev                  # rebuild app/host bundles + reload on every save
```

The manifest is `package.json`. This block is illustrative. The scaffold adds
the current engine values and the entries for its generated surfaces.

```json
{
  "name": "bb-plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "bb": {
    "name": "Hello",
    "description": "A friendly example plugin.",
    "branding": { "icon": "Zap" },
    "server": "./server.ts",
    "app": "./app.tsx",
    "skills": ["skills"]
  }
}
```

- `bb.server` (required) — backend entry. Path installs load it as
  TypeScript directly (no build step); `bb plugin build` also emits a
  `dist/server.js` + `server.js.map` + `server.meta.json`. The server bundle
  externalizes the SDK and `better-sqlite3`; use `bb.storage.database()` for
  plugin-owned SQLite. `bb.app` (optional) — frontend entry compiled by
  `bb plugin build` into minified `dist/app.js` + `app.css` + `app.meta.json`
  (`bb plugin dev` keeps them readable); path and git installs build it
  automatically at install time. Git installs also
  run `npm install --omit=dev --omit=optional` first (so a git plugin may use third-party
  packages) and keep node_modules, since bundling cannot inline data files read
  at runtime. Runtime imports that bb does not shim belong in `dependencies`.
  Type-only imports can stay in `devDependencies`. A build-required package left in
  `devDependencies` makes the plugin uninstallable from git, and unbuildable
  after any install that omits dev deps — including the packaged CLI's own,
  which runs npm under `NODE_ENV=production`. `devDependencies` is for types
  and tooling only — including every package bb shims at runtime (sonner,
  vaul, the portal radix families, @pierre/diffs, clsx, tailwind-merge,
  class-variance-authority): the build never bundles them, but `tsc` still
  resolves their declarations through node_modules, so each one you import
  needs a `devDependencies` entry at the host's version (`bb plugin new`
  writes all of them; `bb plugin types` repins them). Never put one in
  `dependencies` — that bundles a second copy beside the host's.
- `bb.host` (optional, singular) — full-trust Node 22 ESM entry bundled into
  `dist/host.js` + source map + `host.meta.json`. Its owning server entry calls
  it through typed host RPC. The daemon downloads it lazily, verifies its
  digest, and reuses one worker per plugin generation. Pure JavaScript
  dependencies are bundled; host code may use Node APIs such as
  `child_process`, `fs`, and `fetch`.
  Installing or updating a git plugin needs `npm` on PATH; checking for
  updates does not, because a check reads the manifest and never builds. Path
  installs build from dependencies you have already installed.
- Git installs use npm, then build declared app, server, and host source. They
  validate server metadata and host metadata when a host exists. An npm plugin
  with `bb.app` must publish `dist/app.js` and `dist/app.meta.json`. An npm
  plugin with `bb.host` must publish its host bundle and metadata. Users of
  prebuilt artifacts need no npm, but managed Git and npm installs need npm on
  `PATH`.
- Building yourself (CI, or verifying a build without a running bb): add
  `bb-app` to `devDependencies` and set `"build": "bb plugin build"`.
  `bb plugin build` needs no running server, but the manifest still needs
  `bb.server`. Depending on `bb-app@X` builds
  against exactly that release's shim configuration. bb downloads its build
  toolchain on first use, so cache `<dataDir>/plugins/toolchain-*` in CI.
- `bb.skills` (optional) — relocates the auto-imported skills directories
  (default `skills/`; `[]` opts out). Every `skills/<name>/SKILL.md` is
  injected into agent threads as the plugin skills tier.
- `bb.themes` (optional) — contributes palettes to Settings → Appearance and
  `bb theme list`. Each entry is
  `{ id, name, description?, css: "./themes/name.css", codeTheme? }`;
  `codeTheme` is `{ dark?, light? }` where each side is a bundled Shiki /
  Pierre name or a plugin-relative VS Code theme `.json` file. bb namespaces
  its selectable id as `plugin:<plugin-id>:<id>`. Only loaded plugins
  contribute.
- `bb.name` and `bb.description` (required) — non-empty human-facing plugin
  identity. The top-level package `name` remains the package identity and
  source of the plugin id.
- `bb.branding` (required) — declare `bb.branding.icon` as either the plugin's
  canonical BB icon name, such as `Zap`, or a plugin-relative compact SVG path
  such as `./assets/icon.svg`. A namespaced `"<pluginId>/<name>"` glyph is
  refused here: that form is how tool presentations and provider declarations
  name a declared icon, and the plugin's own mark points at its file directly.
  BB validates path-shaped SVGs (well-formed XML with an `<svg>` root, no
  doctype or processing instruction), hash-serves them, then renders them
  as CSS masks so their shape inherits the surrounding text color; SVG
  colors are ignored.
  BB reuses this icon on roomy surfaces when no logo override is declared.
  Add `logo.light` only for
  intentionally different rich/full-size identity artwork; optional
  `logo.dark` is preferred in dark mode. Logo paths are explicit
  plugin-relative `.svg`, `.png`, or `.webp` files: nulls, empty strings,
  missing/escaping files, unsupported extensions, and a dark logo without a
  light logo fail the manifest. `bb plugin build` refuses an SVG logo that
  carries a script vector (a `script`, `handler` or `listener` element, an
  `on*` attribute, or a `javascript:` href). Manifest, build, and load checks
  reject the invalid paths and SVGs described above. Every SVG BB serves
  carries `nosniff` and a `default-src 'none'` CSP. There is
  no root logo auto-detection. Logo-only
  manifests remain supported for compatibility, so at least an icon or light
  logo is required. BB uses a declared logo where space permits, such as roomy
  Settings rows and cards.
  Compact sidebar, menu, action, mention, and panel-title surfaces prefer the
  plugin-owned icon asset, then a named manifest icon, then a contribution's
  local `icon` hint, then Zap. Branding changes are picked up on
  `bb plugin reload`. Named inline icons use `currentColor`; compact SVG assets
  should contain only the intended transparent glyph shape. Do not duplicate
  the same artwork across `icon` and `logo`; reserve logos for intentionally
  different branded artwork and provide a dark variant when needed.
- `bb.branding.experimental_icons` (optional) — the plugin's own icon
  vocabulary for timeline rows and provider marks: a map of declared name →
  plugin-relative SVG, such as `{ "receipt": "./icons/receipt.svg" }`. Names
  start with a lowercase letter or digit and then use lowercase letters,
  digits, or `-` (≤ 48 characters, ≤ 64 entries);
  each file is a `.svg` inside the plugin directory, at most 32 KiB, and
  must pass a reject-only validator: no doctype or processing instruction;
  no `script`, `handler`, `listener`, `iframe`, `foreignObject`, `image`,
  `video`, `audio`, `a` or `style` element; no element outside the SVG
  namespace; no `on*` attribute; no `href`/`xlink:href` that is not a
  same-document `#` reference; no backslash (CSS escape) in any attribute
  value; no `url()`, `src()`, `image()` or `image-set()` in any attribute
  value unless it targets a same-document `#` reference; no SMIL
  `attributeName` naming an `on*` handler or an `href`; no `xml:base`. Any
  violation fails the plugin load with a message naming the icon.
  Reference an entry by its namespaced glyph `"<pluginId>/<name>"` — in a
  bridge's `presentation.icon`,
  in `bb.agents.registerTool`'s `presentation.icon`, or as a
  `bb.providers.register` `icon`. BB serves each file hashed from
  `/api/v1/plugins/<id>/assets/icons/<name>.svg`, lists them on the
  installed-plugin inventory as `icons`, and draws them as `currentColor`
  masks (web) or tinted SVG views (mobile), so ship monochrome shapes. A
  glyph naming another plugin or an undeclared name is refused at
  registration and, for rows, at ingest (the row persists as
  `provider/unhandled`); a `server: "bb"` tool row is checked against the
  plugin that registered the tool, not the thread's provider plugin, so a
  tool's declared icon survives on any provider's thread. Rows are never
  rewritten when the map changes: a
  row whose name is no longer declared, or whose plugin is uninstalled,
  draws the per-kind fallback glyph.
- `engines.bb` — optional compatibility string checked during runtime and
  update selection against the BB app version.
- `engines.bbPluginSdk` — optional SDK compatibility string. The scaffold uses
  the repository SDK version. BB validates this range before use. Absent means
  a legacy manifest. Managed (`git:`/`npm:`) installs **refuse** a plugin that needs a
  newer SDK than the host provides, or one pinned to a different major; path
  installs surface it as `incompatible` at load.
  Compatible updates (`bb plugin outdated` / `bb plugin update`) only select
  candidates that satisfy these ranges; newer incompatible releases are
  reported as blocked rather than applied. Dev builds (bb `0.0.0`) skip
  enforcing `engines.bb` and annotate that on check results.
- **Manual updates:** `bb plugin outdated` checks tracking sources and
  `bb plugin update` applies compatible candidates (reinstall of an already
  installed managed plugin is refused). A failed activation **rolls back** to
  the previous state snapshot and records the failure for the user. Keep
  `engines.*` honest and ship load-safe factories so an update never strands
  users.
- `bb plugin build` stamps authoritative metadata into every declared
  artifact's `dist/*.meta.json`: `sdkMajor`, `sdkVersion`,
  `artifactFormatVersion` (currently `1`), `pluginId`, `pluginVersion`, and
  `builtWith: { bbVersion, pluginSdkVersion }`. Managed installs reject
  artifacts whose `pluginId`/`pluginVersion` disagree with the package
  manifest, or whose SDK major does not match the host.
- Default to `bb-plugin-hello` for the package name. Scoped names such as
  `@acme/bb-plugin-hello` are also supported. The plugin id is the final
  package-name component minus the `bb-plugin-` prefix. BB lowercases it,
  replaces non-alphanumeric runs with `-`, and trims separators. An empty
  result is invalid. Every bundled plugin id is reserved for its bundled
  source. The id namespaces routes, storage, settings, and CLI commands.

Backend API imports normally stay type-only. The root runtime exports are
`defineRpcContract`, `experimental_defineHostEntry`, and the numeric
`PLUGIN_CLI_OUTPUT_MAX_BYTES` ceiling:
`import { defineRpcContract, type BbPluginApi } from
"@get-bb/plugin-sdk"`. Validator imports such as Zod are normal plugin runtime
dependencies (and are bundled by `bb plugin build`).

On-disk state per plugin: `<dataDir>/plugins/<id>/data.db` (its SQLite),
`secrets/` (secret settings + HTTP token), `logs/plugin.log` (JSONL,
rotated at 5MB). Healthy or degraded plugins receive effective setting changes
through `onChange`. A plugin in `needs-configuration` retries automatically.
Use `bb plugin reload <id>` only when the change or plugin requires it.
