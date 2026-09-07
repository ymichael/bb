# Skills, plugins, marketplaces, and plugin development

Status: **2026-09-05: 11 passed, 2 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

A trusted disposable plugin/skill fixture and isolated server. Registry/network checks need connectivity. Open Extensions and Settings → Installed plugins.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/app/src/views/ToolsView.tsx`
- `apps/cli/src/commands/skill.ts`
- `apps/cli/src/commands/plugin.ts`
- `apps/cli/src/commands/marketplace.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Skill discovery and precedence | Place distinct synthetic skills in user, project, and provider-native locations; inspect skill list/show/files with project/environment scope. | Names, origins, editability, and resolved file contents match the selected workspace. |
| Skill editing and deletion | Update an editable fixture using its revision, then try a stale revision and deletion; attempt editing a read-only bundled entry. | Version conflict/read-only boundaries are respected; only the fixture is deleted. |
| Skill registry | Search skills.sh, open registry detail/file preview, install a trusted fixture, and inspect it locally. | Canonical source and installed contents agree; unavailable registry and invalid IDs show errors. |
| CLI skills installation | Inspect cli-skills-status on a disposable host; install and repeat. | Correct provider locations are updated idempotently; unavailable hosts remain explicit. |
| Plugin browsing and details | Search plugin catalogs, inspect installed/source/history/details, and follow configuration links. | Metadata, compatibility, installed version, and enable state agree. |
| Plugin installation and permissions | Install a trusted local fixture and a trusted catalog fixture; inspect declared capabilities and errors for incompatible manifests. | Only valid compatible plugin code becomes active; errors identify the failed stage. |
| Enable, disable, reload, remove | Toggle the fixture, reload it, then remove it; inspect plugin list and UI contributions each time. | Tools, panels, hooks, and commands appear/disappear with actual plugin lifecycle; no stale active contribution. |
| Plugin configuration and logs | Set a fixture setting through plugin config and UI, trigger a harmless log, and inspect plugin logs. | Schema validation and immediate/reload behavior match the contract; secrets are not exposed. |
| Updates and source tracking | Inspect outdated/source, update the fixture to a new compatible version, then compare history. | Version/source identity and compatibility rules hold; a failed update does not falsely report success. |
| Marketplaces | Add a disposable marketplace, refresh/list, inspect catalog additions, and remove it. | Catalog membership and errors match the selected source; removing a catalog does not silently uninstall unrelated plugins. |
| Scaffold, build, types, dev, migration | Use plugin new/types/build/dev/migrate on a temporary plugin and open its surface. | Generated SDK types resolve; build/dev reload uses the fixture; migration changes are reviewable and actual surface works. |
| Plugin run and token | Invoke a harmless fixture command with plugin run; create a token only for a disposable integration and verify its scope without printing it. | Command argument/result boundary is correct; tokens cannot act outside their intended authority. |
| Plugin panel routes and mention/action slots | Load each plugin panel deep link and its palette/composer actions using the per-plugin recipes. | Disabled/missing plugin fallback is explicit; route params and selected context reach the owning plugin. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.

## Maintenance notes

- Use the isolated BB data directory for BB-user skills and disposable project .bb/.claude/.agents locations for scope tests. Provider-global skill paths still refer to real host directories; a source store does not isolate them. Source: `apps/server/src/services/skills/registry-skill-install.ts:309`.
- Skill Edit opens a new chat composer with skill ID/path and revision-aware CLI instructions. Complete an edit through that chat or bb skill update; do not expect an inline text editor. Delete has a cancelable confirmation. Source: `packages/shared-ui/src/components/ui/resource-edit-prompt.ts:15`.
- Source dev app version 0.0.0 deliberately skips engines.bb checks. For a live incompatibility test here, use an impossible engines.bbPluginSdk requirement; assert incompatible runtime status and absence of factory execution. Registration may succeed while activation is incompatible. Source: `apps/server/src/services/plugins/plugin-runtime.ts:750`.
- Use plugin update <id> --yes for unattended managed updates. This revision does not accept --json on plugin update. Local path plugins are pinned; rebuild/reload them. Use a managed disposable Git source to test update history and compatibility. Source: `apps/cli/src/commands/plugin.ts:1094`.
- Run scaffolding with a wrapper that applies isolated source environment, clears BB_CLI/BB_CLI_REEXEC, changes to an owned temporary directory, then executes the absolute built source CLI path. A repo-root wrapper can otherwise scaffold inside the checkout. Source: `apps/cli/src/commands/plugin.ts:1181`.
- For a token-auth fixture HTTP route, send the plugin token as x-bb-plugin-token (or supported token query parameter). Do not assume an Authorization Bearer header; capture token only in memory and redact logs. Source: `apps/server/src/routes/plugins.ts:156`.
