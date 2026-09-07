# BB verification feature map

This map inventories the features discoverable in this checkout across the
core app, CLI/SDK, all 28 repository plugins, native clients and hosted services.
Each group page has separate recipes with a drive action, observable success,
source entry points and prerequisites. Shared behaviors can appear in more than
one recipe because provider/platform behavior needs separate verification.

**Documentation coverage and test results are separate.** The 2026-09-05
maintenance audit assessed all 348 recipes: **166 passed, 177 partial/blocked,
and 5 failed**. Another 27 macOS assessments overlap these recipes; iOS variants
were excluded. See the [audit](../MAINTENANCE.md) and
[per-recipe ledger](../validation-2026-09-05.json).

## Starting a run

1. Run the source inventory check from [SKILL.md](../SKILL.md). Inspect any drift
   before choosing coverage; [INVENTORY.md](../INVENTORY.md) links declarations
   and source groups to their recipe owners.
2. Select the changed capabilities plus their shared/provider/platform recipes.
   For a whole-product audit, make one result entry per recipe and platform.
3. Follow the main isolated launch/doctor rules and the selected page’s extra
   setup. Record actual entry point, source commit, result, evidence and cleanup.
4. Keep `not run` distinct from `blocked` (an attempted check missing a concrete
   prerequisite), and both distinct from a pass. Do not omit unavailable features.

## Previously executed smoke journeys

| Feature group | Recipes | Verification status |
| --- | --- | --- |
| [Add a local project](local-project.md) | 1 | 1 passed |
| [Run and organize a thread](thread-lifecycle.md) | 1 | 1 passed |
| [Persist appearance choices](appearance.md) | 1 | 1 passed |
| [Use a compact persistent menu](compact-menu.md) | 1 | 1 passed |

## Core app and shared behavior

| Feature group | Recipes | Verification status |
| --- | --- | --- |
| [Navigation, search, and thread organization](navigation.md) | 11 | 6 passed, 5 partial/blocked |
| [Projects, sources, environments, and Git](projects-environments.md) | 15 | 4 passed, 1 failed, 10 partial/blocked |
| [Compose, mentions, attachments, and voice](composer.md) | 12 | 6 passed, 6 partial/blocked |
| [Active turns, queues, plans, goals, and recovery](execution-controls.md) | 14 | 3 passed, 11 partial/blocked |
| [Approvals, questions, and permission escalation](interactions.md) | 7 | 2 passed, 5 partial/blocked |
| [Conversation history, message actions, and rendered output](timeline.md) | 12 | 1 passed, 1 failed, 10 partial/blocked |
| [Panels, files, terminals, splits, and embedded browser](workspace-panels.md) | 15 | 12 passed, 3 partial/blocked |
| [Settings, keyboard, appearance controls, and usage](settings.md) | 13 | 6 passed, 7 partial/blocked |
| [Skills, plugins, marketplaces, and plugin development](extensions.md) | 13 | 11 passed, 2 partial/blocked |
| [Machines, daemon lifecycle, and updates](hosts-updates.md) | 8 | 2 passed, 6 partial/blocked |
| [Agent interfaces, route compatibility, and error contracts](compatibility-api.md) | 8 | 3 passed, 5 partial/blocked |
| [Responsive layouts, accessibility, and performance](responsive-accessibility.md) | 8 | 8 partial/blocked |

## Repository plugins

| Feature group | Recipes | Verification status |
| --- | --- | --- |
| [Account pooling](plugin-account-pool.md) | 7 | 7 partial/blocked |
| [Fallback question cards](plugin-ask-user-question.md) | 5 | 3 passed, 1 failed, 1 partial/blocked |
| [Scheduled agent and script automations](plugin-automations.md) | 8 | 8 passed |
| [Agent concurrency limits](plugin-concurrency-limit.md) | 5 | 4 passed, 1 partial/blocked |
| [Remote Connect and port sharing](plugin-connect.md) | 7 | 5 passed, 2 partial/blocked |
| [Custom agent instructions](plugin-custom-instructions.md) | 3 | 2 passed, 1 partial/blocked |
| [Docs vaults and editing](plugin-docs.md) | 9 | 7 passed, 2 partial/blocked |
| [GitHub issues and pull requests](plugin-github.md) | 8 | 2 passed, 6 partial/blocked |
| [Inline HTML visualizations](plugin-inline-vis.md) | 5 | 5 passed |
| [Keep machines awake](plugin-keep-awake.md) | 4 | 4 passed |
| [Persistent agent memory](plugin-memory.md) | 6 | 6 passed |
| [Code editor and file tree](plugin-monaco-editor.md) | 6 | 3 passed, 1 failed, 2 partial/blocked |
| [PDF preview](plugin-pdf-preview.md) | 3 | 2 passed, 1 partial/blocked |
| [Plugin Guide](plugin-plugin-api-docs.md) | 4 | 3 passed, 1 partial/blocked |
| [Plugin API tester](plugin-plugin-api-tester.md) | 2 | 2 passed |
| [ACP providers](plugin-provider-acp.md) | 6 | 2 passed, 4 partial/blocked |
| [Claude Code provider](plugin-provider-claude-code.md) | 7 | 2 passed, 5 partial/blocked |
| [Codex provider](plugin-provider-codex.md) | 7 | 1 passed, 6 partial/blocked |
| [Pi provider](plugin-provider-pi.md) | 5 | 2 passed, 3 partial/blocked |
| [Automatic provider retry](plugin-provider-retry.md) | 5 | 5 partial/blocked |
| [Provider usage limits](plugin-provider-usage.md) | 3 | 2 passed, 1 partial/blocked |
| [Web, desktop, and mobile notifications](plugin-push-notifications.md) | 6 | 1 passed, 5 partial/blocked |
| [Scheduled messages](plugin-scheduled-send.md) | 5 | 2 passed, 3 partial/blocked |
| [Secure credential requests](plugin-secrets.md) | 5 | 4 passed, 1 partial/blocked |
| [Side chats](plugin-side-chat.md) | 4 | 3 passed, 1 partial/blocked |
| [Tasks, boards, and delegation](plugin-tasks.md) | 13 | 11 passed, 2 partial/blocked |
| [Theme preview workbench](plugin-theme-preview.md) | 4 | 3 passed, 1 failed |
| [Durable workflows](plugin-workflows.md) | 8 | 6 passed, 2 partial/blocked |

## Platform and support surfaces

| Feature group | Recipes | Verification status |
| --- | --- | --- |
| [Desktop application](desktop.md) | 12 | 12 partial/blocked |
| [Native mobile shell](mobile.md) | 12 | 12 partial/blocked |
| [Hosted website, dashboard, and marketplace](hosted-web.md) | 12 | 5 passed, 7 partial/blocked |
| [Cloud gateway and tunnel behavior](cloud-gateway.md) | 7 | 4 passed, 3 partial/blocked |
| [Developer tools, fixtures, and scope boundaries](developer-fixtures.md) | 5 | 2 passed, 3 partial/blocked |

## Scope reconciliation

- **Compatibility:** legacy app routes and removed manager commands are
  tracked in compatibility-api; they are not additional modern product features.
- **Developer-only:** demo server, dev launchers, Plugin API tester, Guide, theme
  workbench and gated mobile diagnostics are explicitly mapped.
- **Native wrappers:** repeat core web recipes in Electron and the mobile WebView,
  then run native-only recipes. Chromium emulation does not verify Safari/iOS.
- **Third-party plugins:** code absent from this checkout cannot be enumerated
  from repository source. List installed extras during doctor and add their own
  recipes when auditing that installation.
- **Mechanical completeness:** every discovered CLI family and repository plugin
  has an owner; route/API declarations and broader source fingerprints are
  tracked. This detects drift, but a human/source review still has to identify
  capabilities hidden behind dynamic registrations and behavior changes.

The map should grow with the product. Do not restore a fixed starter count or
drop a feature merely because it is difficult to automate.
