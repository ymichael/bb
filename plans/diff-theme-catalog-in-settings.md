# Goal
Ship a high-quality, user-selectable list of diff/syntax themes in App Settings, with strong visual quality, predictable performance, and safe migration from current preferences.

# Scope
In scope:
- Add a curated theme catalog users can choose from in Settings.
- Support both light and dark variants per catalog entry.
- Persist selection and apply it consistently across all diff surfaces (including worker-rendered diffs).
- Keep a clear fallback path when a theme fails to load.
- Ensure accessibility and readability (especially for additions/deletions and low-contrast token classes).

Out of scope:
- Building a community marketplace or arbitrary user-uploaded themes.
- Per-language token customization UI.
- Redesigning unrelated settings surfaces.

# Implementation Steps
1. Define a typed theme catalog contract.
- Create a `ThemeCatalogEntry` model with stable `id`, display metadata, tags, and light/dark theme references.
- Keep IDs as a closed internal union to allow exhaustive handling and safe migrations.
- Add a decode/guard layer for any external/raw theme metadata.

2. Introduce a dedicated theme-catalog package.
- Add a standalone package (for example `@beanbag/diff-theme-catalog`) containing:
  - curated catalog manifest,
  - theme loaders,
  - shared metadata and utility guards.
- Keep app-facing API small and versioned (query list, load theme by id, default theme id).

3. Implement bundle-aware theme loading.
- Split theme payloads by entry using dynamic imports so default app startup does not include all theme definitions.
- Keep a small built-in fallback theme set always available.
- Cache loaded themes in-memory for fast subsequent switches.

4. Extend preference model and migration.
- Replace single binary preference with:
  - `colorMode` (`monochromatic` or `colorful`), and
  - `themeId` (catalog key).
- Add migration for existing stored values to deterministic defaults.
- Keep tolerant fallback only for unknown external/localStorage values.

5. Apply selection across all diff renderers.
- Centralize theme resolution in one hook/service used by:
  - inline message diffs,
  - thread git-diff panel,
  - worker pool render options sync.
- Ensure theme updates are reactive and synchronized between main thread and worker pool.

6. Build a high-quality Settings UX.
- Add a searchable/selectable theme picker with clear labels and small previews.
- Show which themes are optimized for light/dark or grayscale-heavy apps.
- Keep current `monochromatic` vs `colorful` toggle, but make it an explicit filter/intent in the picker flow.

7. Add quality gates.
- Add unit tests for preference parsing/migrations and catalog lookups.
- Add integration tests validating that theme change updates all diff surfaces.
- Add visual regression snapshots for representative code diffs in light/dark.

# Validation
- Functional:
  - Theme selection persists across reload.
  - Theme changes apply to all diff surfaces without manual refresh.
  - Invalid stored values fall back to defaults without crashes.
- Visual:
  - Added/deleted lines remain visually distinguishable in each curated theme.
  - Token readability passes internal contrast checks on both light and dark backgrounds.
- Performance:
  - No meaningful regression to initial app load from adding catalog entries.
  - Theme switch latency remains acceptable after first load and near-instant from cache.

# Open Questions/Risks
- Catalog size vs maintenance: how many themes can be curated and quality-checked per release?
- Source of truth: do we vendor normalized theme JSON in-repo or fetch/update from upstream sources?
- Accessibility bar: define minimum contrast thresholds for token classes and diff backgrounds.
- Preview strategy: static thumbnail previews vs live rendered sample (tradeoff between fidelity and complexity).
- Telemetry: whether to capture anonymous theme usage to guide curation decisions.
