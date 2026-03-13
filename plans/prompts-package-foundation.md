# Goal

Create a simple `@beanbag/templates` package that stores prompt and instruction text in dedicated template files with frontmatter, preserves the current caller ergonomics, and gives future editors enough embedded context to refine templates without losing their intent.

# Scope

In scope:

- Add a new workspace package, `packages/templates`, that can load and render checked-in template files.
- Support prompt source files that are easy to review and edit, using Markdown with frontmatter and Handlebars-style interpolation for dynamic sections.
- Migrate the current prompt-producing code paths to use the new package without forcing broad call-site changes.
- Expose prompt metadata so editors and tooling can inspect prompt intent, summary, editing notes, and variable descriptions.
- Validate that the existing prompt builders still produce the same or materially equivalent output.

Out of scope for the first pass:

- Building a full prompt CMS or dynamic runtime prompt editor.
- Auto-discovery of arbitrary prompt files without a registry.
- Migrating every possible instruction-like string in one sweep if some are better deferred to a second pass.
- Shipping manager-mode or BB CLI skill templates as active runtime features unless they are needed as examples or draft assets.

# Implementation Steps

1. Add a new `packages/templates` workspace package.
   - Export a small API such as `renderTemplate`, `getTemplateMetadata`, and `listTemplates`.
   - Keep the caller-facing API focused on known internal templates rather than permissive string ids.
   - Use an `esbuild`-driven build step to compile template assets into JavaScript so packed consumers do not need runtime filesystem reads or copied template files.

2. Define a prompt file convention.
   - Store template files under `packages/templates/src/templates/`.
   - Use Markdown files with frontmatter for `title`, `summary`, `intent`, `editingNotes`, and variable documentation.
   - Add a lightweight `kind` field in frontmatter so the package can hold both prompts and nearby instruction-like templates without overloading the package name.
   - Use Handlebars-compatible placeholders for dynamic content so templates remain readable in review.

3. Implement a small typed template registry.
   - Keep a typed mapping from template ids to file names and expected variables.
   - Avoid permissive stringly-typed access for known internal prompts.
   - Generate the registry at build time from the Markdown files instead of parsing them at runtime.
   - Bundle the generated registry with `esbuild`, following the same broad pattern used in Terragon for deployment-friendly bundled assets, but adapted for structured template metadata rather than raw copied text files.

4. Implement build-time code generation for template assets.
   - Add a build script that scans the template directory, parses frontmatter and body, and emits a generated TypeScript module with the normalized metadata and raw template strings.
   - Compile that generated module with `esbuild` so the final package has no runtime path manipulation and no asset-copying build step.
   - Keep the generated module internal to the package so callers only depend on the stable helper API.

5. Migrate the existing prompt builders behind their current APIs.
   - `packages/agent-core/src/thread-operation-prompts.ts`
   - `packages/agent-server/src/codex-commit-message-generator.ts`
   - `packages/agent-server/src/codex-title-generator.ts`
   - `packages/agent-server/src/codex-provider-adapter.ts`
   - `packages/agent-server/src/openai-responses-model.ts`
   - `packages/environment/src/worktree-environment.ts`
   - `packages/environment/src/docker-environment.ts`
   - Keep current exported function names and call patterns stable so downstream callers continue to “use these prompts as they do today.”

6. Add tests for the new package and migration points.
   - Unit-test template loading, metadata parsing, and rendering.
   - Preserve or extend existing tests around thread operation prompts, commit-message generation, and title generation.
   - Add alias/test config updates so workspace tests can import `@beanbag/templates`.

7. Decide how to seed future prompt-like assets.
   - Either add draft template files now for “manager mode” and “BB CLI skill” as non-runtime examples, or document the convention and leave those for a follow-up.
   - Prefer not to wire unused prompts into runtime code until there is a concrete caller.

# Validation

- Run `pnpm install` if new package dependencies are added and ensure the lockfile is updated.
- Run `pnpm exec turbo run typecheck --filter=@beanbag/templates`.
- Run `pnpm exec turbo run test --filter=@beanbag/templates`.
- Run `pnpm exec turbo run typecheck --filter=@beanbag/agent-core`.
- Run `pnpm exec turbo run test --filter=@beanbag/agent-core`.
- Run `pnpm exec turbo run typecheck --filter=@beanbag/agent-server`.
- Run `pnpm exec turbo run test --filter=@beanbag/agent-server`.
- Run `pnpm exec turbo run typecheck --filter=@beanbag/environment`.
- If migration changes daemon-facing prompt behavior materially, run the relevant daemon unit tests that cover prompt composition paths.

# Open Questions/Risks

- Build-pipeline risk: the codegen plus `esbuild` flow must stay simple enough that template edits are easy to validate locally and in CI.
- Output stability risk: even small whitespace or phrasing changes may affect tests or downstream agent behavior; the first migration should aim for near-identical rendered output.
- Registry maintenance risk: a typed registry is safer than file auto-discovery for internal prompts, but it does add one extra place to update when adding a prompt.
- Build-tooling risk: esbuild works well for bundling generated modules, but the repo currently defaults many packages to `tsc`; we need to keep this package’s build isolated and unsurprising.
- Future template taxonomy risk: prompts, skills, and long-form agent instructions overlap conceptually, so the package should stay narrowly scoped to reusable templates with explicit `kind` metadata rather than becoming a catch-all document store.
