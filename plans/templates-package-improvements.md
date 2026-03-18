# Goal

Make `packages/templates` a robust, low-friction system for managing bb's growing template library. Templates should compose naturally, types should be generated (not manually maintained), and mistakes should be caught at build time.

# Scope

In scope:

- Auto-generate `TemplateVariables` interface from frontmatter (eliminate manual registry.ts maintenance)
- Validate template body references match declared variables
- Native Handlebars partials for sub-template composition
- Simplify consumer call sites (e.g., `manager-thread.ts`)
- Better tests

Out of scope:

- Changing the template file format (keep markdown with YAML frontmatter)
- Template preview CLI (nice to have later, not blocking)
- Runtime template loading (templates are build-time only)

# Implementation Steps

## 1. Auto-generate `TemplateVariables` from frontmatter

Currently `registry.ts` has a manually maintained `TemplateVariables` interface that must stay in sync with the `variables` frontmatter in each `.md` file. This is the biggest maintenance burden — every new variable requires editing two files.

**Change:** Have `generate-templates.mjs` emit the `TemplateVariables` interface directly into `templates.generated.ts`.

The frontmatter already declares variables:
```yaml
variables:
  managerWorkspacePath: Absolute path to the manager's durable workspace directory.
  managerPreferencesContent: Current contents of PREFERENCES.md, or a marker when it does not exist.
```

The generator can emit:
```typescript
export interface TemplateVariables {
  managerAgentInstructions: {
    managerWorkspacePath: string;
    managerPreferencesContent: string;
  };
  bbCliGuide: Record<string, never>;
  // ...
}
```

All variables are `string` type (Handlebars is string-only). Templates with no variables get `Record<string, never>`.

**Also generate:** `TemplateId` type as `keyof TemplateVariables`.

**Then:** `registry.ts` becomes a thin file that imports and re-exports from generated code, plus the runtime `templateRegistry` map. The manual `TemplateVariables` interface is deleted.

## 2. Validate template body references match declared variables

Add a build-time check in `generate-templates.mjs` that:

1. Parses all `{{variableName}}` and `{{{variableName}}}` references from the template body (excluding `{{#if ...}}`, `{{> ...}}`, etc.)
2. Compares against the declared `variables` in frontmatter
3. Errors if a template body references a variable not declared in frontmatter
4. Warns if frontmatter declares a variable not referenced in the body

This catches the "added a variable to the template but forgot to declare it" bug at build time instead of silently rendering empty.

**Edge cases:**
- `{{#if variableName}}` — the variable name inside conditionals counts as a reference
- `{{> partialName}}` — partial references are not variables (handled separately)
- Nested paths like `{{foo.bar}}` — not used today, ignore for now

## 3. Native Handlebars partials for sub-template composition

Currently sub-templates are rendered in TypeScript and passed as triple-brace variables:

```typescript
// manager-thread.ts — current approach
const bbSystemOverview = renderTemplate("bbSystemOverview", {});
const bbCliGuide = renderTemplate("bbCliGuide", {});
const bbManagerWorkflows = renderTemplate("bbManagerWorkflows", {});

return renderTemplate("managerAgentInstructions", {
  bbSystemOverview,
  bbCliGuide,
  bbManagerWorkflows,
  // ... other variables
});
```

And in the template:
```handlebars
{{{bbCliGuide}}}
```

**Change:** Register every template as a Handlebars partial at compile time. Then templates can reference each other directly:

```handlebars
{{> bbCliGuide}}
```

**Implementation in `render-template.ts`:**
```typescript
// Register all templates as partials on first use
let partialsRegistered = false;
function ensurePartialsRegistered() {
  if (partialsRegistered) return;
  for (const [id, definition] of Object.entries(templateRegistry)) {
    Handlebars.registerPartial(id, definition.body);
  }
  partialsRegistered = true;
}
```

**Frontmatter change:** Add an optional `partials` field to declare which partials a template uses:
```yaml
partials:
  - bbSystemOverview
  - bbCliGuide
  - bbManagerWorkflows
```

This is for documentation and validation — the generator can verify that referenced partials actually exist.

**Impact on consumers:** `manager-thread.ts` no longer needs to render sub-templates separately. It just renders `managerAgentInstructions` with the leaf variables (workspace path, preferences, etc.). The partials resolve automatically.

```typescript
// manager-thread.ts — new approach
return renderTemplate("managerAgentInstructions", {
  managerPreferencesContent: MANAGER_PREFERENCES_CONTENT_PLACEHOLDER,
  managerThreadId: MANAGER_THREAD_ID_PLACEHOLDER,
  managerWorkspacePath: MANAGER_WORKSPACE_PATH_PLACEHOLDER,
  projectId: PROJECT_ID_PLACEHOLDER,
  projectName: PROJECT_NAME_PLACEHOLDER,
  projectRootPath: PROJECT_ROOT_PATH_PLACEHOLDER,
});
```

The empty-string guards for sub-templates become unnecessary — if a partial is missing, Handlebars throws at compile time.

**Template variable cleanup:** The `bbSystemOverview`, `bbCliGuide`, and `bbManagerWorkflows` variables are removed from `managerAgentInstructions`'s frontmatter since they're now partials, not variables.

## 4. Support a standalone render for `bb guide`

With partials in place, `bb guide` can render a lightweight template that just composes the partials:

```markdown
---
kind: prompt
title: bb Guide
variables: {}
partials:
  - bbSystemOverview
  - bbCliGuide
---

{{> bbSystemOverview}}

---

{{> bbCliGuide}}
```

Or we just render the two templates separately in the `guide` command — simpler, no new template needed.

## 5. Update tests

- Test that every template renders without error (current test already does this for one template — extend to all)
- Test that partial resolution works (render `managerAgentInstructions` and verify it contains content from sub-templates)
- Test that the variable validation catches undeclared variables
- Test that `TemplateVariables` matches the generated output (this is automatic if we generate the types)

# Validation

- `pnpm exec turbo run typecheck --filter=@bb/templates` — generated types must compile
- `pnpm exec turbo run test --filter=@bb/templates` — all template tests pass
- `pnpm exec turbo run typecheck --filter=@bb/server` — consumers of templates still compile
- Verify `manager-thread.ts` is simpler after the partials change
- Verify `bb guide` (once implemented) renders correct content

# Open Questions/Risks

- Should the variable validation be an error or a warning? Error is safer but might be annoying during development. Start with error — it's a build step, not a runtime check.
- Should partials support variables? E.g., `{{> bbCliGuide someVar="value"}}`. Handlebars supports this but we don't need it today. Keep it simple — partials are just includes.
- Should we support optional variables (with `?` in frontmatter)? The `{{#if}}` pattern already handles this — if a variable is optional, the template wraps it in a conditional. The type should still be `string` (not `string | undefined`) and the caller passes empty string for absent values. Actually, for `{{#if}}` to work correctly, optional variables should be typed as `string | undefined` or `string` — Handlebars treats empty string as falsy. Need to think about this.
